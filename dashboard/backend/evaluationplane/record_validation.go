package evaluationplane

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	maxCaseLineBytes   = 16 * 1024 * 1024
	maxRecordLineBytes = 256 * 1024
	maxRecordsPerRun   = 1_000_000
)

var evidenceIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type recordStatusCounts struct {
	Succeeded   int
	Failed      int
	Unavailable int
}

func (counts recordStatusCounts) total() int {
	return counts.Succeeded + counts.Failed + counts.Unavailable
}

type recordAttestation struct {
	validated               bool
	Total                   int
	Succeeded               int
	Failed                  int
	Unavailable             int
	ByTrack                 map[TrackID]recordStatusCounts
	CaseIDs                 map[string]struct{}
	CaseModalities          map[string]string
	CaseTrackIDs            map[string][]TrackID
	PlannedCaseIDsByTrack   map[TrackID]map[string]struct{}
	EvaluatedCaseIDsByTrack map[TrackID]map[string]struct{}
	CellEvidence            map[TrackID]map[string]*recordCellAttestation
	Metrics                 recordMetricAttestation
	Costs                   recordCostAttestation
	Methods                 methodRecordAttestation
}

type recordCellAttestation struct {
	Rows          int
	Unavailable   bool
	EvidenceKinds map[string]struct{}
}

func (attestation recordAttestation) validatesGateCoverage(gate Gate) bool {
	if !attestation.validated || gate.SampleCount == nil || gate.Coverage == nil {
		return false
	}
	return validatesGatePlanCoverage(gate, attestation.expectedSummaryCoverage())
}

func (attestation recordAttestation) validatesTrackGateCoverage(gate Gate) bool {
	if !attestation.validated || gate.TrackID == "" || gate.SampleCount == nil || gate.Coverage == nil {
		return false
	}
	return validatesGatePlanCoverage(gate, attestation.expectedTrackCoverage(gate.TrackID))
}

func validatesGatePlanCoverage(gate Gate, expected Coverage) bool {
	return *gate.SampleCount == expected.Evaluated &&
		gate.Coverage.Evaluated == expected.Evaluated &&
		gate.Coverage.Total == expected.Total &&
		gate.Coverage.Unavailable == expected.Unavailable &&
		finiteFloat(gate.Coverage.Fraction) && reducedFloatsEqual(gate.Coverage.Fraction, expected.Fraction) &&
		gate.Coverage.ConfidenceLevel == 0 && gate.Coverage.ConfidenceInterval == nil
}

type visibleCaseSet struct {
	IDs            map[string]struct{}
	Modalities     map[string]string
	TrackIDsByCase map[string][]TrackID
	CaseIDsByTrack map[TrackID]map[string]struct{}
}

func (attestation recordAttestation) expectedTrackCoverage(trackID TrackID) Coverage {
	total := len(attestation.PlannedCaseIDsByTrack[trackID])
	evaluated := len(attestation.EvaluatedCaseIDsByTrack[trackID])
	return serverCoverage(evaluated, total)
}

func (attestation recordAttestation) expectedSummaryCoverage() Coverage {
	evaluated := 0
	total := 0
	for trackID, plannedCaseIDs := range attestation.PlannedCaseIDsByTrack {
		evaluated += len(attestation.EvaluatedCaseIDsByTrack[trackID])
		total += len(plannedCaseIDs)
	}
	return serverCoverage(evaluated, total)
}

func serverCoverage(evaluated, total int) Coverage {
	fraction := 0.0
	if total > 0 {
		fraction = float64(evaluated) / float64(total)
	}
	coverage := Coverage{
		Evaluated: evaluated, Total: total, Fraction: fraction,
		Unavailable: total - evaluated,
	}
	if total > 0 {
		coverage.ConfidenceLevel = 0.95
		coverage.ConfidenceInterval = serverWilsonInterval(evaluated, total)
	}
	return coverage
}

type visibleCaseIdentity struct {
	SchemaVersion string           `json:"schema_version"`
	ID            string           `json:"id"`
	TrackIDs      []TrackID        `json:"track_ids"`
	Messages      []visibleMessage `json:"messages"`
	Modality      string           `json:"modality"`
	Tags          []string         `json:"tags"`
	TrajectoryID  *string          `json:"trajectory_id,omitempty"`
}

type visibleMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Name       *string         `json:"name,omitempty"`
	ToolCallID *string         `json:"tool_call_id,omitempty"`
}

type textContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type imageURL struct {
	URL    string  `json:"url"`
	Detail *string `json:"detail,omitempty"`
}

type imageContentPart struct {
	Type     string   `json:"type"`
	ImageURL imageURL `json:"image_url"`
}

type executionRecordEvidence struct {
	SchemaVersion        string                              `json:"schema_version"`
	ID                   string                              `json:"id"`
	TrackID              TrackID                             `json:"track_id"`
	CaseID               string                              `json:"case_id"`
	AttemptID            string                              `json:"attempt_id"`
	Status               string                              `json:"status"`
	ArmID                *string                             `json:"arm_id,omitempty"`
	SelectedArmID        *string                             `json:"selected_arm_id,omitempty"`
	SelectionStatus      *string                             `json:"selection_status,omitempty"`
	SelectionMethod      *string                             `json:"selection_method,omitempty"`
	Recipe               *string                             `json:"recipe,omitempty"`
	DecisionName         *string                             `json:"decision_name,omitempty"`
	Algorithm            *string                             `json:"algorithm,omitempty"`
	TraceDigest          *string                             `json:"trace_digest,omitempty"`
	Success              *bool                               `json:"success,omitempty"`
	Quality              *float64                            `json:"quality,omitempty"`
	Fallback             *bool                               `json:"fallback,omitempty"`
	LatencyMS            *float64                            `json:"latency_ms,omitempty"`
	InputTokens          *int64                              `json:"input_tokens,omitempty"`
	OutputTokens         *int64                              `json:"output_tokens,omitempty"`
	RuntimeCost          *float64                            `json:"runtime_cost,omitempty"`
	EvaluationCost       *float64                            `json:"evaluation_cost,omitempty"`
	CapacityTCO          *float64                            `json:"capacity_tco,omitempty"`
	TrajectorySteps      *int64                              `json:"trajectory_steps,omitempty"`
	ToolCalls            *int64                              `json:"tool_calls,omitempty"`
	InvalidToolCalls     *int64                              `json:"invalid_tool_calls,omitempty"`
	Modality             *string                             `json:"modality,omitempty"`
	PrivacyViolations    *int64                              `json:"privacy_violations,omitempty"`
	PreferenceMatch      *bool                               `json:"preference_match,omitempty"`
	BehaviorPropensity   *float64                            `json:"behavior_propensity,omitempty"`
	Robustness           *robustnessMethodEvidence           `json:"robustness,omitempty"`
	AgentTask            *agentTaskMethodEvidence            `json:"agent_task,omitempty"`
	Recovery             *recoveryMethodEvidence             `json:"recovery,omitempty"`
	ProductionExperiment *productionExperimentMethodEvidence `json:"production_experiment,omitempty"`
	OnlinePreference     *onlinePreferenceMethodEvidence     `json:"online_preference,omitempty"`
	HardPolicy           *hardPolicyMethodEvidence           `json:"hard_policy,omitempty"`
	SafetyViolations     *int64                              `json:"safety_violations,omitempty"`
	ShouldBlock          *bool                               `json:"should_block,omitempty"`
	Blocked              *bool                               `json:"blocked,omitempty"`
	Concurrency          *int64                              `json:"concurrency,omitempty"`
	ThroughputRPS        *float64                            `json:"throughput_rps,omitempty"`
	GPUSeconds           *float64                            `json:"gpu_seconds,omitempty"`
	EnergyKWh            *float64                            `json:"energy_kwh,omitempty"`
	LoadElapsedSeconds   *float64                            `json:"load_elapsed_seconds,omitempty"`
	LoadPhase            *string                             `json:"load_phase,omitempty"`
	LoadRepetition       *int64                              `json:"load_repetition,omitempty"`
	LoadRequestIndex     *int64                              `json:"load_request_index,omitempty"`
	Grader               *string                             `json:"grader,omitempty"`
	EvidenceKind         *string                             `json:"evidence_kind,omitempty"`
	BrokerReceipt        *string                             `json:"broker_receipt,omitempty"`
	Error                *string                             `json:"error,omitempty"`
}

type failureTrackSummary struct {
	TrackID     TrackID `json:"track_id"`
	Succeeded   int     `json:"succeeded"`
	Failed      int     `json:"failed"`
	Unavailable int     `json:"unavailable"`
}

type failureSummaryEvidence struct {
	SchemaVersion string                `json:"schema_version"`
	TotalRecords  int                   `json:"total_records"`
	Failed        int                   `json:"failed"`
	Unavailable   int                   `json:"unavailable"`
	ByTrack       []failureTrackSummary `json:"by_track"`
}

type recordSemanticKey struct {
	TrackID       TrackID
	CaseID        string
	AttemptID     string
	ArmID         string
	SelectedArmID string
}

func validateRecordsAndFailureSummary(
	runDir string,
	manifest RunManifest,
	executor executorContract,
) (recordAttestation, error) {
	caseLimit, err := manifestVisibleCaseLimit(manifest, executor)
	if err != nil {
		return recordAttestation{}, err
	}
	cases, err := validateVisibleCaseSet(filepath.Join(runDir, "cases.jsonl"), caseLimit, manifest.TrackIDs)
	if err != nil {
		return recordAttestation{}, err
	}
	attestation, err := validateExecutionRecords(filepath.Join(runDir, "records.jsonl"), manifest.TrackIDs, cases, executor)
	if err != nil {
		return recordAttestation{}, err
	}
	if err := validateMethodSnapshotBindings(attestation.Methods, manifest); err != nil {
		return recordAttestation{}, err
	}
	if executor.ID == normalizedSuiteLiveExecutorID && attestation.Methods.Robustness.PairCount > 0 {
		qualified, qualificationErr := validateLiveDeclaredShiftRecords(
			runDir, manifest, attestation.Methods.Robustness,
		)
		if qualificationErr != nil {
			return recordAttestation{}, qualificationErr
		}
		attestation.Methods.Robustness = qualified
	}
	if err := validateFailureSummaryAgainstRecords(filepath.Join(runDir, "failure-summary.json"), attestation); err != nil {
		return recordAttestation{}, err
	}
	attestation.validated = true
	attestation.CaseIDs = cases.IDs
	attestation.CaseModalities = cases.Modalities
	attestation.CaseTrackIDs = cases.TrackIDsByCase
	return attestation, nil
}

func manifestVisibleCaseLimit(manifest RunManifest, executor executorContract) (int, error) {
	if !executor.CaseBudgetPerSuite {
		return manifest.SampleLimit, nil
	}
	if manifest.SampleLimit < 1 || len(manifest.SuiteIDs) == 0 || len(manifest.SuiteIDs) > maxRecordsPerRun/manifest.SampleLimit {
		return 0, fmt.Errorf("%w: normalized suite case budget is invalid", ErrInvalid)
	}
	return manifest.SampleLimit * len(manifest.SuiteIDs), nil
}

func validateVisibleCases(path string, caseLimit int, selectedTrackIDs []TrackID) (map[string]struct{}, error) {
	cases, err := validateVisibleCaseSet(path, caseLimit, selectedTrackIDs)
	return cases.IDs, err
}

func validateVisibleCaseSet(path string, caseLimit int, selectedTrackIDs []TrackID) (visibleCaseSet, error) {
	if caseLimit < 1 || caseLimit > maxRecordsPerRun {
		return visibleCaseSet{}, fmt.Errorf("%w: run manifest case limit is invalid", ErrInvalid)
	}
	if len(selectedTrackIDs) == 0 || !canonicalTrackOrder(selectedTrackIDs) {
		return visibleCaseSet{}, fmt.Errorf("%w: run manifest track plan is invalid", ErrInvalid)
	}
	selected := make(map[TrackID]struct{}, len(selectedTrackIDs))
	for _, trackID := range selectedTrackIDs {
		selected[trackID] = struct{}{}
	}
	cases := visibleCaseSet{
		IDs: make(map[string]struct{}), Modalities: make(map[string]string),
		TrackIDsByCase: make(map[string][]TrackID), CaseIDsByTrack: make(map[TrackID]map[string]struct{}, len(selectedTrackIDs)),
	}
	for _, trackID := range selectedTrackIDs {
		cases.CaseIDsByTrack[trackID] = make(map[string]struct{})
	}
	err := scanEvidenceJSONLines(path, maxWorkerArtifactBytes, maxCaseLineBytes, caseLimit, func(line []byte, lineNumber int) error {
		var identity visibleCaseIdentity
		if err := decodeStrictJSONLine(line, &identity); err != nil {
			return fmt.Errorf("%w: cases.jsonl line %d is invalid: %w", ErrInvalid, lineNumber, err)
		}
		if identity.SchemaVersion != SchemaVersion || !evidenceIDPattern.MatchString(identity.ID) || len(identity.TrackIDs) == 0 ||
			!canonicalTrackOrder(identity.TrackIDs) || len(identity.Messages) == 0 || !validCaseModality(identity.Modality) {
			return fmt.Errorf("%w: cases.jsonl line %d violates the visible case contract", ErrInvalid, lineNumber)
		}
		for _, trackID := range identity.TrackIDs {
			if _, planned := selected[trackID]; !planned {
				return fmt.Errorf("%w: cases.jsonl line %d plans unselected track %q", ErrInvalid, lineNumber, trackID)
			}
			if identity.Modality == "text" && trackID == "multimodal" {
				return fmt.Errorf("%w: cases.jsonl line %d plans multimodal evidence for a text case", ErrInvalid, lineNumber)
			}
		}
		for index, message := range identity.Messages {
			if err := validateVisibleMessage(message); err != nil {
				return fmt.Errorf("%w: cases.jsonl line %d message %d is invalid: %w", ErrInvalid, lineNumber, index+1, err)
			}
		}
		if _, duplicate := cases.IDs[identity.ID]; duplicate {
			return fmt.Errorf("%w: cases.jsonl contains duplicate case id %q", ErrInvalid, identity.ID)
		}
		cases.IDs[identity.ID] = struct{}{}
		cases.Modalities[identity.ID] = identity.Modality
		cases.TrackIDsByCase[identity.ID] = append([]TrackID(nil), identity.TrackIDs...)
		for _, trackID := range identity.TrackIDs {
			cases.CaseIDsByTrack[trackID][identity.ID] = struct{}{}
		}
		return nil
	})
	if err != nil {
		return visibleCaseSet{}, err
	}
	for _, trackID := range selectedTrackIDs {
		if len(cases.CaseIDsByTrack[trackID]) == 0 {
			return visibleCaseSet{}, fmt.Errorf("%w: selected track %q has no planned visible case", ErrInvalid, trackID)
		}
	}
	return cases, nil
}

func validateVisibleMessage(message visibleMessage) error {
	switch message.Role {
	case "system", "user", "assistant", "tool":
	default:
		return fmt.Errorf("role %q is unsupported", message.Role)
	}
	if len(message.Content) == 0 || bytes.Equal(bytes.TrimSpace(message.Content), []byte("null")) {
		return fmt.Errorf("content is required")
	}
	var text string
	if err := json.Unmarshal(message.Content, &text); err == nil {
		if strings.TrimSpace(text) == "" {
			return fmt.Errorf("string content must be non-empty")
		}
		return nil
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(message.Content, &parts); err != nil {
		return fmt.Errorf("content must be a string or typed content-part array")
	}
	if len(parts) == 0 {
		return fmt.Errorf("content-part array must be non-empty")
	}
	for index, raw := range parts {
		var header struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			return fmt.Errorf("content part %d is not an object", index+1)
		}
		switch header.Type {
		case "text":
			var part textContentPart
			if err := decodeStrictJSONLine(raw, &part); err != nil || part.Type != "text" || strings.TrimSpace(part.Text) == "" {
				return fmt.Errorf("content part %d violates the text contract", index+1)
			}
		case "image_url":
			var part imageContentPart
			if err := decodeStrictJSONLine(raw, &part); err != nil || part.Type != "image_url" || strings.TrimSpace(part.ImageURL.URL) == "" {
				return fmt.Errorf("content part %d violates the image_url contract", index+1)
			}
			if part.ImageURL.Detail != nil && *part.ImageURL.Detail != "auto" && *part.ImageURL.Detail != "low" && *part.ImageURL.Detail != "high" {
				return fmt.Errorf("content part %d has an invalid image detail", index+1)
			}
		default:
			return fmt.Errorf("content part %d has unsupported type %q", index+1, header.Type)
		}
	}
	return nil
}

func validCaseModality(modality string) bool {
	switch modality {
	case "text", "image", "document", "audio", "video":
		return true
	default:
		return false
	}
}

func validateExecutionRecords(
	path string,
	selectedTracks []TrackID,
	cases visibleCaseSet,
	executor executorContract,
) (recordAttestation, error) {
	state := newRecordValidationState(selectedTracks, cases, executor)
	err := scanEvidenceJSONLines(
		path,
		maxWorkerArtifactBytes,
		maxRecordLineBytes,
		maxRecordsPerRun,
		state.observe,
	)
	if err != nil {
		return recordAttestation{}, err
	}
	return state.finish(selectedTracks)
}

type recordValidationState struct {
	selected       map[TrackID]bool
	cases          visibleCaseSet
	executor       executorContract
	attestation    recordAttestation
	metricReducer  *recordMetricReducer
	methodReducer  *methodRecordReducer
	costReducer    recordCostReducer
	recordIDs      map[string]struct{}
	semanticRecord map[recordSemanticKey]string
}

func newRecordValidationState(
	selectedTracks []TrackID,
	cases visibleCaseSet,
	executor executorContract,
) *recordValidationState {
	selected := make(map[TrackID]bool, len(selectedTracks))
	plannedCaseIDs := make(map[TrackID]map[string]struct{}, len(selectedTracks))
	evaluatedCaseIDs := make(map[TrackID]map[string]struct{}, len(selectedTracks))
	for _, trackID := range selectedTracks {
		selected[trackID] = true
		plan := cases.CaseIDsByTrack[trackID]
		plannedCaseIDs[trackID] = make(map[string]struct{}, len(plan))
		for caseID := range plan {
			plannedCaseIDs[trackID][caseID] = struct{}{}
		}
		evaluatedCaseIDs[trackID] = make(map[string]struct{})
	}
	attestation := recordAttestation{
		ByTrack:               make(map[TrackID]recordStatusCounts, len(selectedTracks)),
		PlannedCaseIDsByTrack: plannedCaseIDs, EvaluatedCaseIDsByTrack: evaluatedCaseIDs,
		CellEvidence: make(map[TrackID]map[string]*recordCellAttestation, len(selectedTracks)),
	}
	for _, trackID := range selectedTracks {
		attestation.CellEvidence[trackID] = make(map[string]*recordCellAttestation, len(plannedCaseIDs[trackID]))
		for caseID := range plannedCaseIDs[trackID] {
			attestation.CellEvidence[trackID][caseID] = &recordCellAttestation{EvidenceKinds: make(map[string]struct{})}
		}
	}
	return &recordValidationState{
		selected: selected, cases: cases, executor: executor, attestation: attestation,
		metricReducer: newRecordMetricReducer(), methodReducer: newMethodRecordReducer(),
		recordIDs: make(map[string]struct{}), semanticRecord: make(map[recordSemanticKey]string),
	}
}

func (state *recordValidationState) observe(line []byte, lineNumber int) error {
	var record executionRecordEvidence
	if err := decodeStrictJSONLine(line, &record); err != nil {
		return fmt.Errorf("%w: records.jsonl line %d is invalid: %w", ErrInvalid, lineNumber, err)
	}
	if err := validateExecutionRecord(record, state.selected, state.cases.IDs, state.executor); err != nil {
		return fmt.Errorf("%w: records.jsonl line %d: %w", ErrInvalid, lineNumber, err)
	}
	cell, planned := state.attestation.CellEvidence[record.TrackID][record.CaseID]
	if !planned {
		return fmt.Errorf("%w: records.jsonl line %d: case-track cell is not present in the explicit visible plan", ErrInvalid, lineNumber)
	}
	if _, duplicate := state.recordIDs[record.ID]; duplicate {
		return fmt.Errorf("%w: records.jsonl contains duplicate record id %q", ErrInvalid, record.ID)
	}
	semanticKey := record.semanticKey()
	if priorID, duplicate := state.semanticRecord[semanticKey]; duplicate {
		return fmt.Errorf("%w: records.jsonl record %q duplicates semantic attempt %q", ErrInvalid, record.ID, priorID)
	}
	state.recordIDs[record.ID] = struct{}{}
	state.semanticRecord[semanticKey] = record.ID
	cell.Rows++
	cell.Unavailable = cell.Unavailable || record.Status == "unavailable"
	evidenceKind := ""
	if record.EvidenceKind != nil {
		evidenceKind = *record.EvidenceKind
	}
	cell.EvidenceKinds[evidenceKind] = struct{}{}
	if err := state.metricReducer.observe(record); err != nil {
		return fmt.Errorf("%w: records.jsonl line %d cannot be reduced: %w", ErrInvalid, lineNumber, err)
	}
	if err := state.methodReducer.observe(record); err != nil {
		return fmt.Errorf("%w: records.jsonl line %d method evidence cannot be reduced: %w", ErrInvalid, lineNumber, err)
	}
	if err := state.costReducer.observe(record); err != nil {
		return fmt.Errorf("%w: records.jsonl line %d costs cannot be reduced: %w", ErrInvalid, lineNumber, err)
	}
	counts := state.attestation.ByTrack[record.TrackID]
	switch record.Status {
	case "succeeded":
		counts.Succeeded++
		state.attestation.Succeeded++
	case "failed":
		counts.Failed++
		state.attestation.Failed++
	case "unavailable":
		counts.Unavailable++
		state.attestation.Unavailable++
	}
	if record.Status != "unavailable" {
		state.attestation.EvaluatedCaseIDsByTrack[record.TrackID][record.CaseID] = struct{}{}
	}
	state.attestation.ByTrack[record.TrackID] = counts
	state.attestation.Total++
	return nil
}

func (state *recordValidationState) finish(selectedTracks []TrackID) (recordAttestation, error) {
	metrics, err := state.metricReducer.finalize()
	if err != nil {
		return recordAttestation{}, fmt.Errorf("%w: records.jsonl metric reduction failed: %w", ErrInvalid, err)
	}
	state.attestation.Metrics = metrics
	methods, err := state.methodReducer.finalize()
	if err != nil {
		return recordAttestation{}, fmt.Errorf("%w: records.jsonl method reduction failed: %w", ErrInvalid, err)
	}
	state.attestation.Methods = methods
	state.attestation.Costs = state.costReducer.finalize()
	for _, trackID := range selectedTracks {
		for caseID, cell := range state.attestation.CellEvidence[trackID] {
			if cell.Rows == 0 {
				return recordAttestation{}, fmt.Errorf("%w: records.jsonl omits planned case-track cell %q/%q", ErrInvalid, caseID, trackID)
			}
		}
	}
	return state.attestation, nil
}

func (record executionRecordEvidence) semanticKey() recordSemanticKey {
	key := recordSemanticKey{TrackID: record.TrackID, CaseID: record.CaseID, AttemptID: record.AttemptID}
	if record.ArmID != nil {
		key.ArmID = *record.ArmID
	}
	if record.SelectedArmID != nil {
		key.SelectedArmID = *record.SelectedArmID
	}
	return key
}

func validateExecutionRecord(
	record executionRecordEvidence,
	selectedTracks map[TrackID]bool,
	caseIDs map[string]struct{},
	executor executorContract,
) error {
	if record.SchemaVersion != SchemaVersion {
		return fmt.Errorf("schema_version must be %q", SchemaVersion)
	}
	if !evidenceIDPattern.MatchString(record.ID) || !evidenceIDPattern.MatchString(record.CaseID) || !evidenceIDPattern.MatchString(record.AttemptID) {
		return fmt.Errorf("record id, case_id, and attempt_id must be portable non-empty identities")
	}
	if !selectedTracks[record.TrackID] {
		return fmt.Errorf("track_id %q is not selected by the immutable manifest", record.TrackID)
	}
	if _, ok := caseIDs[record.CaseID]; !ok {
		return fmt.Errorf("case_id %q is absent from the validated case set", record.CaseID)
	}
	if record.Status != "succeeded" && record.Status != "failed" && record.Status != "unavailable" {
		return fmt.Errorf("status %q is invalid", record.Status)
	}
	if record.TraceDigest != nil && !digestPattern.MatchString(*record.TraceDigest) {
		return fmt.Errorf("trace_digest is invalid")
	}
	if record.BrokerReceipt != nil && !digestPattern.MatchString(*record.BrokerReceipt) {
		return fmt.Errorf("broker_receipt is invalid")
	}
	for _, identity := range []*string{record.ArmID, record.SelectedArmID} {
		if identity != nil && (strings.TrimSpace(*identity) == "" || len(*identity) > 512) {
			return fmt.Errorf("arm identities must be non-empty and bounded")
		}
	}
	if err := validateRecordNumbers(record); err != nil {
		return err
	}
	if err := validateCapacityLoadCoordinates(record); err != nil {
		return err
	}
	if err := validateMethodRecord(record, executor); err != nil {
		return err
	}
	return validateNormalizedReplayDiagnosticRecord(record, executor)
}

func validateCapacityLoadCoordinates(record executionRecordEvidence) error {
	present := 0
	if record.LoadPhase != nil {
		present++
	}
	if record.LoadRepetition != nil {
		present++
	}
	if record.LoadRequestIndex != nil {
		present++
	}
	if record.TrackID != "capacity" {
		if present != 0 {
			return fmt.Errorf("load coordinates are valid only for capacity rows")
		}
		return nil
	}
	if present == 0 {
		return nil
	}
	if present != 3 || record.Concurrency == nil || record.ThroughputRPS == nil ||
		record.LoadElapsedSeconds == nil || record.Success == nil || record.LatencyMS == nil {
		return fmt.Errorf("capacity load coordinates and observations must be complete")
	}
	if *record.LoadPhase != "warmup" && *record.LoadPhase != "measurement" {
		return fmt.Errorf("capacity load_phase is invalid")
	}
	if *record.LoadRepetition < 0 || *record.LoadRequestIndex < 0 {
		return fmt.Errorf("capacity load repetition and request index must be non-negative")
	}
	if (*record.LoadPhase == "warmup" && *record.LoadRepetition != 0) ||
		(*record.LoadPhase == "measurement" && *record.LoadRepetition == 0) {
		return fmt.Errorf("capacity load phase and repetition disagree")
	}
	return nil
}

func validateRecordNumbers(record executionRecordEvidence) error {
	for _, field := range []struct {
		name  string
		value *float64
	}{
		{"latency_ms", record.LatencyMS},
		{"runtime_cost", record.RuntimeCost},
		{"evaluation_cost", record.EvaluationCost},
		{"capacity_tco", record.CapacityTCO},
		{"throughput_rps", record.ThroughputRPS},
		{"gpu_seconds", record.GPUSeconds},
		{"energy_kwh", record.EnergyKWh},
		{"load_elapsed_seconds", record.LoadElapsedSeconds},
	} {
		if field.value != nil && (!finiteFloat(*field.value) || *field.value < 0) {
			return fmt.Errorf("%s must be finite and non-negative", field.name)
		}
	}
	if record.Quality != nil && (!finiteFloat(*record.Quality) || *record.Quality < 0 || *record.Quality > 1) {
		return fmt.Errorf("quality must be a finite fraction")
	}
	if record.BehaviorPropensity != nil && (!finiteFloat(*record.BehaviorPropensity) || *record.BehaviorPropensity <= 0 || *record.BehaviorPropensity > 1) {
		return fmt.Errorf("behavior_propensity must be a finite positive fraction")
	}
	for _, field := range []struct {
		name  string
		value *int64
	}{
		{"input_tokens", record.InputTokens},
		{"output_tokens", record.OutputTokens},
		{"trajectory_steps", record.TrajectorySteps},
		{"tool_calls", record.ToolCalls},
		{"invalid_tool_calls", record.InvalidToolCalls},
		{"privacy_violations", record.PrivacyViolations},
		{"safety_violations", record.SafetyViolations},
	} {
		if field.value != nil && *field.value < 0 {
			return fmt.Errorf("%s must be non-negative", field.name)
		}
	}
	if record.Concurrency != nil && *record.Concurrency < 1 {
		return fmt.Errorf("concurrency must be positive")
	}
	return nil
}

func validateFailureSummaryAgainstRecords(path string, attestation recordAttestation) error {
	var summary failureSummaryEvidence
	if err := decodeStrictEvidence(path, &summary); err != nil {
		return err
	}
	if summary.SchemaVersion != SchemaVersion || summary.TotalRecords != attestation.Total ||
		summary.Failed != attestation.Failed || summary.Unavailable != attestation.Unavailable {
		return fmt.Errorf("%w: failure-summary.json does not match validated records", ErrInvalid)
	}
	trackIDs := make([]string, 0, len(attestation.ByTrack))
	for trackID := range attestation.ByTrack {
		trackIDs = append(trackIDs, string(trackID))
	}
	sort.Strings(trackIDs)
	if len(summary.ByTrack) != len(trackIDs) {
		return fmt.Errorf("%w: failure-summary.json track set does not match validated records", ErrInvalid)
	}
	for index, trackID := range trackIDs {
		counts := attestation.ByTrack[TrackID(trackID)]
		actual := summary.ByTrack[index]
		if actual.TrackID != TrackID(trackID) || actual.Succeeded != counts.Succeeded ||
			actual.Failed != counts.Failed || actual.Unavailable != counts.Unavailable {
			return fmt.Errorf("%w: failure-summary.json track counts do not match validated records", ErrInvalid)
		}
	}
	return nil
}

func scanEvidenceJSONLines(path string, maxBytes int64, maxLineBytes, maxLines int, visit func([]byte, int) error) error {
	file, err := openBundleFile(path, os.O_RDONLY)
	if err != nil {
		return fmt.Errorf("open evidence file %s: %w", filepath.Base(path), err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat evidence file %s: %w", filepath.Base(path), err)
	}
	if info.Size() < 1 || info.Size() > maxBytes {
		return fmt.Errorf("%w: evidence file %s violates its total-byte limit", ErrInvalid, filepath.Base(path))
	}
	if _, err := file.Seek(-1, io.SeekEnd); err != nil {
		return fmt.Errorf("inspect evidence file %s: %w", filepath.Base(path), err)
	}
	var ending [1]byte
	if _, err := io.ReadFull(file, ending[:]); err != nil || ending[0] != '\n' {
		return fmt.Errorf("%w: evidence file %s must end with a newline", ErrInvalid, filepath.Base(path))
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind evidence file %s: %w", filepath.Base(path), err)
	}
	initialBuffer := maxLineBytes + 1
	if initialBuffer > 64*1024 {
		initialBuffer = 64 * 1024
	}
	scanner := bufio.NewScanner(io.LimitReader(file, maxBytes+1))
	scanner.Buffer(make([]byte, initialBuffer), maxLineBytes+1)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := scanner.Bytes()
		if lineNumber > maxLines {
			return fmt.Errorf("%w: evidence file %s exceeds its line-count limit", ErrInvalid, filepath.Base(path))
		}
		if len(line) == 0 || len(line) > maxLineBytes {
			return fmt.Errorf("%w: evidence file %s line %d violates its line-byte limit", ErrInvalid, filepath.Base(path), lineNumber)
		}
		if err := visit(line, lineNumber); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("%w: scan evidence file %s: %w", ErrInvalid, filepath.Base(path), err)
	}
	if lineNumber == 0 {
		return fmt.Errorf("%w: evidence file %s must contain at least one row", ErrInvalid, filepath.Base(path))
	}
	return nil
}

func decodeStrictJSONLine(line []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}
