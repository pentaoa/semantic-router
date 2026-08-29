package evaluationplane

import (
	"fmt"
	"math"
)

const maxReducedFloatULPs = 8

type reducedMetricEvidence struct {
	Value              *float64
	ConfidenceInterval []float64
	SampleCount        int
}

type recordMetricAttestation struct {
	SafetyViolationRate   reducedMetricEvidence
	SafetyBlockAccuracy   reducedMetricEvidence
	JointNormalizedRegret reducedMetricEvidence
	CapacitySuccessRate   reducedMetricEvidence
}

type jointMetricRow struct {
	caseID  string
	quality float64
}

type recordMetricReducer struct {
	safetyRows            int
	safetyViolationTotal  uint64
	safetyBlockRows       int
	safetyBlockCorrect    int
	capacitySuccessRows   int
	capacitySucceededRows int
	poolOracleByCase      map[string]float64
	jointRows             []jointMetricRow
}

func newRecordMetricReducer() *recordMetricReducer {
	return &recordMetricReducer{poolOracleByCase: make(map[string]float64)}
}

func (reducer *recordMetricReducer) observe(record executionRecordEvidence) error {
	if record.Status == "unavailable" {
		return nil
	}
	switch record.TrackID {
	case "safety":
		reducer.safetyRows++
		if record.SafetyViolations != nil {
			// #nosec G115 -- strict record validation rejects negative counters before reduction.
			violations := uint64(*record.SafetyViolations)
			if reducer.safetyViolationTotal > ^uint64(0)-violations {
				return fmt.Errorf("safety_violations aggregate overflows the reducer")
			}
			reducer.safetyViolationTotal += violations
		}
		if record.ShouldBlock != nil && record.Blocked != nil {
			reducer.safetyBlockRows++
			if *record.ShouldBlock == *record.Blocked {
				reducer.safetyBlockCorrect++
			}
		}
	case "model_pool":
		if record.Success != nil && *record.Success && record.Quality != nil {
			current, present := reducer.poolOracleByCase[record.CaseID]
			if !present || *record.Quality > current {
				reducer.poolOracleByCase[record.CaseID] = *record.Quality
			}
		}
	case "joint":
		if record.Quality != nil {
			reducer.jointRows = append(reducer.jointRows, jointMetricRow{
				caseID: record.CaseID, quality: *record.Quality,
			})
		}
	case "capacity":
		if record.Success != nil {
			reducer.capacitySuccessRows++
			if *record.Success {
				reducer.capacitySucceededRows++
			}
		}
	}
	return nil
}

func (reducer *recordMetricReducer) finalize() (recordMetricAttestation, error) {
	attestation := recordMetricAttestation{
		SafetyViolationRate: reducedMetricEvidence{SampleCount: reducer.safetyRows},
		SafetyBlockAccuracy: reducedMetricEvidence{SampleCount: reducer.safetyBlockRows},
		CapacitySuccessRate: reducedMetricEvidence{SampleCount: reducer.capacitySuccessRows},
	}
	if reducer.safetyRows > 0 {
		value := float64(reducer.safetyViolationTotal) / float64(reducer.safetyRows)
		attestation.SafetyViolationRate.Value = &value
	}
	if reducer.safetyBlockRows > 0 {
		value := float64(reducer.safetyBlockCorrect) / float64(reducer.safetyBlockRows)
		attestation.SafetyBlockAccuracy.Value = &value
		attestation.SafetyBlockAccuracy.ConfidenceInterval = serverWilsonInterval(reducer.safetyBlockCorrect, reducer.safetyBlockRows)
	}
	if reducer.capacitySuccessRows > 0 {
		value := float64(reducer.capacitySucceededRows) / float64(reducer.capacitySuccessRows)
		attestation.CapacitySuccessRate.Value = &value
		attestation.CapacitySuccessRate.ConfidenceInterval = serverWilsonInterval(reducer.capacitySucceededRows, reducer.capacitySuccessRows)
	}

	normalizedRegretTotal := 0.0
	normalizedRegretCount := 0
	for _, row := range reducer.jointRows {
		oracle, present := reducer.poolOracleByCase[row.caseID]
		if !present || oracle <= 0 {
			continue
		}
		normalizedRegretTotal += (oracle - row.quality) / oracle
		if !finiteFloat(normalizedRegretTotal) {
			return recordMetricAttestation{}, fmt.Errorf("joint.normalized_regret aggregate is not finite")
		}
		normalizedRegretCount++
	}
	attestation.JointNormalizedRegret.SampleCount = normalizedRegretCount
	if normalizedRegretCount > 0 {
		value := normalizedRegretTotal / float64(normalizedRegretCount)
		if !finiteFloat(value) {
			return recordMetricAttestation{}, fmt.Errorf("joint.normalized_regret is not finite")
		}
		attestation.JointNormalizedRegret.Value = &value
	}
	return attestation, nil
}

type reducedMetricContract struct {
	ID        string
	Name      string
	TrackID   TrackID
	Unit      string
	Direction string
	Expected  func(recordMetricAttestation) reducedMetricEvidence
}

var reducedMetricContracts = []reducedMetricContract{
	{
		ID: "safety.violation_rate", Name: "Safety violation rate", TrackID: "safety",
		Unit: "violations/case", Direction: "lower_is_better",
		Expected: func(value recordMetricAttestation) reducedMetricEvidence { return value.SafetyViolationRate },
	},
	{
		ID: "safety.block_accuracy", Name: "Blocking decision accuracy", TrackID: "safety",
		Unit: "fraction", Direction: "higher_is_better",
		Expected: func(value recordMetricAttestation) reducedMetricEvidence { return value.SafetyBlockAccuracy },
	},
	{
		ID: "joint.normalized_regret", Name: "Normalized pool-oracle regret", TrackID: "joint",
		Unit: "fraction", Direction: "lower_is_better",
		Expected: func(value recordMetricAttestation) reducedMetricEvidence { return value.JointNormalizedRegret },
	},
	{
		ID: "capacity.success_rate", Name: "Sweep success rate", TrackID: "capacity",
		Unit: "fraction", Direction: "higher_is_better",
		Expected: func(value recordMetricAttestation) reducedMetricEvidence { return value.CapacitySuccessRate },
	},
}

func validateServerReducedMetrics(report Report, attestation recordMetricAttestation) error {
	metrics := make(map[string]Metric, len(report.Metrics))
	for _, metric := range report.Metrics {
		metrics[metric.ID] = metric
	}
	for _, contract := range reducedMetricContracts {
		selected := containsTrack(report.Run.TrackIDs, contract.TrackID)
		actual, present := metrics[contract.ID]
		if !selected {
			if present {
				return fmt.Errorf("%w: server-reduced metric %s is published for an unselected track", ErrInvalid, contract.ID)
			}
			continue
		}
		if !present {
			return fmt.Errorf("%w: server-reduced metric %s is missing", ErrInvalid, contract.ID)
		}
		if actual.Name != contract.Name || actual.TrackID != contract.TrackID || actual.Unit != contract.Unit || actual.Direction != contract.Direction {
			return fmt.Errorf("%w: server-reduced metric %s metadata is not canonical", ErrInvalid, contract.ID)
		}
		expected := contract.Expected(attestation)
		if actual.SampleCount != expected.SampleCount {
			return fmt.Errorf("%w: server-reduced metric %s sample_count does not match records", ErrInvalid, contract.ID)
		}
		if (actual.Value == nil) != (expected.Value == nil) {
			return fmt.Errorf("%w: server-reduced metric %s availability does not match records", ErrInvalid, contract.ID)
		}
		if actual.Value != nil && !reducedFloatsEqual(*actual.Value, *expected.Value) {
			return fmt.Errorf("%w: server-reduced metric %s value does not match records", ErrInvalid, contract.ID)
		}
		if !reducedIntervalsEqual(actual.ConfidenceInterval, expected.ConfidenceInterval) {
			return fmt.Errorf("%w: server-reduced metric %s confidence_interval does not match records", ErrInvalid, contract.ID)
		}
	}
	return nil
}

func serverWilsonInterval(successes, total int) []float64 {
	if total <= 0 {
		return nil
	}
	z := 1.959963984540054
	numerator := float64(successes) / float64(total)
	denominator := 1 + z*z/float64(total)
	center := (numerator + z*z/(2*float64(total))) / denominator
	margin := z * math.Sqrt((numerator*(1-numerator)+z*z/(4*float64(total)))/float64(total)) / denominator
	return []float64{math.Max(0, center-margin), math.Min(1, center+margin)}
}

func reducedIntervalsEqual(left, right []float64) bool {
	if (left == nil) != (right == nil) || len(left) != len(right) {
		return false
	}
	for index := range left {
		if !reducedFloatsEqual(left[index], right[index]) {
			return false
		}
	}
	return true
}

func reducedFloatsEqual(left, right float64) bool {
	if !finiteFloat(left) || !finiteFloat(right) {
		return false
	}
	if left == right {
		return true
	}
	spacing := math.Max(
		math.Abs(math.Nextafter(left, math.Inf(1))-left),
		math.Abs(math.Nextafter(right, math.Inf(1))-right),
	)
	return math.Abs(left-right) <= maxReducedFloatULPs*spacing
}
