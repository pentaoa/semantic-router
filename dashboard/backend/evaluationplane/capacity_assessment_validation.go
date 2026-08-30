package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
)

type capacityProfileAssessment struct {
	QualifiedConcurrency  json.RawMessage `json:"qualified_concurrency"`
	SaturationConcurrency json.RawMessage `json:"saturation_concurrency"`
	SLOHeadroom           *int64          `json:"slo_headroom"`
	Verdict               string          `json:"verdict"`
	FailureReasons        []string        `json:"failure_reasons"`
}

type capacitySLOAttestation struct {
	Headroom   float64
	LevelCount int
}

func validateCapacitySLOMetric(report Report, attestation *capacitySLOAttestation) error {
	var metric *Metric
	for index := range report.Metrics {
		if report.Metrics[index].ID == "capacity.slo_headroom" {
			metric = &report.Metrics[index]
			break
		}
	}
	selected := containsTrack(report.Run.TrackIDs, "capacity")
	if !selected {
		if metric != nil {
			return fmt.Errorf("%w: capacity SLO metric is published for an unselected track", ErrInvalid)
		}
		return nil
	}
	if metric == nil || metric.Name != "Qualified concurrency above the frozen SLO requirement" ||
		metric.TrackID != "capacity" || metric.Unit != "concurrency" || metric.Direction != "higher_is_better" {
		return fmt.Errorf("%w: capacity SLO metric metadata is not canonical", ErrInvalid)
	}
	if attestation == nil {
		if metric.Value != nil || metric.SampleCount != 0 {
			return fmt.Errorf("%w: capacity metric cannot claim unattested SLO headroom", ErrInvalid)
		}
		return nil
	}
	if metric.Value == nil || !reducedFloatsEqual(*metric.Value, attestation.Headroom) ||
		metric.SampleCount != attestation.LevelCount {
		return fmt.Errorf("%w: capacity SLO metric does not match the server-reduced profile", ErrInvalid)
	}
	return nil
}

func validateCapacityAssessment(
	profile capacityProfileEvidence,
	levels []reducedCapacityLevel,
) (int64, error) {
	if profile.Assessment.SLOHeadroom == nil || profile.Assessment.FailureReasons == nil {
		return 0, fmt.Errorf("assessment requires headroom and failure reasons")
	}
	actualQualified, qualifiedPresent, err := decodeCapacityOptionalInt(
		"assessment.qualified_concurrency",
		profile.Assessment.QualifiedConcurrency,
	)
	if err != nil {
		return 0, err
	}
	actualSaturation, saturationPresent, err := decodeCapacityOptionalInt(
		"assessment.saturation_concurrency",
		profile.Assessment.SaturationConcurrency,
	)
	if err != nil {
		return 0, err
	}

	qualified := int64(0)
	expectedQualifiedPresent := false
	saturation := int64(0)
	expectedSaturationPresent := false
	for _, level := range levels {
		if level.qualified {
			qualified = level.concurrency
			expectedQualifiedPresent = true
		} else if !expectedSaturationPresent {
			saturation = level.concurrency
			expectedSaturationPresent = true
		}
	}
	headroom := -profile.SLO.RequiredConcurrency
	if expectedQualifiedPresent {
		headroom = qualified - profile.SLO.RequiredConcurrency
	}
	verdict := "fail"
	if headroom >= 0 {
		verdict = "pass"
	}
	reasons := capacityFailureReasons(levels, profile.SLO, qualified, expectedQualifiedPresent)
	if qualifiedPresent != expectedQualifiedPresent ||
		(qualifiedPresent && actualQualified != qualified) ||
		saturationPresent != expectedSaturationPresent ||
		(saturationPresent && actualSaturation != saturation) ||
		*profile.Assessment.SLOHeadroom != headroom ||
		profile.Assessment.Verdict != verdict ||
		!reflect.DeepEqual(profile.Assessment.FailureReasons, reasons) {
		return 0, fmt.Errorf("assessment does not match the server-reduced capacity envelope")
	}
	return headroom, nil
}

func capacityFailureReasons(
	levels []reducedCapacityLevel,
	slo *CapacitySLO,
	qualified int64,
	qualifiedPresent bool,
) []string {
	if qualifiedPresent && qualified >= slo.RequiredConcurrency {
		return []string{}
	}
	var target *reducedCapacityLevel
	for index := range levels {
		if levels[index].concurrency >= slo.RequiredConcurrency {
			target = &levels[index]
			break
		}
	}
	if target == nil {
		return []string{"required_concurrency"}
	}
	reasons := make([]string, 0, 7)
	checks := []struct {
		passed bool
		reason string
	}{
		{target.warmupPassed, "warmup_errors"},
		{target.latencyPassed, "latency_p95"},
		{target.errorPassed, "error_rate_upper_bound"},
		{target.throughputPassed, "throughput"},
		{target.scalingPassed, "throughput_scaling"},
		{target.throughputStable, "throughput_stability"},
		{target.latencyStable, "latency_stability"},
	}
	for _, check := range checks {
		if !check.passed {
			reasons = append(reasons, check.reason)
		}
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "required_concurrency")
	}
	return reasons
}

func decodeCapacityOptionalInt(name string, raw json.RawMessage) (int64, bool, error) {
	if len(raw) == 0 {
		return 0, false, fmt.Errorf("%s is required", name)
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return 0, false, nil
	}
	var value int64
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if err := decoder.Decode(&value); err != nil {
		return 0, false, fmt.Errorf("%s must be a positive integer or null", name)
	}
	if err := ensureJSONEOF(decoder); err != nil || value <= 0 {
		return 0, false, fmt.Errorf("%s must be a positive integer or null", name)
	}
	return value, true, nil
}
