package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

var requiredGateIDs = []string{"G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"}

var gateNames = []string{
	"Reproducibility", "Static correctness", "Hard policy", "Offline value", "Robustness / OOD",
	"Live fidelity", "Reliability / trajectory", "Cost / latency / capacity", "Shadow / canary", "Online preference",
}

var gateTracks = []TrackID{"", "", "safety", "joint", "routing", "joint", "agentic", "capacity", "", "preference"}

var gateEvidenceRefs = [][]string{
	{manifestFileName, "lineage.json", "provenance.json", publicChecksumArtifactName},
	{manifestFileName, "records.jsonl"},
	{"records.jsonl", "metric:safety.violation_rate"},
	{"metrics.json", "metric:joint.normalized_regret"},
	{"records.jsonl", "metric:routing.accuracy"},
	{"records.jsonl", "provenance.json"},
	{"records.jsonl", "metric:agentic.success_rate"},
	{"records.jsonl", "metrics.json"},
	{manifestFileName, "records.jsonl"},
	{"records.jsonl", "metric:preference.propensity_coverage"},
}

var gateDispositionMatrix = map[ChangeProfile][]string{
	"schema_adapter":    {"required", "required", "advisory", "advisory", "required", "advisory", "not_applicable", "advisory", "not_applicable", "not_applicable"},
	"recipe":            {"required", "required", "required", "required", "required", "required", "not_applicable", "required", "advisory", "not_applicable"},
	"selector":          {"required", "required", "required", "required", "required", "required", "advisory", "required", "required", "not_applicable"},
	"model_pool":        {"required", "required", "required", "required", "required", "required", "advisory", "required", "required", "not_applicable"},
	"runtime_capacity":  {"required", "required", "required", "advisory", "advisory", "required", "advisory", "required", "required", "not_applicable"},
	"agent_multimodal":  {"required", "required", "required", "required", "required", "required", "required", "required", "required", "advisory"},
	"online_adaptation": {"required", "required", "required", "required", "required", "required", "required", "required", "required", "required"},
}

func (s *Service) validateAndAnchorReport(runID string) error {
	run, err := s.store.GetRun(runID)
	if err != nil {
		return err
	}
	if run.Status != StatusRunning {
		return fmt.Errorf("%w: only a running evaluation can seal a report", ErrConflict)
	}
	data, err := s.store.ReadReport(runID)
	if err != nil {
		return err
	}
	if secretErr := s.rejectConfiguredSecretBytes(data); secretErr != nil {
		return secretErr
	}
	report, err := decodeReportStrict(runID, data)
	if err != nil {
		return err
	}
	if report.Run.Status != StatusCompleted || report.Run.Error != "" {
		return fmt.Errorf("%w: worker report must describe a successful completed run", ErrInvalid)
	}
	if report.AttestationRevision != "" {
		return fmt.Errorf("%w: worker report cannot claim a server-owned attestation revision", ErrInvalid)
	}
	manifest, manifestBytes, err := s.readDurableManifest(runID)
	if err != nil {
		return err
	}
	checksums, err := s.validatePrivateReceipt(runID)
	if err != nil {
		return err
	}
	if bundleErr := s.validateReportBundle(runID, manifest, report, checksums); bundleErr != nil {
		return bundleErr
	}
	completedAt := time.Now().UTC()
	canonicalizeReportRun(run, &report, completedAt)
	run.CompletedAt = &completedAt
	if frozenFieldsErr := validateReportFrozenFields(run, manifest, report); frozenFieldsErr != nil {
		return frozenFieldsErr
	}
	canonicalData, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("encode canonical evaluation report: %w", err)
	}
	if secretErr := s.rejectConfiguredSecretBytes(canonicalData); secretErr != nil {
		return secretErr
	}
	evidenceFiles, err := s.buildSealedEvidenceSnapshot(runID, checksums)
	if err != nil {
		return err
	}
	manifestDigest, _ := digestAndSize(manifestBytes)
	privateReceipt, err := readEvidenceBytes(filepath.Join(s.store.runsRoot, runID, privateChecksumArtifactName), maxStructuredArtifactBytes)
	if err != nil {
		return err
	}
	privateReceiptDigest, _ := digestAndSize(privateReceipt)
	sealedAt := time.Now().UTC()
	if timestampErr := validateReportExecutionTimestamp(run, manifest, report.Provenance.GeneratedAt, sealedAt); timestampErr != nil {
		return timestampErr
	}
	// The revision is exclusively server-owned and is published only after all
	// worker bundle and canonical report validators have succeeded.
	report.AttestationRevision = ServerAttestationRevision
	if writeErr := s.store.WriteReport(runID, report); writeErr != nil {
		return writeErr
	}
	data, err = s.store.ReadReport(runID)
	if err != nil {
		return err
	}
	reportDigest, reportSize := digestAndSize(data)
	if err := s.store.writeReportAnchor(runID, reportAnchor{
		SchemaVersion: SchemaVersion, AttestationRevision: ServerAttestationRevision,
		RunID: runID, ReportDigest: reportDigest,
		ReportSize: reportSize, ManifestDigest: manifestDigest, PrivateReceiptDigest: privateReceiptDigest,
		EvidenceFiles: evidenceFiles, CreatedAt: sealedAt,
	}); err != nil {
		return err
	}
	return s.store.UpdateRun(run)
}

func validateReportExecutionTimestamp(run Run, manifest RunManifest, generatedAt, sealedAt time.Time) error {
	if run.StartedAt == nil || generatedAt.IsZero() || generatedAt.After(sealedAt) {
		return fmt.Errorf("%w: report provenance timestamp is outside the server-owned execution window", ErrInvalid)
	}
	// Replay evidence may be deterministically timestamped at manifest creation;
	// it makes no claim about a live observation window. Live evidence must be
	// generated after the server transitions the run to running.
	if manifest.Mode == ModeReplay {
		if generatedAt.Before(manifest.CreatedAt) {
			return fmt.Errorf("%w: replay report provenance predates the immutable manifest", ErrInvalid)
		}
		return nil
	}
	if manifest.Mode != ModeLive || generatedAt.Before(run.StartedAt.UTC()) {
		return fmt.Errorf("%w: report provenance timestamp is outside the server-owned execution window", ErrInvalid)
	}
	return nil
}

func (s *Service) readDurableManifest(runID string) (RunManifest, []byte, error) {
	path, err := s.store.ManifestPath(runID)
	if err != nil {
		return RunManifest{}, nil, err
	}
	manifest, raw, err := readRunManifestStrict(path)
	if err != nil {
		return RunManifest{}, nil, fmt.Errorf("%w: durable run manifest is invalid: %w", ErrInvalid, err)
	}
	if manifest.RunID != runID {
		return RunManifest{}, nil, fmt.Errorf("%w: run manifest identity mismatch", ErrInvalid)
	}
	return manifest, raw, nil
}

func validateReportFrozenFields(run Run, manifest RunManifest, report Report) error {
	if report.Run.Status != StatusCompleted || report.Run.Error != "" {
		return fmt.Errorf("%w: worker report must describe a successful completed run", ErrInvalid)
	}
	checks := []struct {
		name string
		ok   bool
	}{
		{"identity", run.ID == manifest.RunID && report.Run.ID == run.ID},
		{"name", reportRunNameMatches(run, report.Run)},
		{"description", reportRunDescriptionMatches(run, report.Run)},
		{"client_request_id", reportRunClientRequestIDMatches(run, report.Run)},
		{"mode", run.Mode == manifest.Mode && report.Run.Mode == run.Mode},
		{"target", run.TargetID == manifest.Target.ID && report.Run.TargetID == run.TargetID},
		{"change_profile", run.ChangeProfile == manifest.ChangeProfile && report.Run.ChangeProfile == run.ChangeProfile},
		{"sample_limit", run.SampleLimit == manifest.SampleLimit && report.Run.SampleLimit == run.SampleLimit},
		{"concurrency", run.Concurrency == manifest.Concurrency && report.Run.Concurrency == run.Concurrency},
		{"seed", run.Seed == manifest.Seed && report.Run.Seed == run.Seed},
		{"baseline", run.BaselineRunID == manifest.BaselineRunID && report.Run.BaselineRunID == run.BaselineRunID},
		{"evidence_level", run.EvidenceLevel == report.Run.EvidenceLevel},
		{"suites", reflect.DeepEqual(run.SuiteIDs, manifest.SuiteIDs) && reflect.DeepEqual(report.Run.SuiteIDs, run.SuiteIDs)},
		{"tracks", reflect.DeepEqual(run.TrackIDs, manifest.TrackIDs) && reflect.DeepEqual(report.Run.TrackIDs, run.TrackIDs)},
		{"created_at", run.CreatedAt.Equal(manifest.CreatedAt) && report.Run.CreatedAt.Equal(run.CreatedAt.Truncate(time.Microsecond))},
		{"execution_times", reportRunTimesMatch(run, report.Run)},
	}
	for _, check := range checks {
		if !check.ok {
			if check.name == "created_at" {
				return fmt.Errorf("%w: report created_at does not match the durable run manifest (run=%s manifest=%s report=%s)",
					ErrInvalid, run.CreatedAt.Format(time.RFC3339Nano), manifest.CreatedAt.Format(time.RFC3339Nano), report.Run.CreatedAt.Format(time.RFC3339Nano))
			}
			return fmt.Errorf("%w: report %s does not match the durable run manifest", ErrInvalid, check.name)
		}
	}
	if report.Provenance.CodeRevision != manifest.CodeRevision ||
		report.Provenance.TargetID != manifest.Target.ID || report.Provenance.Seed != manifest.Seed ||
		report.Provenance.RedactionPolicy != manifest.RedactionPolicy {
		return fmt.Errorf("%w: report provenance does not match the durable run manifest", ErrInvalid)
	}
	if manifest.GateContractVersion != GateContractVersion ||
		!validSuiteRevisionSnapshot(manifest.SuiteIDs, manifest.SuiteRevisions) ||
		!reflect.DeepEqual(report.Provenance.BenchmarkRevisions, manifest.SuiteRevisions) {
		return fmt.Errorf("%w: report benchmark or gate contract revisions do not match the durable manifest", ErrInvalid)
	}
	return nil
}

func (s *Service) validateReportBundle(runID string, manifest RunManifest, report Report, checksums map[string]string) error {
	runDir, err := s.store.checkedRunDir(runID)
	if err != nil {
		return err
	}
	records, err := validateRecordsAndFailureSummary(runDir, manifest)
	if err != nil {
		return err
	}
	if err := validateReportMetricsAndGates(runDir, report, records); err != nil {
		return err
	}
	if err := validateReportGateEvidence(report, checksums); err != nil {
		return err
	}
	if err := s.validatePublicArtifacts(runID, manifest, report, checksums, records); err != nil {
		return err
	}
	if err := validateCapacityProfileArtifact(runDir, manifest, report, records); err != nil {
		return err
	}
	return validateReportProvenance(runDir, manifest, report, checksums)
}

func validateReportMetricsAndGates(runDir string, report Report, records recordAttestation) error {
	var metricFile struct {
		SchemaVersion string   `json:"schema_version"`
		Metrics       []Metric `json:"metrics"`
	}
	if err := decodeStrictEvidence(filepath.Join(runDir, "metrics.json"), &metricFile); err != nil {
		return err
	}
	var gateFile struct {
		SchemaVersion string `json:"schema_version"`
		Gates         []Gate `json:"gates"`
	}
	if err := decodeStrictEvidence(filepath.Join(runDir, "gates.json"), &gateFile); err != nil {
		return err
	}
	if metricFile.SchemaVersion != SchemaVersion || gateFile.SchemaVersion != SchemaVersion ||
		!reflect.DeepEqual(metricFile.Metrics, report.Metrics) || !reflect.DeepEqual(gateFile.Gates, report.Gates) {
		return fmt.Errorf("%w: report metrics or gates do not match their verified evidence files", ErrInvalid)
	}
	if len(report.Gates) != len(requiredGateIDs) {
		return fmt.Errorf("%w: report must contain the complete G0-G9 gate set", ErrInvalid)
	}
	if err := validateReportMetrics(report.Metrics, report.Run.TrackIDs); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if err := validateWorkerSingleRunMetricOwnership(report.Metrics); err != nil {
		return err
	}
	if err := validateServerReducedMetrics(report, records.Metrics); err != nil {
		return err
	}
	if err := validateServerReducedCosts(report.Costs, records.Costs); err != nil {
		return err
	}
	passed, failed, unavailable := 0, 0, 0
	dispositions := gateDispositionMatrix[report.Run.ChangeProfile]
	requiredVerdict := GateVerdict("pass")
	for index, gate := range report.Gates {
		if gate.ID != requiredGateIDs[index] || gate.Name != gateNames[index] || gate.TrackID != gateTracks[index] ||
			gate.Disposition != dispositions[index] || !reflect.DeepEqual(gate.EvidenceRefs, gateEvidenceRefs[index]) ||
			gate.Owner == "" || gate.EvaluatedAt == nil || gate.SampleCount == nil || gate.Coverage == nil {
			return fmt.Errorf("%w: report gate order must be canonical G0-G9", ErrInvalid)
		}
		if gate.Disposition == "not_applicable" {
			if gate.Verdict != "not_applicable" {
				return fmt.Errorf("%w: not-applicable gate %s has an invalid verdict", ErrInvalid, gate.ID)
			}
		} else if gate.Verdict != "pass" && gate.Verdict != "fail" && gate.Verdict != "unavailable" {
			return fmt.Errorf("%w: applicable gate %s has an invalid verdict", ErrInvalid, gate.ID)
		}
		if gate.Disposition == "required" {
			if gate.Verdict == "fail" {
				requiredVerdict = "fail"
			} else if gate.Verdict == "unavailable" && requiredVerdict != "fail" {
				requiredVerdict = "unavailable"
			}
		}
		switch gate.Verdict {
		case "pass":
			passed++
		case "fail":
			failed++
		case "unavailable":
			unavailable++
		}
	}
	if report.Summary.PassedGates != passed || report.Summary.FailedGates != failed || report.Summary.UnavailableGates != unavailable {
		return fmt.Errorf("%w: report summary gate counts are inconsistent", ErrInvalid)
	}
	if report.Summary.Verdict != requiredVerdict {
		return fmt.Errorf("%w: report summary verdict does not match required gates", ErrInvalid)
	}
	if err := validateServerOwnedGateSemantics(report, records); err != nil {
		return err
	}
	if err := validatePromotionSummary(report); err != nil {
		return err
	}
	if len(report.Tracks) != len(report.Run.TrackIDs) {
		return fmt.Errorf("%w: report track coverage does not match the run", ErrInvalid)
	}
	if err := validateTrackReportMirrors(report); err != nil {
		return err
	}
	if err := validateServerOwnedReportPresentation(report, records); err != nil {
		return err
	}
	return nil
}

func validateTrackReportMirrors(report Report) error {
	for index, track := range report.Tracks {
		if track.TrackID != report.Run.TrackIDs[index] {
			return fmt.Errorf("%w: report track order does not match the run", ErrInvalid)
		}
		expectedGates := make([]Gate, 0)
		expectedMetrics := make([]Metric, 0)
		for _, gate := range report.Gates {
			if gate.TrackID == track.TrackID {
				expectedGates = append(expectedGates, gate)
			}
		}
		for _, metric := range report.Metrics {
			if metric.TrackID == track.TrackID {
				expectedMetrics = append(expectedMetrics, metric)
			}
		}
		if !reflect.DeepEqual(track.Gates, expectedGates) || !reflect.DeepEqual(track.Metrics, expectedMetrics) {
			return fmt.Errorf("%w: track report does not match top-level metrics and gates", ErrInvalid)
		}
	}
	return nil
}

func validateWorkerSingleRunMetricOwnership(metrics []Metric) error {
	for _, metric := range metrics {
		if metric.BaselineValue != nil || metric.Delta != nil {
			return fmt.Errorf("%w: single-run metric %s cannot publish worker-owned baseline_value or delta", ErrInvalid, metric.ID)
		}
	}
	return nil
}

func validateServerOwnedReportPresentation(report Report, records recordAttestation) error {
	if err := validateServerCoverage("report summary", report.Summary.Coverage, records.expectedSummaryCoverage()); err != nil {
		return err
	}
	for _, track := range report.Tracks {
		if err := validateServerCoverage("track "+string(track.TrackID), track.Coverage, records.expectedTrackCoverage(track.TrackID)); err != nil {
			return err
		}
		counts := records.ByTrack[track.TrackID]
		available := counts.Succeeded + counts.Failed
		expectedStatus := "unavailable"
		expectedSummary := "No qualified evidence was produced."
		if available > 0 {
			expectedStatus = "completed"
			expectedSummary = fmt.Sprintf("Collected %d evidence records.", available)
			if counts.Failed > 0 {
				expectedSummary = fmt.Sprintf("Collected %d evidence records; %d executions failed and remain in the denominator.", available, counts.Failed)
			}
		}
		if track.Status != expectedStatus || track.Summary != expectedSummary || track.Error != "" {
			return fmt.Errorf("%w: track %s presentation does not match records", ErrInvalid, track.TrackID)
		}
		if report.Run.EvidenceLevel == "E0" && track.EvidenceLevel != "E0" {
			return fmt.Errorf("%w: E0 run track %s cannot claim evidence level %s", ErrInvalid, track.TrackID, track.EvidenceLevel)
		}
	}
	return nil
}

func validateServerCoverage(label string, actual, expected Coverage) error {
	if actual.Evaluated != expected.Evaluated || actual.Total != expected.Total || actual.Unavailable != expected.Unavailable ||
		!reducedFloatsEqual(actual.Fraction, expected.Fraction) ||
		!reducedFloatsEqual(actual.ConfidenceLevel, expected.ConfidenceLevel) ||
		!reducedIntervalsEqual(actual.ConfidenceInterval, expected.ConfidenceInterval) {
		return fmt.Errorf("%w: %s coverage does not match records", ErrInvalid, label)
	}
	return nil
}

func validateReportMetrics(metrics []Metric, selectedTrackIDs []TrackID) error {
	selectedTracks := make(map[TrackID]struct{}, len(selectedTrackIDs))
	for _, trackID := range selectedTrackIDs {
		selectedTracks[trackID] = struct{}{}
	}
	metricIDs := make(map[string]struct{}, len(metrics))
	for _, metric := range metrics {
		if strings.TrimSpace(metric.ID) == "" {
			return fmt.Errorf("evaluation report contains a blank metric id")
		}
		if _, duplicate := metricIDs[metric.ID]; duplicate {
			return fmt.Errorf("evaluation report contains duplicate metric id %q", metric.ID)
		}
		metricIDs[metric.ID] = struct{}{}
		if strings.TrimSpace(metric.Name) == "" {
			return fmt.Errorf("evaluation metric %q has a blank name", metric.ID)
		}
		if strings.TrimSpace(metric.Unit) == "" {
			return fmt.Errorf("evaluation metric %q has a blank unit", metric.ID)
		}
		if metric.TrackID != "" {
			if _, selected := selectedTracks[metric.TrackID]; !selected {
				return fmt.Errorf("evaluation metric %q track_id %q is not selected by the run", metric.ID, metric.TrackID)
			}
		}
		if !validMetricDirection(metric.Direction) {
			return fmt.Errorf("evaluation metric %q has invalid direction", metric.ID)
		}
		if metric.SampleCount < 0 {
			return fmt.Errorf("evaluation metric %q sample_count cannot be negative", metric.ID)
		}
		for _, value := range []struct {
			name  string
			value *float64
		}{
			{name: "value", value: metric.Value},
			{name: "baseline_value", value: metric.BaselineValue},
			{name: "delta", value: metric.Delta},
		} {
			if value.value != nil && !finiteFloat(*value.value) {
				return fmt.Errorf("evaluation metric %q %s must be finite", metric.ID, value.name)
			}
		}
		if metric.ConfidenceInterval != nil {
			if len(metric.ConfidenceInterval) != 2 {
				return fmt.Errorf("evaluation metric %q confidence_interval must contain exactly two bounds", metric.ID)
			}
			lower, upper := metric.ConfidenceInterval[0], metric.ConfidenceInterval[1]
			if !finiteFloat(lower) || !finiteFloat(upper) {
				return fmt.Errorf("evaluation metric %q confidence_interval bounds must be finite", metric.ID)
			}
			if lower > upper {
				return fmt.Errorf("evaluation metric %q confidence_interval bounds are reversed", metric.ID)
			}
			if metric.Value == nil || metric.SampleCount == 0 {
				return fmt.Errorf("evaluation metric %q confidence_interval requires an estimate and samples", metric.ID)
			}
		}
		if (metric.BaselineValue == nil) != (metric.Delta == nil) {
			return fmt.Errorf("evaluation metric %q baseline_value and delta must be published together", metric.ID)
		}
		if metric.BaselineValue != nil {
			if metric.Value == nil {
				return fmt.Errorf("evaluation metric %q comparison requires a candidate value", metric.ID)
			}
			if *metric.Delta != *metric.Value-*metric.BaselineValue {
				return fmt.Errorf("evaluation metric %q delta does not match value minus baseline_value", metric.ID)
			}
		}
	}
	return nil
}

func validatePromotionSummary(report Report) error {
	if report.Run.EvidenceLevel == "E0" {
		if report.Summary.QualityScore != nil || report.Summary.LatencyP95MS != nil ||
			report.Summary.RuntimeCost != nil || report.Summary.CapacityTCO != nil {
			return fmt.Errorf("%w: E0 reports cannot publish promotion headline metrics", ErrInvalid)
		}
		return nil
	}
	metricValue := func(ids ...string) *float64 {
		for _, id := range ids {
			for _, metric := range report.Metrics {
				if metric.ID == id && metric.Value != nil {
					value := *metric.Value
					return &value
				}
			}
		}
		return nil
	}
	quality := metricValue("joint.realized_quality", "routing.accuracy", "model_pool.oracle_quality")
	latency := metricValue("joint.latency_p95_ms", "capacity.latency_p95_ms", "routing.latency_p95_ms")
	if !reflect.DeepEqual(report.Summary.QualityScore, quality) || !reflect.DeepEqual(report.Summary.LatencyP95MS, latency) ||
		!reflect.DeepEqual(report.Summary.RuntimeCost, report.Costs.Runtime.Amount) ||
		!reflect.DeepEqual(report.Summary.CapacityTCO, report.Costs.CapacityTCO.Amount) {
		return fmt.Errorf("%w: report promotion summary does not match typed evidence", ErrInvalid)
	}
	return nil
}

func validateReportGateEvidence(report Report, checksums map[string]string) error {
	metrics := make(map[string]Metric, len(report.Metrics))
	for _, metric := range report.Metrics {
		metrics[metric.ID] = metric
	}
	for _, gate := range report.Gates {
		seen := make(map[string]bool, len(gate.EvidenceRefs))
		for _, ref := range gate.EvidenceRefs {
			if seen[ref] {
				return fmt.Errorf("%w: gate %s contains duplicate evidence references", ErrInvalid, gate.ID)
			}
			seen[ref] = true
			if metricID, ok := strings.CutPrefix(ref, "metric:"); ok {
				metric, exists := metrics[metricID]
				if (gate.Verdict == "pass" || gate.Verdict == "fail") && (!exists || metric.Value == nil) {
					return fmt.Errorf("%w: gate %s references unavailable metric evidence", ErrInvalid, gate.ID)
				}
				continue
			}
			if checksums[ref] == "" {
				return fmt.Errorf("%w: gate %s references unverified artifact evidence", ErrInvalid, gate.ID)
			}
		}
	}
	return nil
}

func decodeStrictEvidence(path string, destination any) error {
	data, err := readEvidenceBytes(path, maxStructuredArtifactBytes)
	if err != nil {
		return fmt.Errorf("read evidence file %s: %w", filepath.Base(path), err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode evidence file %s: %w", filepath.Base(path), err)
	}
	return ensureJSONEOF(decoder)
}
