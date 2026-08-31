package evaluationplane

import (
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type gradingCaseEvidence struct {
	SchemaVersion  string   `json:"schema_version"`
	CaseID         string   `json:"case_id"`
	ExpectedRoute  *string  `json:"expected_route,omitempty"`
	ExpectedAnswer *string  `json:"expected_answer,omitempty"`
	PreferredArmID *string  `json:"preferred_arm_id,omitempty"`
	ExpectedTools  []string `json:"expected_tools"`
	ShouldBlock    *bool    `json:"should_block,omitempty"`
	Weight         float64  `json:"weight"`
}

func (s *Service) persistExecutionAttestation(
	runID string,
	transcript *brokerExecutionTranscript,
) (string, error) {
	var digest string
	err := s.store.withEvidencePublication(func() error {
		var persistErr error
		digest, persistErr = s.persistExecutionAttestationDuringPublication(runID, transcript)
		return persistErr
	})
	return digest, err
}

// persistExecutionAttestationDuringPublication validates and publishes the
// server transcript while the caller owns the lifecycle/evidence transaction.
func (s *Service) persistExecutionAttestationDuringPublication(
	runID string,
	transcript *brokerExecutionTranscript,
) (string, error) {
	manifest, _, err := s.readDurableManifest(runID)
	if err != nil {
		return "", err
	}
	if manifest.Mode != ModeLive {
		if transcript != nil && len(transcript.Entries) != 0 {
			return "", fmt.Errorf("%w: replay execution cannot contain broker observations", ErrInvalid)
		}
		return "", nil
	}
	registry, _, err := s.registrySnapshot()
	if err != nil {
		return "", err
	}
	executionContract, err := registry.executionContracts().resolve(manifest)
	if err != nil {
		return "", err
	}
	if transcript == nil {
		return "", fmt.Errorf("%w: live execution omitted its server broker transcript", ErrInvalid)
	}
	run, err := s.store.GetRun(runID)
	if err != nil {
		return "", err
	}
	if validationErr := validateBrokerTranscriptIdentity(run, manifest, *transcript); validationErr != nil {
		return "", validationErr
	}
	runDir, err := s.store.checkedRunDir(runID)
	if err != nil {
		return "", err
	}
	if executionContract.Executor.NormalizedSuite {
		if workloadErr := validateNormalizedWorkloadFromLineage(runDir, manifest, executionContract.Executor); workloadErr != nil {
			return "", workloadErr
		}
	}
	caseLimit, err := manifestVisibleCaseLimit(manifest, executionContract.Executor)
	if err != nil {
		return "", err
	}
	cases, err := validateVisibleCaseSet(filepath.Join(runDir, "cases.jsonl"), caseLimit, manifest.TrackIDs)
	if err != nil {
		return "", err
	}
	grading, err := loadGradingCases(filepath.Join(runDir, "grading-cases.jsonl"), cases.IDs)
	if err != nil {
		return "", err
	}
	records, err := s.loadPrivateComparisonRecords(runID)
	if err != nil {
		return "", err
	}
	entries, err := validateBrokerRecordBindings(
		manifest, transcript.Entries, records, cases, grading,
		transcript.StartedAt, transcript.CompletedAt,
	)
	if err != nil {
		return "", err
	}
	attestation := executionAttestation{
		SchemaVersion: SchemaVersion, ContractVersion: executionAttestationContractVersion,
		RunID: runID, ManifestDigest: manifest.ManifestDigest, TargetID: manifest.Target.ID,
		Mode: manifest.Mode, PolicySnapshotDigest: manifest.PolicySnapshotDigest,
		BackendTopologyDigest: manifest.Target.BackendTopologyDigest,
		StartedAt:             transcript.StartedAt.UTC(), CompletedAt: transcript.CompletedAt.UTC(), Entries: entries,
	}
	attestation.Digest, err = executionAttestationDigest(attestation)
	if err != nil {
		return "", err
	}
	if err := s.store.writeLifecycleBoundExecutionAttestationDuringPublication(attestation); err != nil {
		return "", err
	}
	return attestation.Digest, nil
}

func validateBrokerTranscriptIdentity(run Run, manifest RunManifest, transcript brokerExecutionTranscript) error {
	if transcript.SchemaVersion != SchemaVersion || transcript.ContractVersion != executionAttestationContractVersion ||
		transcript.RunID != run.ID || transcript.ManifestDigest != manifest.ManifestDigest ||
		transcript.TargetID != manifest.Target.ID || transcript.Mode != ModeLive ||
		transcript.PolicySnapshotDigest != manifest.PolicySnapshotDigest ||
		transcript.BackendTopologyDigest != manifest.Target.BackendTopologyDigest ||
		!digestPattern.MatchString(transcript.BackendTopologyDigest) || run.StartedAt == nil ||
		transcript.StartedAt.Before(run.StartedAt.UTC()) || transcript.CompletedAt.Before(transcript.StartedAt) ||
		transcript.CompletedAt.After(time.Now().UTC().Add(time.Second)) ||
		len(transcript.Entries) == 0 || len(transcript.Entries) > maxWorkerBrokerRequests {
		return fmt.Errorf("%w: live broker transcript does not match the immutable run", ErrInvalid)
	}
	return nil
}

func loadGradingCases(path string, caseIDs map[string]struct{}) (map[string]gradingCaseEvidence, error) {
	grading := make(map[string]gradingCaseEvidence, len(caseIDs))
	err := scanEvidenceJSONLines(path, maxWorkerArtifactBytes, maxCaseLineBytes, maxRecordsPerRun, func(line []byte, lineNumber int) error {
		var row gradingCaseEvidence
		if err := decodeStrictJSONLine(line, &row); err != nil {
			return fmt.Errorf("%w: grading-cases.jsonl line %d is invalid: %w", ErrInvalid, lineNumber, err)
		}
		if row.SchemaVersion != SchemaVersion || !evidenceIDPattern.MatchString(row.CaseID) ||
			!finiteFloat(row.Weight) || row.Weight <= 0 || row.ExpectedTools == nil {
			return fmt.Errorf("%w: grading-cases.jsonl line %d violates its contract", ErrInvalid, lineNumber)
		}
		if _, present := caseIDs[row.CaseID]; !present || grading[row.CaseID].CaseID != "" {
			return fmt.Errorf("%w: grading case identities do not match visible cases", ErrInvalid)
		}
		grading[row.CaseID] = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(grading) != len(caseIDs) {
		return nil, fmt.Errorf("%w: grading and visible case sets differ", ErrInvalid)
	}
	return grading, nil
}

func validateControlledPairObservation(
	manifest RunManifest,
	entry executionAttestationEntry,
	transcriptStartedAt time.Time,
	transcriptCompletedAt time.Time,
) error {
	pair := entry.ControlledPair
	if pair == nil || pair.ContractVersion != controlledPairProtocolVersion ||
		pair.Protocol != controlledPairInterleaveABBA || !validClientRequestID(pair.SessionID) ||
		(pair.Role != controlledPairRoleBaseline && pair.Role != controlledPairRoleCandidate) ||
		pair.VariantManifestDigest != manifest.ManifestDigest ||
		pair.AttemptID != entry.AttemptID || !digestPattern.MatchString(pair.CoordinateDigest) ||
		!digestPattern.MatchString(pair.BlockID) || pair.ObservedAt.IsZero() || pair.CompletedAt.IsZero() ||
		pair.ObservedAt.Before(transcriptStartedAt) || pair.CompletedAt.Before(pair.ObservedAt) ||
		pair.CompletedAt.After(transcriptCompletedAt) {
		return fmt.Errorf("observation envelope is not bound to the frozen run")
	}
	armID := ""
	if entry.Operation == workerBrokerArmChatCompletion {
		armID = stringValue(entry.ArmID)
		if armID == "" {
			return fmt.Errorf("model-pool observation omits its frozen arm")
		}
	}
	coordinate := controlledPairCoordinate{
		trackID: entry.TrackID, caseID: entry.CaseID, attemptID: entry.AttemptID,
		operation: entry.Operation, armID: armID,
	}
	if pair.CoordinateDigest != digestString("controlled-pair-coordinate:"+coordinate.canonical()) {
		return fmt.Errorf("coordinate digest differs from the attested attempt")
	}
	expectedLoad, err := controlledPairRequestLoad(manifest, workerBrokerRequest{
		Operation: entry.Operation, TrackID: entry.TrackID, CaseID: entry.CaseID, AttemptID: entry.AttemptID,
	})
	if err != nil || !reflect.DeepEqual(pair.Load, expectedLoad) {
		return fmt.Errorf("load context differs from the frozen attempt")
	}
	switch pair.Cohort {
	case campaignArmCohortPaired:
		if (pair.Order != "AB" && pair.Order != "BA") || (pair.Position != 1 && pair.Position != 2) {
			return fmt.Errorf("paired block order or position is invalid")
		}
		if (pair.Order == "AB" && ((pair.Role == controlledPairRoleBaseline) != (pair.Position == 1))) ||
			(pair.Order == "BA" && ((pair.Role == controlledPairRoleCandidate) != (pair.Position == 1))) {
			return fmt.Errorf("paired block role contradicts its AB/BA order")
		}
	case campaignArmCohortBaselineOnly:
		if entry.Operation != workerBrokerArmChatCompletion || pair.Role != controlledPairRoleBaseline ||
			pair.Order != "A" || pair.Position != 1 {
			return fmt.Errorf("baseline-only block is invalid")
		}
	case campaignArmCohortCandidateOnly:
		if entry.Operation != workerBrokerArmChatCompletion || pair.Role != controlledPairRoleCandidate ||
			pair.Order != "B" || pair.Position != 1 {
			return fmt.Errorf("candidate-only block is invalid")
		}
	default:
		return fmt.Errorf("observation cohort is invalid")
	}
	return nil
}

func serverPoolOracleArmIDs(
	manifest RunManifest,
	entries []executionAttestationEntry,
	recordsByReceipt map[string][]executionRecordEvidence,
	cases visibleCaseSet,
	grading map[string]gradingCaseEvidence,
) map[string]map[string]struct{} {
	oracles := make(map[string]map[string]struct{})
	if manifest.Target.Mixture == nil || !containsTrack(manifest.TrackIDs, "routing") ||
		!containsTrack(manifest.TrackIDs, "model_pool") {
		return oracles
	}
	qualities := make(map[string]map[string]float64)
	for _, entry := range entries {
		if entry.Operation != workerBrokerArmChatCompletion {
			continue
		}
		bound := recordsByReceipt[entry.BrokerReceipt]
		if len(bound) != 1 {
			continue
		}
		record := bound[0]
		if record.TrackID != "model_pool" || record.ArmID == nil || entry.ArmID == nil ||
			record.CaseID != entry.CaseID || *record.ArmID != *entry.ArmID {
			continue
		}
		if _, routedCase := cases.CaseIDsByTrack["routing"][record.CaseID]; !routedCase {
			continue
		}
		quality := serverObservedAnswerQuality(entry, grading[record.CaseID])
		if quality == nil {
			continue
		}
		if qualities[record.CaseID] == nil {
			qualities[record.CaseID] = make(map[string]float64, len(manifest.Target.Mixture.ModelArms))
		}
		qualities[record.CaseID][*entry.ArmID] = *quality
	}
	for caseID := range cases.CaseIDsByTrack["routing"] {
		if _, poolCase := cases.CaseIDsByTrack["model_pool"][caseID]; !poolCase ||
			len(qualities[caseID]) != len(manifest.Target.Mixture.ModelArms) {
			continue
		}
		complete := true
		maximum := -1.0
		for _, arm := range manifest.Target.Mixture.ModelArms {
			quality, present := qualities[caseID][arm.ID]
			if !present {
				complete = false
				break
			}
			if quality > maximum {
				maximum = quality
			}
		}
		if !complete {
			continue
		}
		oracle := make(map[string]struct{})
		for _, arm := range manifest.Target.Mixture.ModelArms {
			if qualities[caseID][arm.ID] == maximum {
				oracle[arm.ID] = struct{}{}
			}
		}
		oracles[caseID] = oracle
	}
	return oracles
}

func validateBrokerMixtureBinding(mixture *ManifestMixture, entry executionAttestationEntry) error {
	switch entry.Operation {
	case workerBrokerAgentTaskLedger, workerBrokerFaultRecoveryLedger, workerBrokerHardPolicyLedger, workerBrokerProductionExperimentLedger:
		return nil
	case workerBrokerRouterEvaluate, workerBrokerRoutedChatCompletion, workerBrokerArmChatCompletion:
	default:
		return fmt.Errorf("broker operation has no mixture binding contract")
	}
	if mixture == nil || entry.RequestedModel == nil {
		return fmt.Errorf("broker operation omits its frozen mixture request model")
	}
	if entry.Operation == workerBrokerArmChatCompletion {
		arm, present := frozenArmByRequestModel(mixture.ModelArms, *entry.RequestedModel)
		if !present || *entry.RequestedModel == mixture.EntrypointModel ||
			containsString(mixture.Aliases, *entry.RequestedModel) || entry.ArmID == nil || *entry.ArmID != arm.ID {
			return fmt.Errorf("arm chat request is outside the frozen mixture pool")
		}
		if entry.SelectedModel != nil {
			selectedArmID, resolved := frozenArmID(mixture.ModelArms, *entry.SelectedModel)
			if !resolved || selectedArmID != arm.ID {
				return fmt.Errorf("arm chat response crossed its requested frozen arm")
			}
		}
		if header := entry.Headers["x-vsr-selected-model"]; header != "" {
			headerArmID, resolved := frozenArmID(mixture.ModelArms, header)
			if !resolved || headerArmID != arm.ID {
				return fmt.Errorf("arm chat response header crossed its requested frozen arm")
			}
		}
		if entry.Success && !completeChatObservation(entry) {
			return fmt.Errorf("successful arm chat omitted response or usage attestation")
		}
		return nil
	}
	if *entry.RequestedModel != mixture.EntrypointModel {
		return fmt.Errorf("routed request does not use the frozen mixture entrypoint")
	}
	if entry.Recipe == nil || *entry.Recipe != mixture.RecipeName {
		return fmt.Errorf("routed response does not bind the frozen mixture recipe")
	}
	if header := entry.Headers["x-vsr-selected-recipe"]; header != "" && header != mixture.RecipeName {
		return fmt.Errorf("routed response header disagrees with the frozen mixture recipe")
	}
	if entry.SelectedModel != nil {
		selectedArmID, resolved := frozenArmID(mixture.ModelArms, *entry.SelectedModel)
		if !resolved || entry.ArmID == nil || selectedArmID != *entry.ArmID {
			return fmt.Errorf("routed response selected outside the frozen mixture pool")
		}
	}
	if header := entry.Headers["x-vsr-selected-model"]; header != "" {
		headerArmID, resolved := frozenArmID(mixture.ModelArms, header)
		if !resolved || entry.ArmID == nil || headerArmID != *entry.ArmID {
			return fmt.Errorf("routed response header disagrees with its resolved frozen arm")
		}
	}
	if !entry.Success {
		if entry.Operation == workerBrokerRoutedChatCompletion &&
			(entry.SelectionStatus != nil || entry.SelectionMethod != nil || entry.Algorithm != nil) {
			return fmt.Errorf("failed routed chat contains a successful selection projection")
		}
		if entry.ArmID != nil {
			if armID, present := frozenArmID(mixture.ModelArms, *entry.ArmID); !present || armID != *entry.ArmID {
				return fmt.Errorf("failed routed request resolved outside the frozen mixture pool")
			}
		}
		return nil
	}
	if entry.SelectedModel == nil || entry.ArmID == nil {
		return fmt.Errorf("successful routed request omitted its resolved frozen arm")
	}
	if entry.Algorithm == nil || !mixtureAuthorizesSelection(mixture, entry) {
		return fmt.Errorf("routed response selection is outside the frozen mixture decision boundary")
	}
	if header := entry.Headers["x-vsr-selected-algorithm"]; header != "" && header != *entry.Algorithm {
		return fmt.Errorf("routed response algorithm header disagrees with its attestation")
	}
	if header := entry.Headers["x-vsr-selected-decision"]; header != "" &&
		(entry.DecisionName == nil || header != *entry.DecisionName) {
		return fmt.Errorf("routed response decision header disagrees with its attestation")
	}
	if entry.Operation == workerBrokerRoutedChatCompletion &&
		(entry.SelectionStatus == nil || *entry.SelectionStatus != "selected" ||
			entry.SelectionMethod == nil || *entry.SelectionMethod != *entry.Algorithm) {
		return fmt.Errorf("successful routed chat does not bind the server-owned selection projection")
	}
	if entry.Operation == workerBrokerRoutedChatCompletion && !completeChatObservation(entry) {
		return fmt.Errorf("successful routed chat omitted response or usage attestation")
	}
	return nil
}

func mixtureAuthorizesSelection(mixture *ManifestMixture, entry executionAttestationEntry) bool {
	if entry.Algorithm == nil || entry.ArmID == nil {
		return false
	}
	explicitFallback := mixture.FallbackArmID != "" && *entry.ArmID == mixture.FallbackArmID &&
		(*entry.Algorithm == "default" ||
			(entry.SelectionStatus != nil && *entry.SelectionStatus == "fallback"))
	if explicitFallback {
		return true
	}
	for _, decision := range mixture.Decisions {
		if decision.Algorithm != *entry.Algorithm ||
			(entry.DecisionName != nil && decision.Name != *entry.DecisionName) {
			continue
		}
		if containsString(decision.ArmIDs, *entry.ArmID) {
			return true
		}
	}
	return false
}

func completeChatObservation(entry executionAttestationEntry) bool {
	return entry.ResponseContentDigest != nil && entry.InputTokens != nil && entry.OutputTokens != nil
}

func frozenArmByRequestModel(arms []ModelArm, model string) (ModelArm, bool) {
	for _, arm := range arms {
		if arm.Model == model {
			return arm, true
		}
	}
	return ModelArm{}, false
}

func frozenArmID(arms []ModelArm, identity string) (string, bool) {
	for _, arm := range arms {
		if arm.ID == identity || arm.Model == identity {
			return arm.ID, true
		}
	}
	return "", false
}

func validateMixtureRecordDensity(manifest RunManifest, records []executionRecordEvidence, cases visibleCaseSet) error {
	poolSelected := containsTrack(manifest.TrackIDs, "model_pool")
	jointSelected := containsTrack(manifest.TrackIDs, "joint")
	if !poolSelected && !jointSelected {
		return nil
	}
	if manifest.Target.Mixture == nil || len(manifest.Target.Mixture.ModelArms) == 0 {
		return fmt.Errorf("%w: mixture evaluation has no frozen model pool", ErrInvalid)
	}
	poolCounts := make(map[string]map[string]int, len(cases.CaseIDsByTrack["model_pool"]))
	jointCounts := make(map[string]int, len(cases.CaseIDsByTrack["joint"]))
	for _, record := range records {
		switch record.TrackID {
		case "model_pool":
			if _, planned := cases.CaseIDsByTrack["model_pool"][record.CaseID]; !planned {
				return fmt.Errorf("%w: model_pool record %q is outside the visible case matrix", ErrInvalid, record.ID)
			}
			if record.ArmID == nil {
				return fmt.Errorf("%w: model_pool record %q omits its frozen arm", ErrInvalid, record.ID)
			}
			armID, present := frozenArmID(manifest.Target.Mixture.ModelArms, *record.ArmID)
			if !present || armID != *record.ArmID {
				return fmt.Errorf("%w: model_pool record %q names an arm outside the frozen mixture", ErrInvalid, record.ID)
			}
			if poolCounts[record.CaseID] == nil {
				poolCounts[record.CaseID] = make(map[string]int, len(manifest.Target.Mixture.ModelArms))
			}
			poolCounts[record.CaseID][armID]++
		case "joint":
			if _, planned := cases.CaseIDsByTrack["joint"][record.CaseID]; !planned {
				return fmt.Errorf("%w: joint record %q is outside the visible case plan", ErrInvalid, record.ID)
			}
			jointCounts[record.CaseID]++
		}
	}
	if poolSelected {
		for caseID := range cases.CaseIDsByTrack["model_pool"] {
			for _, arm := range manifest.Target.Mixture.ModelArms {
				if poolCounts[caseID][arm.ID] != 1 {
					return fmt.Errorf("%w: model_pool requires exactly one broker record for case %q and frozen arm %q", ErrInvalid, caseID, arm.ID)
				}
			}
			if len(poolCounts[caseID]) != len(manifest.Target.Mixture.ModelArms) {
				return fmt.Errorf("%w: model_pool record matrix contains an extra frozen-arm coordinate", ErrInvalid)
			}
		}
	}
	if jointSelected {
		for caseID := range cases.CaseIDsByTrack["joint"] {
			if jointCounts[caseID] != 1 {
				return fmt.Errorf("%w: joint requires exactly one routed broker record for case %q", ErrInvalid, caseID)
			}
		}
	}
	return nil
}

func validateBrokerRecord(
	entry executionAttestationEntry,
	record executionRecordEvidence,
	cases visibleCaseSet,
	grading gradingCaseEvidence,
	arms []ModelArm,
	poolOracleArmIDs map[string]struct{},
) error {
	if entry.TrackID != record.TrackID || entry.CaseID != record.CaseID || entry.AttemptID != record.AttemptID {
		return fmt.Errorf("broker evidence identity differs from the record")
	}
	expectedOperation := ""
	switch record.TrackID {
	case "routing":
		expectedOperation = workerBrokerRouterEvaluate
	case "model_pool":
		expectedOperation = workerBrokerArmChatCompletion
	case "joint", "multimodal", "capacity":
		expectedOperation = workerBrokerRoutedChatCompletion
	}
	if expectedOperation == "" || entry.Operation != expectedOperation {
		return fmt.Errorf("broker operation does not own the record track")
	}
	if record.Success == nil || *record.Success != entry.Success ||
		(record.Status == "succeeded") != entry.Success || record.Status == "unavailable" {
		return fmt.Errorf("record outcome differs from the broker response")
	}
	expectedLatency := float64(entry.LatencyMicroseconds) / 1000
	if record.LatencyMS == nil || *record.LatencyMS != expectedLatency {
		return fmt.Errorf("record latency differs from the server observation")
	}
	quality := serverObservedQuality(entry, record.TrackID, grading, poolOracleArmIDs)
	if !sameOptionalFloat(record.Quality, quality) {
		return fmt.Errorf("record quality differs from server-side hidden-label grading")
	}
	switch record.TrackID {
	case "routing":
		if !sameOptionalString(record.SelectedArmID, entry.ArmID) ||
			!sameOptionalString(record.SelectionStatus, entry.SelectionStatus) ||
			!sameOptionalString(record.SelectionMethod, entry.SelectionMethod) ||
			!sameOptionalString(record.Recipe, entry.Recipe) ||
			!sameOptionalString(record.DecisionName, entry.DecisionName) ||
			!sameOptionalString(record.Algorithm, entry.Algorithm) {
			return fmt.Errorf("routing decision differs from the server response")
		}
	case "model_pool":
		if !sameOptionalString(record.ArmID, entry.ArmID) || record.SelectedArmID != nil {
			return fmt.Errorf("model_pool arm differs from the server-bound direct request")
		}
		if err := validateChatUsageAndCost(record, entry, arms); err != nil {
			return err
		}
	case "joint":
		if record.ArmID != nil || !sameOptionalString(record.SelectedArmID, entry.ArmID) ||
			!sameOptionalString(record.SelectionStatus, entry.SelectionStatus) ||
			!sameOptionalString(record.SelectionMethod, entry.SelectionMethod) ||
			!sameOptionalString(record.Recipe, entry.Recipe) ||
			!sameOptionalString(record.DecisionName, entry.DecisionName) ||
			!sameOptionalString(record.Algorithm, entry.Algorithm) {
			return fmt.Errorf("joint routed decision differs from the server response")
		}
		if err := validateChatUsageAndCost(record, entry, arms); err != nil {
			return err
		}
	case "multimodal":
		if cases.Modalities[record.CaseID] == "text" || record.Modality == nil ||
			*record.Modality != cases.Modalities[record.CaseID] {
			return fmt.Errorf("multimodal record does not match the visible case")
		}
		if err := validateChatUsageAndCost(record, entry, arms); err != nil {
			return err
		}
	case "capacity":
		if err := validateChatUsageAndCost(record, entry, arms); err != nil {
			return err
		}
	default:
		return fmt.Errorf("record track has no server broker attestation contract")
	}
	return nil
}

func validateChatUsageAndCost(record executionRecordEvidence, entry executionAttestationEntry, arms []ModelArm) error {
	if !reflect.DeepEqual(record.InputTokens, entry.InputTokens) ||
		!reflect.DeepEqual(record.OutputTokens, entry.OutputTokens) {
		return fmt.Errorf("chat token accounting differs from the server response")
	}
	if !sameOptionalFloat(record.RuntimeCost, serverRuntimeCost(entry, arms)) {
		return fmt.Errorf("chat runtime cost differs from the server-owned frozen mixture pricing")
	}
	return nil
}

func serverObservedQuality(
	entry executionAttestationEntry,
	trackID TrackID,
	grading gradingCaseEvidence,
	poolOracleArmIDs map[string]struct{},
) *float64 {
	if !entry.Success {
		return nil
	}
	switch trackID {
	case "routing":
		if entry.ArmID == nil {
			return nil
		}
		value := 0.0
		if grading.ExpectedRoute != nil {
			if *grading.ExpectedRoute == *entry.ArmID ||
				(entry.SelectedModel != nil && *grading.ExpectedRoute == *entry.SelectedModel) {
				value = 1
			}
			return &value
		}
		if len(poolOracleArmIDs) == 0 {
			return nil
		}
		if _, oracle := poolOracleArmIDs[*entry.ArmID]; oracle {
			value = 1
		}
		return &value
	case "model_pool", "joint", "multimodal":
		return serverObservedAnswerQuality(entry, grading)
	default:
		return nil
	}
}

func serverObservedAnswerQuality(entry executionAttestationEntry, grading gradingCaseEvidence) *float64 {
	if !entry.Success || grading.ExpectedAnswer == nil || entry.ResponseContentDigest == nil {
		return nil
	}
	value := 0.0
	if digestString(normalizedAnswer(*grading.ExpectedAnswer)) == *entry.ResponseContentDigest {
		value = 1
	}
	return &value
}

func brokerResponseContent(payload map[string]any) *string {
	choices, ok := payload["choices"].([]any)
	if !ok || len(choices) == 0 {
		return nil
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return nil
	}
	message, ok := choice["message"].(map[string]any)
	if !ok {
		return nil
	}
	content, ok := message["content"].(string)
	if !ok {
		return nil
	}
	return &content
}

func normalizedAnswer(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func serverRuntimeCost(entry executionAttestationEntry, arms []ModelArm) *float64 {
	if entry.ArmID == nil || entry.InputTokens == nil || entry.OutputTokens == nil {
		return nil
	}
	for _, arm := range arms {
		if *entry.ArmID != arm.ID {
			continue
		}
		value := (float64(*entry.InputTokens)*arm.InputCostPerMillionTokensUSD +
			float64(*entry.OutputTokens)*arm.OutputCostPerMillionTokensUSD) / 1_000_000
		return &value
	}
	return nil
}

func sameOptionalString(left, right *string) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func sameOptionalFloat(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return !math.IsNaN(*left) && !math.IsNaN(*right) && *left == *right
}
