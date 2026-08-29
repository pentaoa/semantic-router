package evaluationplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func float64Pointer(value float64) *float64 { return &value }

func TestReportJSONIsStrictVersionedIdentityCheckedAndRaw(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	run, createErr := service.CreateRun(context.Background(), validCreateRequest())
	if createErr != nil {
		t.Fatalf("CreateRun: %v", createErr)
	}
	reportPath := filepath.Join(root, "runs", run.ID, reportFileName)
	valid := reportForRun(run, []Artifact{})
	valid.Metrics = []Metric{{
		ID: "routing.accuracy", Name: "Routing accuracy", TrackID: "routing",
		Value: float64Pointer(0.75), Unit: "fraction", Direction: "higher_is_better",
		ConfidenceInterval: []float64{0.5, 0.9}, SampleCount: 4,
	}}
	valid.Gates = []Gate{{
		ID: "G0", Name: "Reproducibility", Disposition: "required", Verdict: "pass",
		ChangeProfile: run.ChangeProfile, ContractVersion: GateContractVersion,
		EvidenceRefs: []string{"provenance.json"},
	}}
	raw, marshalErr := json.MarshalIndent(valid, "", "    ")
	if marshalErr != nil {
		t.Fatalf("Marshal report: %v", marshalErr)
	}
	if err := os.WriteFile(reportPath, raw, 0o600); err != nil {
		t.Fatalf("write report: %v", err)
	}
	sealTestReport(t, service, run.ID)
	sealedRaw, readErr := service.store.ReadReport(run.ID)
	if readErr != nil {
		t.Fatalf("read canonical sealed report: %v", readErr)
	}
	got, reportErr := service.ReportJSON(run.ID)
	if reportErr != nil || !bytes.Equal(got, sealedRaw) {
		t.Fatalf("ReportJSON did not preserve sealed bundle bytes: equal=%v err=%v", bytes.Equal(got, sealedRaw), reportErr)
	}
	raw = sealedRaw

	tests := []struct {
		name   string
		mutate func(map[string]any)
		match  string
	}{
		{name: "unknown field", mutate: func(value map[string]any) { value["engine_extension"] = true }, match: "unknown field"},
		{name: "wrong schema", mutate: func(value map[string]any) { value["schema_version"] = "evaluation.v2" }, match: "schema_version"},
		{name: "wrong nested schema", mutate: func(value map[string]any) { value["provenance"].(map[string]any)["schema_version"] = "evaluation.v2" }, match: "nested schema_version"},
		{name: "wrong identity", mutate: func(value map[string]any) { value["run"].(map[string]any)["id"] = "other-run" }, match: "identity mismatch"},
		{name: "null collection", mutate: func(value map[string]any) { value["artifacts"] = nil }, match: "cannot be null"},
		{name: "gate profile mismatch", mutate: func(value map[string]any) {
			value["gates"].([]any)[0].(map[string]any)["change_profile"] = "recipe"
		}, match: "change_profile"},
		{name: "gate contract mismatch", mutate: func(value map[string]any) {
			value["gates"].([]any)[0].(map[string]any)["contract_version"] = "old"
		}, match: "contract_version"},
		{name: "gate evidence missing", mutate: func(value map[string]any) {
			value["gates"].([]any)[0].(map[string]any)["evidence_refs"] = []any{}
		}, match: "evidence_refs"},
		{name: "blank metric name", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["name"] = "  "
		}, match: "blank name"},
		{name: "blank metric unit", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["unit"] = ""
		}, match: "blank unit"},
		{name: "metric outside selected tracks", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["track_id"] = "joint"
		}, match: "not selected by the run"},
		{name: "negative metric sample count", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["sample_count"] = -1
		}, match: "sample_count cannot be negative"},
		{name: "malformed metric confidence interval", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["confidence_interval"] = []any{0.5}
		}, match: "exactly two bounds"},
		{name: "reversed metric confidence interval", mutate: func(value map[string]any) {
			value["metrics"].([]any)[0].(map[string]any)["confidence_interval"] = []any{0.9, 0.5}
		}, match: "bounds are reversed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatalf("Unmarshal report: %v", err)
			}
			test.mutate(value)
			if err := writeJSONAtomic(reportPath, value); err != nil {
				t.Fatalf("write mutated report: %v", err)
			}
			if _, err := service.ReportJSON(run.ID); err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("ReportJSON error=%v, want match %q", err, test.match)
			}
		})
	}
}

func TestValidateReportMetricsRejectsMisleadingNumericEvidence(t *testing.T) {
	validMetric := func() Metric {
		value := 0.8
		return Metric{
			ID: "routing.accuracy", Name: "Routing accuracy", TrackID: "routing",
			Value: &value, Unit: "fraction", Direction: "higher_is_better",
			ConfidenceInterval: []float64{0.7, 0.9}, SampleCount: 10,
		}
	}
	if err := validateReportMetrics([]Metric{validMetric()}, []TrackID{"routing"}); err != nil {
		t.Fatalf("valid metric rejected: %v", err)
	}
	systemMetric := validMetric()
	systemMetric.ID = "system.total_cost"
	systemMetric.Name = "Total cost"
	systemMetric.TrackID = ""
	if err := validateReportMetrics([]Metric{systemMetric}, []TrackID{"routing"}); err != nil {
		t.Fatalf("valid system-level metric rejected: %v", err)
	}
	unavailable := validMetric()
	unavailable.Value = nil
	unavailable.ConfidenceInterval = nil
	unavailable.SampleCount = 0
	if err := validateReportMetrics([]Metric{unavailable}, []TrackID{"routing"}); err != nil {
		t.Fatalf("unavailable metric without statistical claims rejected: %v", err)
	}
	compared := validMetric()
	compared.BaselineValue = float64Pointer(0.7)
	compared.Delta = float64Pointer(*compared.Value - *compared.BaselineValue)
	if err := validateReportMetrics([]Metric{compared}, []TrackID{"routing"}); err != nil {
		t.Fatalf("consistent comparison metric rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Metric)
		match  string
	}{
		{name: "blank id", mutate: func(metric *Metric) { metric.ID = " " }, match: "blank metric id"},
		{name: "blank name", mutate: func(metric *Metric) { metric.Name = "\t" }, match: "blank name"},
		{name: "blank unit", mutate: func(metric *Metric) { metric.Unit = " " }, match: "blank unit"},
		{name: "unselected track", mutate: func(metric *Metric) { metric.TrackID = "joint" }, match: "not selected by the run"},
		{name: "invalid direction", mutate: func(metric *Metric) { metric.Direction = "maximize" }, match: "invalid direction"},
		{name: "negative sample count", mutate: func(metric *Metric) { metric.SampleCount = -1 }, match: "sample_count cannot be negative"},
		{name: "empty confidence interval", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{} }, match: "exactly two bounds"},
		{name: "short confidence interval", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{0.7} }, match: "exactly two bounds"},
		{name: "long confidence interval", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{0.6, 0.8, 0.9} }, match: "exactly two bounds"},
		{name: "reversed confidence interval", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{0.9, 0.7} }, match: "bounds are reversed"},
		{name: "non-finite confidence lower bound", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{math.NaN(), 0.9} }, match: "bounds must be finite"},
		{name: "non-finite confidence upper bound", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{0.7, math.Inf(1)} }, match: "bounds must be finite"},
		{name: "confidence interval without value", mutate: func(metric *Metric) { metric.Value = nil }, match: "requires an estimate and samples"},
		{name: "confidence interval without samples", mutate: func(metric *Metric) { metric.SampleCount = 0 }, match: "requires an estimate and samples"},
		{name: "non-finite value", mutate: func(metric *Metric) { metric.Value = float64Pointer(math.NaN()) }, match: "value must be finite"},
		{name: "non-finite baseline", mutate: func(metric *Metric) {
			metric.BaselineValue = float64Pointer(math.Inf(1))
			metric.Delta = float64Pointer(0)
		}, match: "baseline_value must be finite"},
		{name: "non-finite delta", mutate: func(metric *Metric) {
			metric.BaselineValue = float64Pointer(0.7)
			metric.Delta = float64Pointer(math.Inf(-1))
		}, match: "delta must be finite"},
		{name: "baseline without delta", mutate: func(metric *Metric) { metric.BaselineValue = float64Pointer(0.7) }, match: "must be published together"},
		{name: "delta without baseline", mutate: func(metric *Metric) { metric.Delta = float64Pointer(0.1) }, match: "must be published together"},
		{name: "comparison without candidate value", mutate: func(metric *Metric) {
			metric.Value = nil
			metric.ConfidenceInterval = nil
			metric.BaselineValue = float64Pointer(0.7)
			metric.Delta = float64Pointer(0.1)
		}, match: "requires a candidate value"},
		{name: "inconsistent delta", mutate: func(metric *Metric) {
			metric.BaselineValue = float64Pointer(0.7)
			metric.Delta = float64Pointer(0.2)
		}, match: "does not match value minus baseline_value"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metric := validMetric()
			test.mutate(&metric)
			err := validateReportMetrics([]Metric{metric}, []TrackID{"routing"})
			if err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("validateReportMetrics error=%v, want match %q", err, test.match)
			}
		})
	}

	first, second := validMetric(), validMetric()
	if err := validateReportMetrics([]Metric{first, second}, []TrackID{"routing"}); err == nil || !strings.Contains(err.Error(), "duplicate metric id") {
		t.Fatalf("duplicate metric validation error=%v", err)
	}
}

func TestReportJSONKeepsLegacyWorkerIdentityReportsReadable(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	run, createErr := service.CreateRun(context.Background(), validCreateRequest())
	if createErr != nil {
		t.Fatalf("CreateRun: %v", createErr)
	}
	serverStarted := time.Now().UTC().Add(-2 * time.Minute)
	workerStarted := serverStarted.Add(30 * time.Second)
	workerCompleted := workerStarted.Add(30 * time.Second)
	serverCompleted := workerCompleted.Add(30 * time.Second)
	run.Status = StatusCompleted
	run.StartedAt = &serverStarted
	run.CompletedAt = &serverCompleted
	if err := service.store.UpdateRun(run); err != nil {
		t.Fatalf("complete legacy run: %v", err)
	}
	report := reportForRun(run, nil)
	report.Run.Name = run.ID
	report.Run.Description = "Evaluation suites: " + strings.Join(run.SuiteIDs, ", ")
	report.Run.ClientRequestID = ""
	report.Run.StartedAt = &workerStarted
	report.Run.CompletedAt = &workerCompleted
	legacyObserved := 0.5
	report.Gates = []Gate{{
		ID: "G2", Name: "Hard policy", TrackID: "safety", Disposition: "advisory", Verdict: "fail",
		ChangeProfile: report.Run.ChangeProfile, ContractVersion: GateContractVersion,
		EvidenceRefs: []string{"records.jsonl", "metric:safety.violation_rate"},
		Observed:     &legacyObserved, Threshold: &GateThreshold{Operator: "<=", Value: 0, Unit: "violations/case"},
	}}
	if err := service.store.WriteReport(run.ID, report); err != nil {
		t.Fatalf("write legacy report: %v", err)
	}
	privateReceiptDigest := writeTestPrivateReceipt(t, service, run.ID)
	checksums, receiptErr := service.validatePrivateReceipt(run.ID)
	if receiptErr != nil {
		t.Fatalf("validate private receipt: %v", receiptErr)
	}
	evidenceFiles, snapshotErr := service.buildSealedEvidenceSnapshot(run.ID, checksums)
	if snapshotErr != nil {
		t.Fatalf("build sealed evidence snapshot: %v", snapshotErr)
	}
	reportBytes, reportErr := service.store.ReadReport(run.ID)
	if reportErr != nil {
		t.Fatalf("read legacy report: %v", reportErr)
	}
	_, manifestBytes, manifestErr := service.readDurableManifest(run.ID)
	if manifestErr != nil {
		t.Fatalf("read manifest: %v", manifestErr)
	}
	reportDigest, reportSize := digestAndSize(reportBytes)
	manifestDigest, _ := digestAndSize(manifestBytes)
	if err := service.store.writeReportAnchor(run.ID, reportAnchor{
		SchemaVersion: SchemaVersion, RunID: run.ID, ReportDigest: reportDigest, ReportSize: reportSize,
		ManifestDigest: manifestDigest, PrivateReceiptDigest: privateReceiptDigest,
		EvidenceFiles: evidenceFiles, CreatedAt: serverCompleted,
	}); err != nil {
		t.Fatalf("anchor legacy report: %v", err)
	}
	legacyBytes, legacyReadErr := service.ReportJSON(run.ID)
	if legacyReadErr != nil {
		t.Fatalf("legacy worker-identity report became unreadable: %v", legacyReadErr)
	}
	legacyReport, decodeErr := decodeReportStrict(run.ID, legacyBytes)
	if decodeErr != nil {
		t.Fatalf("decode legacy report: %v", decodeErr)
	}
	if legacyReport.AttestationRevision != "" {
		t.Fatalf("legacy report unexpectedly claims attestation revision %q", legacyReport.AttestationRevision)
	}
	legacyAnchor, anchorReadErr := service.store.readReportAnchor(run.ID)
	if anchorReadErr != nil {
		t.Fatalf("read legacy report anchor: %v", anchorReadErr)
	}
	if legacyAnchor.AttestationRevision != "" {
		t.Fatalf("legacy report anchor unexpectedly claims attestation revision %q", legacyAnchor.AttestationRevision)
	}

	anchorPath := filepath.Join(service.store.runsRoot, run.ID, reportAnchorFileName)
	if err := os.Remove(anchorPath); err != nil {
		t.Fatalf("remove legacy report anchor: %v", err)
	}
	legacyAnchor.AttestationRevision = ServerAttestationRevision
	if err := service.store.writeReportAnchor(run.ID, legacyAnchor); err != nil {
		t.Fatalf("write mismatched report anchor: %v", err)
	}
	if _, err := service.ReportJSON(run.ID); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "attestation revision") {
		t.Fatalf("mismatched report/anchor revision error=%v, want ErrInvalid", err)
	}

	if err := os.Remove(anchorPath); err != nil {
		t.Fatalf("remove mismatched report anchor: %v", err)
	}
	legacyAnchor.AttestationRevision = "evaluation-server-attestation.v999"
	if err := writeJSONAtomic(anchorPath, legacyAnchor); err != nil {
		t.Fatalf("write unknown report anchor: %v", err)
	}
	if _, err := service.ReportJSON(run.ID); err == nil || !strings.Contains(err.Error(), "anchor is invalid") {
		t.Fatalf("unknown report anchor revision error=%v, want invalid anchor", err)
	}
}

func TestDecodeReportStrictRejectsUnknownAttestationRevision(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	run, createErr := service.CreateRun(context.Background(), validCreateRequest())
	if createErr != nil {
		t.Fatalf("CreateRun: %v", createErr)
	}
	report := reportForRun(run, nil)
	report.AttestationRevision = "evaluation-server-attestation.v999"
	data, marshalErr := json.Marshal(report)
	if marshalErr != nil {
		t.Fatalf("encode report: %v", marshalErr)
	}
	if _, err := decodeReportStrict(run.ID, data); err == nil || !strings.Contains(err.Error(), "attestation_revision is invalid") {
		t.Fatalf("unknown report attestation revision error=%v, want invalid revision", err)
	}
}

type pairedComparisonFixture struct {
	service      *Service
	baselineRun  Run
	candidateRun Run
	baseline     Report
	candidate    Report
}

func newPairedComparisonFixture(t *testing.T) *pairedComparisonFixture {
	t.Helper()
	service, _ := newTestService(t, &controlledProcess{}, 1)
	baselineRequest := validCreateRequest()
	baselineRequest.ChangeProfile = "recipe"
	baselineRun, baselineErr := service.CreateRun(context.Background(), baselineRequest)
	if baselineErr != nil {
		t.Fatalf("create baseline: %v", baselineErr)
	}
	baselineRun.Status = StatusCompleted
	if err := service.store.UpdateRun(baselineRun); err != nil {
		t.Fatalf("complete baseline: %v", err)
	}
	candidateRequest := validCreateRequest()
	candidateRequest.Name = "candidate"
	candidateRequest.ChangeProfile = baselineRun.ChangeProfile
	candidateRequest.BaselineRunID = baselineRun.ID
	candidateRun, candidateErr := service.CreateRun(context.Background(), candidateRequest)
	if candidateErr != nil {
		t.Fatalf("create candidate: %v", candidateErr)
	}
	baseline := reportForRun(baselineRun, nil)
	baseline.AttestationRevision = ServerAttestationRevision
	baseline.Metrics = []Metric{
		{ID: "routing.accuracy", Name: "Quality", TrackID: "routing", Value: float64Pointer(0.8), Unit: "score", Direction: "higher_is_better"},
		{ID: "routing.latency_p95_ms", Name: "Latency", TrackID: "routing", Value: float64Pointer(100), Unit: "ms", Direction: "lower_is_better"},
		{ID: "missing", Name: "Missing", TrackID: "routing", Value: nil, Unit: "score", Direction: "higher_is_better"},
	}
	candidate := reportForRun(candidateRun, nil)
	candidate.AttestationRevision = ServerAttestationRevision
	candidate.Provenance.PolicySnapshotDigest = "sha256:candidate-policy"
	candidate.Provenance.BindingSnapshotDigest = "sha256:candidate-binding"
	candidate.Metrics = []Metric{
		{ID: "routing.accuracy", Name: "Quality", TrackID: "routing", Value: float64Pointer(0.9), Unit: "score", Direction: "higher_is_better"},
		{ID: "routing.latency_p95_ms", Name: "Latency", TrackID: "routing", Value: float64Pointer(104), Unit: "ms", Direction: "lower_is_better"},
		{ID: "missing", Name: "Missing", TrackID: "routing", Value: float64Pointer(1), Unit: "score", Direction: "higher_is_better"},
		{ID: "candidate-only", Name: "Candidate only", TrackID: "routing", Value: float64Pointer(7), Unit: "count", Direction: "higher_is_better"},
	}
	return &pairedComparisonFixture{
		service: service, baselineRun: baselineRun, candidateRun: candidateRun,
		baseline: baseline, candidate: candidate,
	}
}

func assertInitialPairedComparison(t *testing.T, fixture *pairedComparisonFixture) {
	t.Helper()
	writeAnchoredTestReport(t, fixture.service, fixture.baselineRun.ID, fixture.baseline)
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	comparison, comparisonErr := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID)
	if comparisonErr != nil {
		t.Fatalf("Compare: %v", comparisonErr)
	}
	if comparison.Verdict != "unavailable" || !strings.Contains(comparison.Summary, "1 improved, 1 regressed") ||
		!strings.Contains(comparison.Summary, "E0 aggregate deltas") {
		t.Fatalf("unexpected comparison: %+v", comparison)
	}
	if comparison.AttestationRevision != ServerAttestationRevision {
		t.Fatalf("comparison attestation=%q, want %q", comparison.AttestationRevision, ServerAttestationRevision)
	}
	if comparison.Metrics[0].Delta == nil || *comparison.Metrics[0].Delta <= 0 {
		t.Fatalf("quality improvement delta missing: %+v", comparison.Metrics[0])
	}
	if comparison.Metrics[1].Delta == nil || *comparison.Metrics[1].Delta <= 0 {
		t.Fatalf("latency raw delta missing: %+v", comparison.Metrics[1])
	}
	if comparison.Metrics[2].Delta != nil || comparison.Metrics[3].Delta != nil {
		t.Fatalf("missing evidence must not produce deltas: %+v", comparison.Metrics)
	}
}

func assertPairedPromotionFailures(t *testing.T, fixture *pairedComparisonFixture) {
	t.Helper()
	fixture.candidate.Metrics[1].Value = float64Pointer(106)
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	comparison, comparisonErr := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID)
	if comparisonErr != nil || comparison.Verdict != "unavailable" || !strings.Contains(comparison.Summary, "E0 aggregate deltas") {
		t.Fatalf("latency budget comparison=%+v err=%v", comparison, comparisonErr)
	}

	fixture.candidate.Metrics[1].Value = float64Pointer(100)
	fixture.candidate.Metrics[0].Value = float64Pointer(0.7)
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	comparison, comparisonErr = fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID)
	if comparisonErr != nil || comparison.Verdict != "unavailable" || !strings.Contains(comparison.Summary, "E0 aggregate deltas") {
		t.Fatalf("primary regression comparison=%+v err=%v", comparison, comparisonErr)
	}

	fixture.candidate.Summary.Verdict = "unavailable"
	fixture.candidate.Metrics = []Metric{}
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	comparison, comparisonErr = fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID)
	if comparisonErr != nil || comparison.Verdict != "unavailable" {
		t.Fatalf("unavailable comparison=%+v err=%v", comparison, comparisonErr)
	}
}

func assertPairedComparisonRejectsCohortMismatches(t *testing.T, fixture *pairedComparisonFixture) {
	t.Helper()
	fixture.candidate.Provenance.WorkloadSnapshotDigest = "sha256:different-workload"
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	if _, err := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("workload mismatch error=%v, want ErrInvalid", err)
	}
	fixture.candidate.Provenance.WorkloadSnapshotDigest = fixture.baseline.Provenance.WorkloadSnapshotDigest
	fixture.candidate.Provenance.PoolSnapshotDigest = "sha256:different-pool"
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	if _, err := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("pool mismatch error=%v, want ErrInvalid", err)
	}
	fixture.candidate.Provenance.PoolSnapshotDigest = fixture.baseline.Provenance.PoolSnapshotDigest
	fixture.candidate.Provenance.BenchmarkRevisions = map[string]string{"fixture": "different"}
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	if _, err := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("benchmark mismatch error=%v, want ErrInvalid", err)
	}
	fixture.candidate.Provenance.BenchmarkRevisions = fixture.baseline.Provenance.BenchmarkRevisions
	fixture.candidate.Run.Concurrency++
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	if _, err := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("concurrency mismatch error=%v, want ErrInvalid", err)
	}
	fixture.candidate.Run.Concurrency = fixture.baseline.Run.Concurrency
	fixture.candidate.Run.Seed++
	fixture.candidate.Provenance.Seed = fixture.candidate.Run.Seed
	writeAnchoredTestReport(t, fixture.service, fixture.candidateRun.ID, fixture.candidate)
	if _, err := fixture.service.Compare(fixture.baselineRun.ID, fixture.candidateRun.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cohort mismatch error=%v, want ErrInvalid", err)
	}
}

func TestCompareUsesPairedPromotionGatesInsteadOfMetricMajority(t *testing.T) {
	fixture := newPairedComparisonFixture(t)
	assertInitialPairedComparison(t, fixture)
	assertPairedPromotionFailures(t, fixture)
	assertPairedComparisonRejectsCohortMismatches(t, fixture)
}

func TestCompareRequiredGateAndPairingAvailabilityPrecedence(t *testing.T) {
	baselineRun := Run{
		SchemaVersion: SchemaVersion, ID: "baseline", Status: StatusCompleted, Mode: ModeReplay,
		TargetID: "fixture", ChangeProfile: "recipe",
		SuiteIDs: []string{"evaluation-smoke"}, TrackIDs: []TrackID{"routing"},
		SampleLimit: 4, Concurrency: 1, Seed: 17,
	}
	candidateRun := baselineRun
	candidateRun.ID = "candidate"
	candidateRun.BaselineRunID = baselineRun.ID
	baseline := reportForRun(baselineRun, nil)
	candidate := reportForRun(candidateRun, nil)
	baseline.AttestationRevision = ServerAttestationRevision
	candidate.AttestationRevision = ServerAttestationRevision
	baseline.Metrics = []Metric{{ID: "advisory.score", Name: "Advisory", Value: float64Pointer(1), Unit: "score", Direction: "higher_is_better"}}
	candidate.Metrics = []Metric{{ID: "advisory.score", Name: "Advisory", Value: float64Pointer(2), Unit: "score", Direction: "higher_is_better"}}
	candidate.Provenance.PolicySnapshotDigest = "sha256:candidate-policy"
	candidate.Provenance.BindingSnapshotDigest = "sha256:candidate-binding"

	candidate.Gates = []Gate{{
		ID: "G3", Name: "Required", Disposition: "required", Verdict: "fail",
		ChangeProfile: candidateRun.ChangeProfile, ContractVersion: GateContractVersion, EvidenceRefs: []string{"metrics.json"},
	}}
	comparison, err := comparePairedReports(baseline, candidate)
	if err != nil || comparison.Verdict != "fail" {
		t.Fatalf("required failure comparison=%+v err=%v", comparison, err)
	}
	candidate.Gates[0].Verdict = "unavailable"
	comparison, err = comparePairedReports(baseline, candidate)
	if err != nil || comparison.Verdict != "unavailable" {
		t.Fatalf("required unavailable comparison=%+v err=%v", comparison, err)
	}
	candidate.Gates = []Gate{}
	candidate.Metrics = []Metric{{ID: "candidate-only", Name: "Candidate", Value: float64Pointer(2), Unit: "score", Direction: "higher_is_better"}}
	comparison, err = comparePairedReports(baseline, candidate)
	if err != nil || comparison.Verdict != "unavailable" || !strings.Contains(comparison.Summary, "No matched direction-aware aggregate") {
		t.Fatalf("unpaired comparison=%+v err=%v", comparison, err)
	}

	candidate.Metrics = baseline.Metrics
	candidate.Provenance.PolicySnapshotDigest = ""
	if _, err := comparePairedReports(baseline, candidate); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing policy digest error=%v, want ErrInvalid", err)
	}
}

func TestComparisonVerdictRequiresCurrentServerAttestationAtEveryEvidenceLevel(t *testing.T) {
	for _, level := range []EvidenceLevel{"E0", "E1", "E2", "E3", "E4", "E5"} {
		t.Run(string(level), func(t *testing.T) {
			baseline := Report{
				AttestationRevision: ServerAttestationRevision,
				Run:                 Run{EvidenceLevel: level},
			}
			candidate := Report{
				AttestationRevision: ServerAttestationRevision,
				Run:                 Run{EvidenceLevel: level},
			}
			evidence := comparisonEvidence{matched: 1}

			baseline.AttestationRevision = ""
			verdict, reason := comparisonVerdict(baseline, candidate, evidence)
			if verdict != "unavailable" || !strings.Contains(reason, "current server attestation") {
				t.Fatalf("legacy baseline verdict=%q reason=%q", verdict, reason)
			}

			baseline.AttestationRevision = ServerAttestationRevision
			candidate.AttestationRevision = ""
			verdict, reason = comparisonVerdict(baseline, candidate, evidence)
			if verdict != "unavailable" || !strings.Contains(reason, "current server attestation") {
				t.Fatalf("legacy candidate verdict=%q reason=%q", verdict, reason)
			}
		})
	}
}

func TestCompareOnlyPublishesAttestationWhenBothReportsAreCurrent(t *testing.T) {
	baselineRun := Run{
		SchemaVersion: SchemaVersion, ID: "baseline", Status: StatusCompleted,
		Mode: ModeReplay, TargetID: "fixture", ChangeProfile: "recipe",
		SuiteIDs: []string{"evaluation-smoke"}, TrackIDs: []TrackID{"routing"},
		SampleLimit: 4, Concurrency: 1, Seed: 17, EvidenceLevel: "E0",
	}
	candidateRun := baselineRun
	candidateRun.ID, candidateRun.BaselineRunID = "candidate", "baseline"
	baseline := reportForRun(baselineRun, nil)
	candidate := reportForRun(candidateRun, nil)
	baseline.AttestationRevision = ServerAttestationRevision
	candidate.AttestationRevision = ServerAttestationRevision
	candidate.Provenance.PolicySnapshotDigest = "sha256:candidate-policy"
	candidate.Provenance.BindingSnapshotDigest = "sha256:candidate-binding"

	comparison, err := comparePairedReports(baseline, candidate)
	if err != nil || comparison.AttestationRevision != ServerAttestationRevision {
		t.Fatalf("current comparison=%+v err=%v", comparison, err)
	}
	candidate.AttestationRevision = ""
	comparison, err = comparePairedReports(baseline, candidate)
	if err != nil || comparison.AttestationRevision != "" || comparison.Verdict != "unavailable" {
		t.Fatalf("legacy comparison=%+v err=%v", comparison, err)
	}
}

func TestPairedMetricEvidenceRequiresMatchingMetricSchema(t *testing.T) {
	value := float64Pointer(0.8)
	baseline := Metric{
		ID: "routing.accuracy", Name: "Accuracy", TrackID: "routing",
		Value: value, Unit: "ratio", Direction: "higher_is_better",
	}
	tests := []struct {
		name   string
		mutate func(*Metric)
	}{
		{name: "unit", mutate: func(metric *Metric) { metric.Unit = "percent" }},
		{name: "track", mutate: func(metric *Metric) { metric.TrackID = "joint" }},
		{name: "direction", mutate: func(metric *Metric) { metric.Direction = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := baseline
			candidate.Value = float64Pointer(0.9)
			candidate.BaselineValue = float64Pointer(0.7)
			candidate.Delta = float64Pointer(0.2)
			test.mutate(&candidate)

			metrics, evidence := pairedMetricEvidence([]Metric{baseline}, []Metric{candidate})
			if evidence.matched != 0 || evidence.improvements != 0 || evidence.regressions != 0 {
				t.Fatalf("schema-mismatched metric produced comparison evidence: %+v", evidence)
			}
			if len(metrics) != 1 || metrics[0].BaselineValue != nil || metrics[0].Delta != nil {
				t.Fatalf("schema-mismatched metric produced a paired delta: %+v", metrics)
			}
		})
	}

	candidate := baseline
	candidate.Value = float64Pointer(0.9)
	metrics, evidence := pairedMetricEvidence([]Metric{baseline}, []Metric{candidate})
	if evidence.matched != 1 || evidence.improvements != 1 || evidence.regressions != 0 {
		t.Fatalf("matching metric schema did not produce comparison evidence: %+v", evidence)
	}
	if len(metrics) != 1 || metrics[0].BaselineValue == nil || metrics[0].Delta == nil {
		t.Fatalf("matching metric schema did not produce a paired delta: %+v", metrics)
	}
}

func TestCompareFreezesSnapshotFactorsByChangeProfile(t *testing.T) {
	profiles := []struct {
		profile ChangeProfile
		allowed map[string]bool
	}{
		{profile: "schema_adapter", allowed: map[string]bool{}},
		{profile: "recipe", allowed: map[string]bool{"policy": true, "binding": true}},
		{profile: "selector", allowed: map[string]bool{"policy": true, "binding": true}},
		{profile: "model_pool", allowed: map[string]bool{"pool": true, "binding": true}},
		{profile: "runtime_capacity", allowed: map[string]bool{"environment": true}},
		{profile: "agent_multimodal", allowed: map[string]bool{"policy": true, "binding": true}},
		{profile: "online_adaptation", allowed: map[string]bool{"policy": true, "binding": true}},
	}
	for _, profile := range profiles {
		t.Run(string(profile.profile), func(t *testing.T) {
			baselineRun := Run{
				SchemaVersion: SchemaVersion, ID: "baseline", Status: StatusCompleted,
				Mode: ModeReplay, TargetID: "fixture", ChangeProfile: profile.profile,
				SuiteIDs: []string{"evaluation-smoke"}, TrackIDs: []TrackID{"routing"},
				SampleLimit: 4, Concurrency: 1, Seed: 17,
			}
			candidateRun := baselineRun
			candidateRun.ID, candidateRun.BaselineRunID = "candidate", "baseline"
			baseline := reportForRun(baselineRun, nil)
			candidate := reportForRun(candidateRun, nil)
			baseline.Metrics = []Metric{{ID: "routing.accuracy", Name: "Accuracy", Value: float64Pointer(0.8), Unit: "score", Direction: "higher_is_better"}}
			candidate.Metrics = []Metric{{ID: "routing.accuracy", Name: "Accuracy", Value: float64Pointer(0.9), Unit: "score", Direction: "higher_is_better"}}

			for _, factor := range []string{"policy", "binding", "pool", "environment"} {
				candidateFactor := candidate
				switch factor {
				case "policy":
					candidateFactor.Provenance.PolicySnapshotDigest = "sha256:candidate-policy"
				case "binding":
					candidateFactor.Provenance.BindingSnapshotDigest = "sha256:candidate-binding"
				case "pool":
					candidateFactor.Provenance.PoolSnapshotDigest = "sha256:candidate-pool"
				case "environment":
					candidateFactor.Provenance.EnvironmentSnapshotDigest = "sha256:candidate-environment"
				}
				_, err := comparePairedReports(baseline, candidateFactor)
				if profile.allowed[factor] && err != nil {
					t.Fatalf("allowed %s treatment rejected: %v", factor, err)
				}
				if !profile.allowed[factor] && !errors.Is(err, ErrInvalid) {
					t.Fatalf("frozen %s treatment error=%v, want ErrInvalid", factor, err)
				}
			}
		})
	}
}

func TestCompareRejectsSelfWrongBaselineLinkAndUnchangedTreatment(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	baselineRun := Run{
		SchemaVersion: SchemaVersion, ID: "baseline", Status: StatusCompleted, Mode: ModeReplay,
		TargetID: "fixture", ChangeProfile: "model_pool", SuiteIDs: []string{"evaluation-smoke"},
		TrackIDs: []TrackID{"model_pool"}, SampleLimit: 4, Concurrency: 1, Seed: 17,
	}
	candidateRun := baselineRun
	candidateRun.ID = "candidate"
	candidateRun.BaselineRunID = baselineRun.ID
	baseline := reportForRun(baselineRun, nil)
	candidate := reportForRun(candidateRun, nil)
	baseline.Metrics = []Metric{{ID: "model_pool.oracle_quality", Name: "Oracle", Value: float64Pointer(0.8), Unit: "score", Direction: "higher_is_better"}}
	candidate.Metrics = []Metric{{ID: "model_pool.oracle_quality", Name: "Oracle", Value: float64Pointer(0.9), Unit: "score", Direction: "higher_is_better"}}

	if _, err := service.Compare("same", "same"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("self-comparison error=%v, want ErrInvalid", err)
	}
	if _, err := comparePairedReports(baseline, baseline); !errors.Is(err, ErrInvalid) {
		t.Fatalf("same report comparison error=%v, want ErrInvalid", err)
	}

	wrongLink := candidate
	wrongLink.Run.BaselineRunID = "other-baseline"
	if _, err := comparePairedReports(baseline, wrongLink); !errors.Is(err, ErrInvalid) {
		t.Fatalf("wrong baseline lineage error=%v, want ErrInvalid", err)
	}
	if _, err := comparePairedReports(baseline, candidate); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "treatment factor") {
		t.Fatalf("unchanged treatment error=%v, want treatment ErrInvalid", err)
	}

	candidate.Provenance.PoolSnapshotDigest = "sha256:candidate-pool"
	if _, err := comparePairedReports(baseline, candidate); err != nil {
		t.Fatalf("declared model-pool treatment was rejected: %v", err)
	}

	schemaBaselineRun := baselineRun
	schemaBaselineRun.ChangeProfile = "schema_adapter"
	schemaCandidateRun := schemaBaselineRun
	schemaCandidateRun.ID, schemaCandidateRun.BaselineRunID = "schema-candidate", schemaBaselineRun.ID
	schemaBaseline := reportForRun(schemaBaselineRun, nil)
	schemaCandidate := reportForRun(schemaCandidateRun, nil)
	if _, err := comparePairedReports(schemaBaseline, schemaCandidate); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "source code revision") {
		t.Fatalf("unchanged schema-adapter revision error=%v, want treatment ErrInvalid", err)
	}
	schemaCandidate.Provenance.CodeRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, err := comparePairedReports(schemaBaseline, schemaCandidate); err != nil {
		t.Fatalf("changed schema-adapter source revision was rejected: %v", err)
	}
}
