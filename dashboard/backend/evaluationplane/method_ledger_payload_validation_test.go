package evaluationplane

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func methodTestDigest(character string) string {
	return "sha256:" + strings.Repeat(character, 64)
}

func methodTestManifest(trackID TrackID) RunManifest {
	return RunManifest{
		Mode: ModeLive, TrackIDs: []TrackID{trackID},
		PolicySnapshotDigest: methodTestDigest("a"), ConfigDigest: methodTestDigest("b"),
		Target: ManifestTarget{
			ID: "method-target", Kind: "mixture-of-models", BackendTopologyDigest: methodTestDigest("c"),
			Mixture: &ManifestMixture{
				SchemaVersion: SchemaVersion, ID: "method-mixture", EntrypointModel: "method-entry",
				Aliases: []string{"method-entry"}, RecipeName: "method-recipe", RecipeDigest: methodTestDigest("d"),
				PoolDigest: methodTestDigest("e"), SelectorPolicyDigest: methodTestDigest("f"),
				SelectorDigest: methodTestDigest("1"), AdaptationDigest: methodTestDigest("2"), BindingDigest: methodTestDigest("3"),
				ModelArms: []ModelArm{
					{ID: "model-a", Model: "model-a", ProviderModelIDDigest: methodTestDigest("4")},
					{ID: "model-b", Model: "model-b", ProviderModelIDDigest: methodTestDigest("5")},
				},
				SupportModels: []SupportModel{}, Decisions: []MixtureDecisionBinding{},
			},
		},
	}
}

func methodTestBinding() methodMixtureBinding {
	binding, err := methodManifestMixtureBinding(methodTestManifest("agentic"))
	if err != nil {
		panic(err)
	}
	return binding
}

func methodTestRecoveryRows(count int) (faultRecoveryLedgerPayload, []executionRecordEvidence) {
	startedAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	payload := faultRecoveryLedgerPayload{
		ContractVersion: "evaluation-fault-recovery-ledger.v1", LedgerID: "recovery-ledger", SourceID: "router-runtime",
		Environment: "production", PolicySnapshotDigest: methodTestDigest("a"), ConfigDigest: methodTestDigest("b"),
		TargetID: "method-target", BackendTopologyDigest: methodTestDigest("c"), Mixture: methodTestBinding(),
		MinimumPairCount: minimumRecoveryPairCount, MinimumDistinctSeedCount: minimumRecoveryDistinctSeedCount,
		MaximumRecoveryLatencyMS: 500, MaximumRetryAmplification: 2,
		WindowStartedAt: startedAt, WindowEndedAt: startedAt.Add(time.Hour), SealedAt: startedAt.Add(2 * time.Hour),
	}
	records := make([]executionRecordEvidence, 0, count)
	for index := range count {
		method := recoveryMethodEvidence{
			MethodID: "live-fault-recovery.v1", LedgerID: payload.LedgerID, SourceID: payload.SourceID,
			PolicySnapshotDigest: payload.PolicySnapshotDigest, ConfigDigest: payload.ConfigDigest,
			TargetID: payload.TargetID, BackendTopologyDigest: payload.BackendTopologyDigest,
			MixtureSnapshotDigest: payload.Mixture.SnapshotDigest,
			LedgerTotalPairCount:  count, MinimumPairCount: payload.MinimumPairCount, MinimumDistinctSeedCount: payload.MinimumDistinctSeedCount,
			FaultID: "fault-" + methodTestIndex(index), CohortPairID: "cohort-" + methodTestIndex(index),
			RepetitionID: "repetition-" + methodTestIndex(index), ConversationID: "conversation-" + methodTestIndex(index),
			ClusterID: "cluster-" + methodTestIndex(index%5), Seed: int64(index % 5), Concurrency: 1,
			TreatmentSystem: "treatment", FaultKind: "timeout", FaultSequence: 1, FailureTurn: 1,
			FaultPlanDigest: methodTestDigest("c"), FaultInjectionReceiptDigest: methodTestRowDigest(index, "d"),
			BaselineRecordDigest: methodTestRowDigest(index, "e"), TreatmentRecordDigest: methodTestRowDigest(index, "f"),
			InjectionObserved: true, Recovered: true, StatePreserved: true,
			BaselineTerminalSuccess: true, TreatmentTerminalSuccess: true,
			BaselineRecoveryLatencyMS: 10, TreatmentRecoveryLatencyMS: 20,
			BaselineRetryCount: 0, TreatmentRetryCount: 0,
			MaximumRecoveryLatencyMS: payload.MaximumRecoveryLatencyMS, MaximumRetryAmplification: payload.MaximumRetryAmplification,
			SideEffectScope: "none", ObservedAt: startedAt.Add(time.Duration(index+1) * time.Minute),
		}
		payload.Pairs = append(payload.Pairs, method)
		caseID := methodLedgerCaseID("fault-recovery", payload.LedgerID, method.FaultID)
		success := true
		receipt := methodTestDigest("9")
		records = append(records, executionRecordEvidence{
			SchemaVersion: SchemaVersion, ID: "agentic-" + caseID, TrackID: "agentic", CaseID: caseID,
			AttemptID: "agentic-" + caseID, Status: "succeeded", Success: &success, Recovery: &method, BrokerReceipt: &receipt,
		})
	}
	return payload, records
}

func methodTestHardPolicyRows() (hardPolicyLedgerPayload, []executionRecordEvidence) {
	startedAt := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	proof := hardPolicyStaticProofEvidence{
		ContractVersion: "evaluation-hard-policy-proof.v1", ProofID: "proof-1", SourceID: "router-runtime",
		PolicySnapshotDigest: methodTestDigest("a"), ConfigDigest: methodTestDigest("b"), RuntimeInstanceDigest: methodTestDigest("c"),
		TargetID: "method-target", BackendTopologyDigest: methodTestDigest("c"), MixtureSnapshotDigest: methodTestBinding().SnapshotDigest,
		LedgerTotalObservationCount: 2, RequiredBindings: []hardPolicyEnforcementBindingEvidence{
			{RuleID: "rule-a", EnforcementPoint: "request"}, {RuleID: "rule-b", EnforcementPoint: "response"},
		}, VerifiedAt: startedAt,
	}
	payload := hardPolicyLedgerPayload{
		ContractVersion: "evaluation-hard-policy-ledger.v1", LedgerID: "policy-ledger", SourceID: proof.SourceID,
		Environment: "production", PolicySnapshotDigest: proof.PolicySnapshotDigest, ConfigDigest: proof.ConfigDigest, Proof: proof,
		TargetID: proof.TargetID, BackendTopologyDigest: proof.BackendTopologyDigest, Mixture: methodTestBinding(),
		WindowStartedAt: startedAt, WindowEndedAt: startedAt.Add(time.Hour), SealedAt: startedAt.Add(2 * time.Hour),
	}
	records := make([]executionRecordEvidence, 0, 2)
	for index, binding := range proof.RequiredBindings {
		method := hardPolicyMethodEvidence{
			ContractVersion: "evaluation-hard-policy-observation.v1", Proof: proof,
			ObservationID: "observation-" + methodTestIndex(index), AttackID: "attack-" + methodTestIndex(index),
			RuleID: binding.RuleID, EnforcementPoint: binding.EnforcementPoint, DecisionReceiptID: "decision-" + methodTestIndex(index),
			ShouldBlock: true, Blocked: true, ObservedAt: startedAt.Add(time.Duration(index+1) * time.Minute),
		}
		payload.Observations = append(payload.Observations, method)
		caseID := methodLedgerCaseID("hard-policy", payload.LedgerID, method.ObservationID)
		shouldBlock, blocked, success := true, true, true
		violations := int64(0)
		receipt := methodTestDigest("8")
		records = append(records, executionRecordEvidence{
			SchemaVersion: SchemaVersion, ID: "safety-" + caseID, TrackID: "safety", CaseID: caseID,
			AttemptID: "safety-" + caseID, Status: "succeeded", Success: &success,
			ShouldBlock: &shouldBlock, Blocked: &blocked, SafetyViolations: &violations, HardPolicy: &method, BrokerReceipt: &receipt,
		})
	}
	return payload, records
}

func methodTestProductionRows(targetReward, referenceReward float64, outcomes bool) (productionExperimentLedgerPayload, []executionRecordEvidence) {
	startedAt := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	payload := productionExperimentLedgerPayload{
		ContractVersion: "evaluation-production-experiment-ledger.v1", ExperimentID: "experiment-1", LedgerID: "experiment-ledger",
		SourceID: "production-router", PolicySnapshotDigest: methodTestDigest("a"), ConfigDigest: methodTestDigest("b"),
		TargetID: "method-target", BackendTopologyDigest: methodTestDigest("c"), Mixture: methodTestBinding(),
		Environment: "production", AssignmentScheme: "randomized", RiskBudgetMaxRate: maximumProductionRiskBudgetRate,
		StopRuleID: "stop-rule", StopRuleEvaluatedAt: startedAt.Add(5 * time.Hour),
		RollbackReceiptID: "rollback-receipt", RollbackValidatedAt: startedAt.Add(6 * time.Hour), RollbackReady: true,
		MinimumEffectiveSampleSize:  minimumProductionEffectiveSampleSize,
		MinimumEffectiveSampleRatio: minimumProductionEffectiveSampleRatio,
		MinimumSegmentSampleSize:    minimumProductionSegmentSampleSize,
		MinimumAssignmentCount:      minimumProductionAssignmentCount, MinimumRewardLift: minimumProductionRewardLift,
		ConfidenceLevel: 0.95, WindowStartedAt: startedAt, WindowEndedAt: startedAt.Add(4 * time.Hour), SealedAt: startedAt.Add(7 * time.Hour),
	}
	arms := []experimentPolicyArmEvidence{
		{ID: "policy-target", ConfigDigest: methodTestDigest("c"), AssignmentProbability: 0.5, TargetPolicyProbability: 1, ReferencePolicyProbability: 0},
		{ID: "policy-reference", ConfigDigest: methodTestDigest("d"), AssignmentProbability: 0.5, TargetPolicyProbability: 0, ReferencePolicyProbability: 1},
	}
	records := make([]executionRecordEvidence, 0, minimumProductionAssignmentCount)
	for index := range minimumProductionAssignmentCount {
		armIndex := index % 2
		arm := arms[armIndex]
		method := productionExperimentMethodEvidence{
			ContractVersion: "evaluation-production-experiment.v1", ExperimentID: payload.ExperimentID, LedgerID: payload.LedgerID,
			LedgerTotalAssignmentCount: minimumProductionAssignmentCount, SourceID: payload.SourceID,
			PolicySnapshotDigest: payload.PolicySnapshotDigest, ConfigDigest: payload.ConfigDigest,
			TargetID: payload.TargetID, BackendTopologyDigest: payload.BackendTopologyDigest,
			MixtureSnapshotDigest: payload.Mixture.SnapshotDigest,
			Environment:           payload.Environment, AssignmentScheme: payload.AssignmentScheme,
			AssignmentID: "assignment-" + methodTestIndex(index), ExposureID: "exposure-" + methodTestIndex(index),
			ParticipantDigest: methodTestRowDigest(index, "1"), SegmentID: "segment-" + methodTestIndex(index%2), PolicyArms: arms,
			AssignedPolicyArmID: arm.ID, AssignmentProbability: arm.AssignmentProbability, ExposureProbability: 1,
			BehaviorPropensity: arm.AssignmentProbability, TargetPolicyProbability: arm.TargetPolicyProbability,
			MinimumEffectiveSampleSize: payload.MinimumEffectiveSampleSize, MinimumEffectiveSampleRatio: payload.MinimumEffectiveSampleRatio,
			MinimumSegmentSampleSize: payload.MinimumSegmentSampleSize, MinimumAssignmentCount: payload.MinimumAssignmentCount,
			MinimumRewardLift: payload.MinimumRewardLift, ConfidenceLevel: payload.ConfidenceLevel,
			RiskBudgetMaxRate: payload.RiskBudgetMaxRate, StopRuleID: payload.StopRuleID, StopRuleEvaluatedAt: payload.StopRuleEvaluatedAt,
			RollbackReceiptID: payload.RollbackReceiptID, RollbackValidatedAt: payload.RollbackValidatedAt, RollbackReady: true,
			AssignedAt: startedAt.Add(time.Duration(index+1) * time.Minute), ExposedAt: startedAt.Add(time.Duration(index+31) * time.Minute),
			LedgerSealedAt: payload.SealedAt,
		}
		if outcomes {
			method.LedgerTotalOutcomeCount = minimumProductionAssignmentCount
		}
		payload.Assignments = append(payload.Assignments, method)
		caseID := methodLedgerCaseID("experiment", payload.LedgerID, method.AssignmentID)
		success := true
		receipt := methodTestDigest("7")
		record := executionRecordEvidence{
			SchemaVersion: SchemaVersion, ID: "preference-" + caseID, TrackID: "preference", CaseID: caseID,
			AttemptID: "preference-" + caseID, Status: "succeeded", Success: &success,
			SelectedArmID: &method.AssignedPolicyArmID, BehaviorPropensity: &method.BehaviorPropensity,
			ProductionExperiment: &method, BrokerReceipt: &receipt,
		}
		if outcomes {
			reward := referenceReward
			if armIndex == 0 {
				reward = targetReward
			}
			outcome := onlinePreferenceOutcomeEvidence{
				ContractVersion: "evaluation-online-preference-ledger.v1", OutcomeID: "outcome-" + methodTestIndex(index),
				AssignmentID: method.AssignmentID, ExposureID: method.ExposureID, ParticipantDigest: method.ParticipantDigest,
				SegmentID: method.SegmentID, Reward: reward, ObservedAt: startedAt.Add(time.Duration(index+61) * time.Minute),
			}
			payload.PreferenceOutcomes = append(payload.PreferenceOutcomes, outcome)
			preference := onlinePreferenceMethodEvidence{ContractVersion: "evaluation-online-preference-method.v1", Experiment: method, Outcome: outcome}
			record.OnlinePreference = &preference
		}
		records = append(records, record)
	}
	return payload, records
}

func methodTestIndex(index int) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	return string(digits[index/36]) + string(digits[index%36])
}

func methodTestRowDigest(index int, character string) string {
	return digestBytes([]byte(character + methodTestIndex(index)))
}

func methodTestPayloadMap(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestMethodLedgerPayloadValidationRequiresExactFullWindowMembership(t *testing.T) {
	t.Run("fault recovery", func(t *testing.T) {
		payload, records := methodTestRecoveryRows(minimumRecoveryPairCount)
		if err := validateFaultRecoveryLedgerPayload(payload, records, methodTestManifest("agentic")); err != nil {
			t.Fatalf("complete fault ledger rejected: %v", err)
		}
		if err := validateFaultRecoveryLedgerPayload(payload, records[:len(records)-1], methodTestManifest("agentic")); err == nil {
			t.Fatal("truncated fault ledger records passed")
		}
		entry := executionAttestationEntry{
			Operation: workerBrokerFaultRecoveryLedger, TrackID: "agentic", CaseID: "fault-recovery-ledger", AttemptID: "ledger-fetch",
			UpstreamAttempted: true, Success: true, responsePayload: methodTestPayloadMap(t, payload),
		}
		entry.FetchedAt = copyTime(&payload.SealedAt)
		entry.LedgerSealedAt = copyTime(&payload.SealedAt)
		if err := validateMethodLedgerBrokerBinding(entry, records, methodTestManifest("agentic")); err != nil {
			t.Fatalf("retained fault ledger response rejected: %v", err)
		}
		entry.LedgerSealedAt = copyTime(&payload.WindowEndedAt)
		if err := validateMethodLedgerBrokerBinding(entry, records, methodTestManifest("agentic")); err == nil {
			t.Fatal("fault ledger whose payload seal differs from its broker receipt passed")
		}
	})

	t.Run("hard policy exact pairs", func(t *testing.T) {
		payload, records := methodTestHardPolicyRows()
		if err := validateHardPolicyLedgerPayload(payload, records, methodTestManifest("safety")); err != nil {
			t.Fatalf("complete hard-policy ledger rejected: %v", err)
		}
		forged := payload
		forged.Observations = append([]hardPolicyMethodEvidence(nil), payload.Observations...)
		forged.Observations[1].EnforcementPoint = payload.Observations[0].EnforcementPoint
		if err := validateHardPolicyLedgerPayload(forged, records, methodTestManifest("safety")); err == nil {
			t.Fatal("forged hard-policy binding passed")
		}
	})

	t.Run("production assignment and outcome seal", func(t *testing.T) {
		payload, records := methodTestProductionRows(1, 0, true)
		if err := validateProductionLedgerPayload(payload, records, methodTestManifest("preference")); err != nil {
			t.Fatalf("complete production ledger rejected: %v", err)
		}
		if err := validateProductionLedgerPayload(payload, records[1:], methodTestManifest("preference")); err == nil {
			t.Fatal("production ledger with an omitted assignment passed")
		}
		forged := append([]executionRecordEvidence(nil), records...)
		preference := *forged[0].OnlinePreference
		preference.Outcome.Reward = 0.25
		forged[0].OnlinePreference = &preference
		if err := validateProductionLedgerPayload(payload, forged, methodTestManifest("preference")); err == nil {
			t.Fatal("production record with a forged reward passed")
		}
	})
}

func TestMethodLedgersRejectRuntimeSubjectSubstitution(t *testing.T) {
	t.Run("fault recovery", func(t *testing.T) {
		for _, mutate := range []func(*faultRecoveryLedgerPayload){
			func(payload *faultRecoveryLedgerPayload) { payload.TargetID = "different-target" },
			func(payload *faultRecoveryLedgerPayload) { payload.BackendTopologyDigest = methodTestDigest("6") },
			func(payload *faultRecoveryLedgerPayload) { payload.Mixture.BindingDigest = methodTestDigest("6") },
		} {
			payload, records := methodTestRecoveryRows(minimumRecoveryPairCount)
			mutate(&payload)
			if err := validateFaultRecoveryLedgerPayload(payload, records, methodTestManifest("agentic")); err == nil {
				t.Fatal("fault-recovery runtime subject substitution passed")
			}
		}
	})

	t.Run("hard policy", func(t *testing.T) {
		for _, mutate := range []func(*hardPolicyLedgerPayload){
			func(payload *hardPolicyLedgerPayload) { payload.TargetID = "different-target" },
			func(payload *hardPolicyLedgerPayload) { payload.BackendTopologyDigest = methodTestDigest("6") },
			func(payload *hardPolicyLedgerPayload) { payload.Mixture.BindingDigest = methodTestDigest("6") },
		} {
			payload, records := methodTestHardPolicyRows()
			mutate(&payload)
			if err := validateHardPolicyLedgerPayload(payload, records, methodTestManifest("safety")); err == nil {
				t.Fatal("hard-policy runtime subject substitution passed")
			}
		}
	})

	t.Run("production", func(t *testing.T) {
		for _, mutate := range []func(*productionExperimentLedgerPayload){
			func(payload *productionExperimentLedgerPayload) { payload.TargetID = "different-target" },
			func(payload *productionExperimentLedgerPayload) {
				payload.BackendTopologyDigest = methodTestDigest("6")
			},
			func(payload *productionExperimentLedgerPayload) {
				payload.Mixture.BindingDigest = methodTestDigest("6")
			},
		} {
			payload, records := methodTestProductionRows(1, 0, true)
			mutate(&payload)
			if err := validateProductionLedgerPayload(payload, records, methodTestManifest("preference")); err == nil {
				t.Fatal("production runtime subject substitution passed")
			}
		}
	})
}

func TestMethodLedgerBrokerBindingRejectsFutureAndStaleSealsForEveryLedger(t *testing.T) {
	agentManifest, agentPayload, agentRecords := agentTaskTestRows(t)
	recoveryPayload, recoveryRecords := methodTestRecoveryRows(minimumRecoveryPairCount)
	hardPayload, hardRecords := methodTestHardPolicyRows()
	productionPayload, productionRecords := methodTestProductionRows(1, 0, true)
	tests := []struct {
		name      string
		operation string
		trackID   TrackID
		caseID    string
		sealedAt  time.Time
		payload   any
		records   []executionRecordEvidence
		manifest  RunManifest
	}{
		{"agent task", workerBrokerAgentTaskLedger, "agentic", "agent-task-ledger", agentPayload.SealedAt, agentPayload, agentRecords, agentManifest},
		{"fault recovery", workerBrokerFaultRecoveryLedger, "agentic", "fault-recovery-ledger", recoveryPayload.SealedAt, recoveryPayload, recoveryRecords, methodTestManifest("agentic")},
		{"hard policy", workerBrokerHardPolicyLedger, "safety", "hard-policy-ledger", hardPayload.SealedAt, hardPayload, hardRecords, methodTestManifest("safety")},
		{"production", workerBrokerProductionExperimentLedger, "preference", "production-ledger", productionPayload.SealedAt, productionPayload, productionRecords, methodTestManifest("preference")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			entry := executionAttestationEntry{
				Operation: test.operation, TrackID: test.trackID, CaseID: test.caseID, AttemptID: "ledger-fetch",
				UpstreamAttempted: true, Success: true, responsePayload: methodTestPayloadMap(t, test.payload),
			}
			entry.LedgerSealedAt = copyTime(&test.sealedAt)
			for name, fetchedAt := range map[string]time.Time{
				"future": test.sealedAt.Add(-time.Nanosecond),
				"stale":  test.sealedAt.Add(maximumMethodLedgerFreshness + time.Nanosecond),
			} {
				t.Run(name, func(t *testing.T) {
					forged := entry
					forged.FetchedAt = &fetchedAt
					if err := validateMethodLedgerBrokerBinding(forged, test.records, test.manifest); err == nil {
						t.Fatal("out-of-window ledger seal passed broker validation")
					}
				})
			}
		})
	}
}

func TestMethodReducersEnforcePlatformCohortsAndDecisiveOutcomes(t *testing.T) {
	tinyPayload, tinyRecords := methodTestRecoveryRows(2)
	_ = tinyPayload
	tinyRecovery, err := reduceRecoveryMethod(tinyRecords)
	if err != nil {
		t.Fatal(err)
	}
	if tinyRecovery.Passed != nil {
		t.Fatal("2/2 recovery pairs produced a promotional decision")
	}

	_, recoveryRecords := methodTestRecoveryRows(minimumRecoveryPairCount)
	recovery, err := reduceRecoveryMethod(recoveryRecords)
	if err != nil || recovery.Passed == nil || !*recovery.Passed || recovery.PassRateLower95 == nil {
		t.Fatalf("qualified recovery reduction=%+v error=%v", recovery, err)
	}

	_, regressedRecords := methodTestProductionRows(0, 1, true)
	regressed, err := reduceProductionMethod(regressedRecords)
	if err != nil || regressed.PreferencePassed == nil || *regressed.PreferencePassed || regressed.RewardLiftLower95 == nil {
		t.Fatalf("regressed preference reduction=%+v error=%v", regressed, err)
	}

	_, incompleteRecords := methodTestProductionRows(1, 0, false)
	incomplete, err := reduceProductionMethod(incompleteRecords)
	if err != nil || incomplete.PreferencePassed != nil {
		t.Fatalf("incomplete preference reduction=%+v error=%v", incomplete, err)
	}
}

func TestLiveMethodEvidenceLevelsComeOnlyFromCompleteServerReducers(t *testing.T) {
	_, recoveryRecords := methodTestRecoveryRows(minimumRecoveryPairCount)
	recovery, err := reduceRecoveryMethod(recoveryRecords)
	if err != nil {
		t.Fatal(err)
	}
	levels := sealedEvidenceLevels{Run: "E0", ByTrack: map[TrackID]EvidenceLevel{"agentic": "E0"}}
	manifest := methodTestManifest("agentic")
	deriveLiveMethodEvidenceLevels(&levels, manifest, recordAttestation{Methods: methodRecordAttestation{Recovery: recovery}})
	if levels.ByTrack["agentic"] != "E5" {
		t.Fatalf("complete live recovery level=%s, want E5", levels.ByTrack["agentic"])
	}

	_, tinyRecords := methodTestRecoveryRows(2)
	tiny, err := reduceRecoveryMethod(tinyRecords)
	if err != nil {
		t.Fatal(err)
	}
	levels.ByTrack["agentic"] = "E0"
	deriveLiveMethodEvidenceLevels(&levels, manifest, recordAttestation{Methods: methodRecordAttestation{Recovery: tiny}})
	if levels.ByTrack["agentic"] != "E0" {
		t.Fatalf("tiny recovery level=%s, want E0", levels.ByTrack["agentic"])
	}
}
