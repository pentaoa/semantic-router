package evaluationplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

const publicChecksumArtifactName = "checksums.sha256"

// workerReport is the untrusted worker-to-server evidence envelope. It has no
// attestation field: only the server can publish the externally readable
// Report contract after every evidence validator succeeds.
type workerReport struct {
	SchemaVersion   string        `json:"schema_version"`
	Run             Run           `json:"run"`
	Summary         ReportSummary `json:"summary"`
	Tracks          []TrackReport `json:"tracks"`
	Metrics         []Metric      `json:"metrics"`
	Gates           []Gate        `json:"gates"`
	Costs           CostLedgers   `json:"costs"`
	Recommendations []string      `json:"recommendations"`
	Provenance      Provenance    `json:"provenance"`
	Artifacts       []Artifact    `json:"artifacts"`
}

func workerReportFromReport(report Report) workerReport {
	return workerReport{
		SchemaVersion: report.SchemaVersion,
		Run:           report.Run, Summary: report.Summary, Tracks: report.Tracks,
		Metrics: report.Metrics, Gates: report.Gates, Costs: report.Costs,
		Recommendations: report.Recommendations, Provenance: report.Provenance,
		Artifacts: report.Artifacts,
	}
}

func (s *Service) ReportJSON(runID string) ([]byte, error) {
	release, err := s.acquireEvidenceRead()
	if err != nil {
		return nil, err
	}
	defer release()
	return s.reportJSONVerified(runID)
}

func (s *Service) reportJSONVerified(runID string) ([]byte, error) {
	run, err := s.store.GetRun(runID)
	if err != nil {
		return nil, err
	}
	if run.Status != StatusCompleted {
		return nil, fmt.Errorf("%w: evaluation report is available only for completed runs", ErrConflict)
	}
	data, err := s.store.ReadReport(runID)
	if err != nil {
		return nil, err
	}
	report, err := decodeReportStrict(runID, data)
	if err != nil {
		return nil, err
	}
	manifest, _, err := s.readDurableManifest(runID)
	if err != nil {
		return nil, err
	}
	if err := validateReportFrozenFields(run, manifest, report); err != nil {
		return nil, err
	}
	if err := s.verifyReportAnchor(runID, data, report.AttestationRevision); err != nil {
		return nil, err
	}
	if err := s.rejectConfiguredSecretBytes(data); err != nil {
		return nil, err
	}
	return data, nil
}

func decodeReportStrict(runID string, data []byte) (Report, error) {
	var report Report
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return Report{}, fmt.Errorf("%w: decode evaluation report: %w", ErrInvalid, err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if report.AttestationRevision != ServerAttestationRevision {
		return Report{}, fmt.Errorf("%w: evaluation report attestation_revision must be %q", ErrInvalid, ServerAttestationRevision)
	}
	if err := validateReportShape(runID, report); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	return report, nil
}

func decodeWorkerReportStrict(runID string, data []byte) (Report, error) {
	var draft workerReport
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&draft); err != nil {
		return Report{}, fmt.Errorf("%w: decode evaluation worker report: %w", ErrInvalid, err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	report := Report{
		SchemaVersion: draft.SchemaVersion,
		Run:           draft.Run, Summary: draft.Summary, Tracks: draft.Tracks,
		Metrics: draft.Metrics, Gates: draft.Gates, Costs: draft.Costs,
		Recommendations: draft.Recommendations, Provenance: draft.Provenance,
		Artifacts: draft.Artifacts,
	}
	if err := validateReportShape(runID, report); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	return report, nil
}

func validateReportShape(runID string, report Report) error {
	if report.SchemaVersion != SchemaVersion {
		return fmt.Errorf("evaluation report schema_version must be %q", SchemaVersion)
	}
	if report.Run.SchemaVersion != SchemaVersion || report.Provenance.SchemaVersion != SchemaVersion {
		return fmt.Errorf("evaluation report nested schema_version must be %q", SchemaVersion)
	}
	if report.Run.ID != runID || report.Run.ClientRequestID != runID {
		return fmt.Errorf("evaluation report run identity mismatch")
	}
	if !validChangeProfile(report.Run.ChangeProfile) {
		return fmt.Errorf("evaluation report change_profile is invalid")
	}
	if report.Provenance.TargetID != report.Run.TargetID || report.Provenance.Seed != report.Run.Seed {
		return fmt.Errorf("evaluation report provenance identity mismatch")
	}
	if report.Run.SuiteIDs == nil || report.Run.TrackIDs == nil || report.Tracks == nil ||
		report.Metrics == nil || report.Gates == nil || report.Recommendations == nil || report.Artifacts == nil {
		return fmt.Errorf("evaluation report required collections cannot be null")
	}
	for _, track := range report.Tracks {
		if track.Metrics == nil || track.Gates == nil {
			return fmt.Errorf("evaluation track report required collections cannot be null")
		}
		for _, gate := range track.Gates {
			if err := validateReportGate(gate, report.Run.ChangeProfile); err != nil {
				return err
			}
		}
	}
	if err := validateReportMetrics(report.Metrics, report.Run.TrackIDs); err != nil {
		return err
	}
	for _, gate := range report.Gates {
		if err := validateReportGate(gate, report.Run.ChangeProfile); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) Compare(baselineRunID, candidateRunID string) (Comparison, error) {
	release, acquireErr := s.acquireEvidenceRead()
	if acquireErr != nil {
		return Comparison{}, acquireErr
	}
	defer release()
	if ledgerErr := s.RequireCompleteRunLedger(); ledgerErr != nil {
		return Comparison{}, ledgerErr
	}
	if baselineRunID == candidateRunID {
		return Comparison{}, fmt.Errorf("%w: baseline and candidate runs must be distinct", ErrInvalid)
	}
	baseline, baselineErr := s.decodedReport(baselineRunID)
	if baselineErr != nil {
		return Comparison{}, baselineErr
	}
	candidate, candidateErr := s.decodedReport(candidateRunID)
	if candidateErr != nil {
		return Comparison{}, candidateErr
	}
	if baseline.Run.TargetID != candidate.Run.TargetID {
		baselineEvidence, err := s.loadCampaignRunEvidence(campaignEvidenceBinding{
			slotID: "g3", gateID: "G3", bindingRole: "baseline", runID: baselineRunID,
		}, nil)
		if err != nil {
			return Comparison{}, err
		}
		candidateEvidence, err := s.loadCampaignRunEvidence(campaignEvidenceBinding{
			slotID: "g3", gateID: "G3", bindingRole: "candidate", runID: candidateRunID,
			candidate: true,
		}, nil)
		if err != nil {
			return Comparison{}, err
		}
		return compareControlledPairReports(baselineEvidence, candidateEvidence)
	}
	if cohortErr := validatePairedReportCohort(baseline, candidate); cohortErr != nil {
		return Comparison{}, cohortErr
	}
	baselineRecords, baselineRecordsErr := s.loadPrivateComparisonRecords(baselineRunID)
	if baselineRecordsErr != nil {
		return Comparison{}, baselineRecordsErr
	}
	candidateRecords, candidateRecordsErr := s.loadPrivateComparisonRecords(candidateRunID)
	if candidateRecordsErr != nil {
		return Comparison{}, candidateRecordsErr
	}
	return comparePairedReports(baseline, candidate, baselineRecords, candidateRecords)
}

func (s *Service) OpenArtifact(runID, artifactID string) (*OpenedArtifact, error) {
	release, err := s.acquireEvidenceRead()
	if err != nil {
		return nil, err
	}
	defer release()
	report, err := s.decodedReport(runID)
	if err != nil {
		return nil, err
	}
	artifact, ok := findArtifact(report, artifactID)
	if !ok || strings.TrimSpace(artifact.URI) == "" {
		return nil, fmt.Errorf("%w: evaluation artifact", ErrNotFound)
	}
	contract, known := publicArtifactContracts[artifact.Name]
	if artifact.Name != artifact.URI || filepath.Base(artifact.URI) != artifact.URI || !known ||
		artifact.Kind != contract.Kind || artifact.MediaType != contract.MediaType ||
		!digestPattern.MatchString(artifact.Digest) || artifact.SizeBytes < 0 {
		return nil, fmt.Errorf("%w: evaluation artifact metadata is invalid", ErrInvalid)
	}
	if artifact.Name == "routing-traces.jsonl" {
		if traceErr := s.validateStoredRoutingTrace(runID); traceErr != nil {
			return nil, traceErr
		}
	}
	opened, err := s.store.OpenArtifact(runID, artifact.URI)
	if err != nil {
		return nil, err
	}
	if err := verifyOpenedArtifact(opened, artifact); err != nil {
		_ = opened.File.Close()
		return nil, err
	}
	if err := s.verifyPublicChecksum(runID, report, artifact); err != nil {
		_ = opened.File.Close()
		return nil, err
	}
	if err := s.rejectConfiguredSecretArtifact(opened.File, contract.MediaType); err != nil {
		_ = opened.File.Close()
		return nil, err
	}
	if _, err := opened.File.Seek(0, io.SeekStart); err != nil {
		_ = opened.File.Close()
		return nil, fmt.Errorf("rewind verified evaluation artifact: %w", err)
	}
	opened.MediaType = contract.MediaType
	return opened, nil
}

func verifyOpenedArtifact(opened *OpenedArtifact, artifact Artifact) error {
	if opened.Size != artifact.SizeBytes {
		return fmt.Errorf("%w: evaluation artifact size does not match its report metadata", ErrInvalid)
	}
	hash := sha256.New()
	written, err := io.Copy(hash, opened.File)
	if err != nil {
		return fmt.Errorf("verify evaluation artifact digest: %w", err)
	}
	if written != artifact.SizeBytes || fmt.Sprintf("sha256:%x", hash.Sum(nil)) != artifact.Digest {
		return fmt.Errorf("%w: evaluation artifact digest does not match its report metadata", ErrInvalid)
	}
	if _, err := opened.File.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind verified evaluation artifact: %w", err)
	}
	return nil
}

func (s *Service) verifyPublicChecksum(runID string, report Report, artifact Artifact) error {
	receipt, ok := findArtifactByName(report, publicChecksumArtifactName)
	if !ok || receipt.URI != publicChecksumArtifactName || !digestPattern.MatchString(receipt.Digest) || receipt.SizeBytes < 0 {
		return fmt.Errorf("%w: public artifact checksum receipt is unavailable", ErrInvalid)
	}
	opened, err := s.store.OpenArtifact(runID, receipt.URI)
	if err != nil {
		return err
	}
	defer func() { _ = opened.File.Close() }()
	if verifyErr := verifyOpenedArtifact(opened, receipt); verifyErr != nil {
		return verifyErr
	}
	if opened.Size > 4*1024*1024 {
		return fmt.Errorf("%w: public artifact checksum receipt is too large", ErrInvalid)
	}
	data, err := io.ReadAll(opened.File)
	if err != nil {
		return fmt.Errorf("read public artifact checksum receipt: %w", err)
	}
	checksums, err := parsePublicChecksumReceipt(data)
	if err != nil {
		return err
	}
	expected := make(map[string]string)
	for _, reported := range reportArtifacts(report) {
		if _, known := publicArtifactContracts[reported.Name]; reported.Name != reported.URI || !known ||
			!digestPattern.MatchString(reported.Digest) || reported.SizeBytes < 0 {
			return fmt.Errorf("%w: report contains an invalid public artifact", ErrInvalid)
		}
		if reported.Name == publicChecksumArtifactName {
			continue
		}
		if _, duplicate := expected[reported.Name]; duplicate {
			return fmt.Errorf("%w: report contains duplicate public artifacts", ErrInvalid)
		}
		expected[reported.Name] = strings.TrimPrefix(reported.Digest, "sha256:")
	}
	if len(checksums) != len(expected) {
		return fmt.Errorf("%w: public artifact checksum receipt set does not match the report", ErrInvalid)
	}
	for name, digest := range expected {
		if checksums[name] != digest {
			return fmt.Errorf("%w: public artifact checksum receipt does not match the report", ErrInvalid)
		}
	}
	if artifact.Name != publicChecksumArtifactName && checksums[artifact.Name] != strings.TrimPrefix(artifact.Digest, "sha256:") {
		return fmt.Errorf("%w: evaluation artifact is absent from the public checksum receipt", ErrInvalid)
	}
	return nil
}

func parsePublicChecksumReceipt(data []byte) (map[string]string, error) {
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return nil, fmt.Errorf("%w: public artifact checksum receipt is invalid", ErrInvalid)
	}
	checksums := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		digest, name, found := strings.Cut(line, "  ")
		_, known := publicArtifactContracts[name]
		if !found || !digestPattern.MatchString("sha256:"+digest) ||
			!known || name == publicChecksumArtifactName || checksums[name] != "" {
			return nil, fmt.Errorf("%w: public artifact checksum receipt is invalid", ErrInvalid)
		}
		checksums[name] = digest
	}
	return checksums, nil
}

func reportArtifacts(report Report) []Artifact {
	artifacts := append([]Artifact(nil), report.Artifacts...)
	for _, track := range report.Tracks {
		artifacts = append(artifacts, track.Artifacts...)
	}
	return artifacts
}

func (s *Service) decodedReport(runID string) (Report, error) {
	data, err := s.reportJSONVerified(runID)
	if err != nil {
		return Report{}, err
	}
	var report Report
	if err := json.Unmarshal(data, &report); err != nil {
		return Report{}, fmt.Errorf("decode evaluation report: %w", err)
	}
	return report, nil
}

func findArtifact(report Report, artifactID string) (Artifact, bool) {
	for _, artifact := range report.Artifacts {
		if artifact.ID == artifactID {
			return artifact, true
		}
	}
	for _, track := range report.Tracks {
		for _, artifact := range track.Artifacts {
			if artifact.ID == artifactID {
				return artifact, true
			}
		}
	}
	return Artifact{}, false
}

func findArtifactByName(report Report, name string) (Artifact, bool) {
	for _, artifact := range report.Artifacts {
		if artifact.Name == name {
			return artifact, true
		}
	}
	for _, track := range report.Tracks {
		for _, artifact := range track.Artifacts {
			if artifact.Name == name {
				return artifact, true
			}
		}
	}
	return Artifact{}, false
}

func validMetricDirection(direction string) bool {
	switch direction {
	case "", "higher_is_better", "lower_is_better", "target":
		return true
	default:
		return false
	}
}

func validateReportGate(gate Gate, profile ChangeProfile) error {
	if gate.ChangeProfile != profile {
		return fmt.Errorf("evaluation gate %q change_profile does not match its run", gate.ID)
	}
	if gate.ContractVersion != GateContractVersion {
		return fmt.Errorf("evaluation gate %q contract_version must be %q", gate.ID, GateContractVersion)
	}
	if len(gate.EvidenceRefs) == 0 {
		return fmt.Errorf("evaluation gate %q evidence_refs must contain at least one reference", gate.ID)
	}
	for _, ref := range gate.EvidenceRefs {
		if strings.TrimSpace(ref) == "" {
			return fmt.Errorf("evaluation gate %q evidence_refs must be non-empty", gate.ID)
		}
	}
	if gate.SampleCount != nil && *gate.SampleCount < 0 {
		return fmt.Errorf("evaluation gate %q sample_count cannot be negative", gate.ID)
	}
	if gate.Coverage != nil && (gate.Coverage.Evaluated < 0 || gate.Coverage.Total < 0 ||
		gate.Coverage.Unavailable < 0 || gate.Coverage.Fraction < 0 || gate.Coverage.Fraction > 1) {
		return fmt.Errorf("evaluation gate %q coverage is invalid", gate.ID)
	}
	switch gate.Disposition {
	case "required", "advisory", "not_applicable", "waived":
	default:
		return fmt.Errorf("evaluation gate %q disposition is invalid", gate.ID)
	}
	switch gate.Verdict {
	case "pass", "fail", "unavailable", "waived", "not_applicable":
	default:
		return fmt.Errorf("evaluation gate %q verdict is invalid", gate.ID)
	}
	return nil
}
