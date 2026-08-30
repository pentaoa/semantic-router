package evaluationplane

import (
	"fmt"
	"math"
)

type recoveryMethodAttestation struct {
	PairCount                 int
	LedgerTotalPairCount      int
	DistinctSeedCount         int
	MinimumDistinctSeedCount  int
	MinimumPairCount          int
	PassRate                  *float64
	PassRateLower95           *float64
	TreatmentSuccessRate      *float64
	BaselineSuccessRate       *float64
	SuccessDelta              *float64
	MeanLatencyDeltaMS        *float64
	MaximumRetryObserved      *float64
	MinimumPassRateLower95    float64
	MaximumRecoveryLatencyMS  *float64
	MaximumRetryAmplification *float64
	PolicySnapshotDigest      string
	ConfigDigest              string
	TargetID                  string
	BackendTopologyDigest     string
	MixtureSnapshotDigest     string
	Passed                    *bool
}

func recoveryContractEqual(left, right recoveryMethodEvidence) bool {
	return left.LedgerID == right.LedgerID && left.SourceID == right.SourceID &&
		left.PolicySnapshotDigest == right.PolicySnapshotDigest && left.ConfigDigest == right.ConfigDigest &&
		left.TargetID == right.TargetID && left.BackendTopologyDigest == right.BackendTopologyDigest &&
		left.MixtureSnapshotDigest == right.MixtureSnapshotDigest &&
		left.LedgerTotalPairCount == right.LedgerTotalPairCount && left.MinimumPairCount == right.MinimumPairCount &&
		left.MinimumDistinctSeedCount == right.MinimumDistinctSeedCount &&
		reducedFloatsEqual(left.MaximumRecoveryLatencyMS, right.MaximumRecoveryLatencyMS) &&
		reducedFloatsEqual(left.MaximumRetryAmplification, right.MaximumRetryAmplification)
}

func oneSidedWilsonLower(successes, total int) *float64 {
	if total <= 0 {
		return nil
	}
	const z = 1.6448536269514722
	proportion := float64(successes) / float64(total)
	zSquared := z * z
	denominator := 1 + zSquared/float64(total)
	center := proportion + zSquared/(2*float64(total))
	margin := z * math.Sqrt(proportion*(1-proportion)/float64(total)+zSquared/(4*float64(total*total)))
	value := math.Max(0, (center-margin)/denominator)
	return &value
}

func reduceRecoveryMethod(records []executionRecordEvidence) (recoveryMethodAttestation, error) {
	var first *recoveryMethodEvidence
	faultIDs := make(map[string]struct{})
	pairIDs := make(map[string]struct{})
	seeds := make(map[int64]struct{})
	passes := 0
	baselineSuccesses := 0
	treatmentSuccesses := 0
	latencyDeltaTotal := 0.0
	maximumRetryObserved := 0.0
	count := 0
	for _, record := range records {
		method := record.Recovery
		if method == nil {
			continue
		}
		if first == nil {
			copyMethod := *method
			first = &copyMethod
		} else if !recoveryContractEqual(*first, *method) {
			return recoveryMethodAttestation{}, fmt.Errorf("recovery rows mix sealed ledger contracts")
		}
		pairKey := method.CohortPairID + "\x00" + method.RepetitionID
		if _, duplicate := faultIDs[method.FaultID]; duplicate {
			return recoveryMethodAttestation{}, fmt.Errorf("recovery fault identities must be unique")
		}
		if _, duplicate := pairIDs[pairKey]; duplicate {
			return recoveryMethodAttestation{}, fmt.Errorf("recovery cohort/repetition pairs must be unique")
		}
		faultIDs[method.FaultID] = struct{}{}
		pairIDs[pairKey] = struct{}{}
		seeds[method.Seed] = struct{}{}
		retryAmplification := float64(method.TreatmentRetryCount+1) / float64(method.BaselineRetryCount+1)
		passed := method.InjectionObserved && method.Recovered && method.StatePreserved && method.TreatmentTerminalSuccess &&
			method.DuplicateSideEffectCount == 0 && method.TreatmentRecoveryLatencyMS <= method.MaximumRecoveryLatencyMS &&
			retryAmplification <= method.MaximumRetryAmplification
		if passed {
			passes++
		}
		if method.BaselineTerminalSuccess {
			baselineSuccesses++
		}
		if method.TreatmentTerminalSuccess {
			treatmentSuccesses++
		}
		latencyDeltaTotal += method.TreatmentRecoveryLatencyMS - method.BaselineRecoveryLatencyMS
		if retryAmplification > maximumRetryObserved {
			maximumRetryObserved = retryAmplification
		}
		count++
	}
	if first == nil {
		return recoveryMethodAttestation{}, nil
	}
	passRate := float64(passes) / float64(count)
	baselineRate := float64(baselineSuccesses) / float64(count)
	treatmentRate := float64(treatmentSuccesses) / float64(count)
	successDelta := treatmentRate - baselineRate
	meanLatencyDelta := latencyDeltaTotal / float64(count)
	lower := oneSidedWilsonLower(passes, count)
	maxLatency := first.MaximumRecoveryLatencyMS
	maxRetry := first.MaximumRetryAmplification
	attestation := recoveryMethodAttestation{
		PairCount: count, LedgerTotalPairCount: first.LedgerTotalPairCount,
		DistinctSeedCount: len(seeds), MinimumDistinctSeedCount: first.MinimumDistinctSeedCount,
		MinimumPairCount: first.MinimumPairCount, PassRate: &passRate, PassRateLower95: lower,
		TreatmentSuccessRate: &treatmentRate, BaselineSuccessRate: &baselineRate,
		SuccessDelta: &successDelta, MeanLatencyDeltaMS: &meanLatencyDelta,
		MaximumRetryObserved:     &maximumRetryObserved,
		MinimumPassRateLower95:   minimumRecoveryPassRateLowerBound,
		MaximumRecoveryLatencyMS: &maxLatency, MaximumRetryAmplification: &maxRetry,
		PolicySnapshotDigest: first.PolicySnapshotDigest, ConfigDigest: first.ConfigDigest,
		TargetID: first.TargetID, BackendTopologyDigest: first.BackendTopologyDigest,
		MixtureSnapshotDigest: first.MixtureSnapshotDigest,
	}
	if count == first.LedgerTotalPairCount && count >= first.MinimumPairCount && len(seeds) >= first.MinimumDistinctSeedCount && lower != nil {
		passed := *lower >= minimumRecoveryPassRateLowerBound
		attestation.Passed = &passed
	}
	return attestation, nil
}
