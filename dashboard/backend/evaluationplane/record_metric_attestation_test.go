package evaluationplane

import (
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func boolPointer(value bool) *bool        { return &value }
func floatPointer(value float64) *float64 { return &value }
func int64Pointer(value int64) *int64     { return &value }

func TestRecordMetricReducerMatchesPythonGateMetricSemantics(t *testing.T) {
	reducer := newRecordMetricReducer()
	records := []executionRecordEvidence{
		{TrackID: "safety", Status: "succeeded", SafetyViolations: int64Pointer(2), ShouldBlock: boolPointer(true), Blocked: boolPointer(true)},
		{TrackID: "safety", Status: "failed", ShouldBlock: boolPointer(true), Blocked: boolPointer(false)},
		{TrackID: "safety", Status: "unavailable", SafetyViolations: int64Pointer(100), ShouldBlock: boolPointer(true), Blocked: boolPointer(false)},
		{TrackID: "model_pool", CaseID: "case-1", Status: "succeeded", Success: boolPointer(true), Quality: floatPointer(0.8)},
		{TrackID: "model_pool", CaseID: "case-1", Status: "failed", Success: boolPointer(false), Quality: floatPointer(1)},
		{TrackID: "model_pool", CaseID: "case-1", Status: "unavailable", Success: boolPointer(true), Quality: floatPointer(1)},
		{TrackID: "model_pool", CaseID: "case-2", Status: "succeeded", Success: boolPointer(true), Quality: floatPointer(0)},
		{TrackID: "model_pool", CaseID: "case-3", Status: "succeeded", Success: boolPointer(true), Quality: floatPointer(0.5)},
		{TrackID: "joint", CaseID: "case-1", Status: "succeeded", Quality: floatPointer(0.4)},
		{TrackID: "joint", CaseID: "case-1", Status: "failed", Quality: floatPointer(0.8)},
		{TrackID: "joint", CaseID: "case-2", Status: "succeeded", Quality: floatPointer(0)},
		{TrackID: "joint", CaseID: "case-3", Status: "succeeded", Quality: floatPointer(0.75)},
		{TrackID: "joint", CaseID: "case-1", Status: "unavailable", Quality: floatPointer(0)},
		{TrackID: "capacity", Status: "succeeded", Success: boolPointer(true)},
		{TrackID: "capacity", Status: "failed", Success: boolPointer(false)},
		{TrackID: "capacity", Status: "succeeded"},
		{TrackID: "capacity", Status: "unavailable", Success: boolPointer(false)},
	}
	for _, record := range records {
		if err := reducer.observe(record); err != nil {
			t.Fatalf("observe(%+v): %v", record, err)
		}
	}
	attestation, err := reducer.finalize()
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	assertReducedMetric(t, attestation.SafetyViolationRate, 1, 2)
	assertReducedMetric(t, attestation.SafetyBlockAccuracy, 0.5, 2)
	assertReducedMetric(t, attestation.JointNormalizedRegret, 0, 3)
	assertReducedMetric(t, attestation.CapacitySuccessRate, 0.5, 2)
}

func TestRecordMetricReducerMatchesPythonCanonicalOrderedRegret(t *testing.T) {
	python := os.Getenv("VLLM_SR_EVALUATION_TEST_PYTHON")
	if python == "" {
		t.Skip("set VLLM_SR_EVALUATION_TEST_PYTHON to run the cross-runtime reducer test")
	}

	reducer := newRecordMetricReducer()
	oracle := 1e-16
	largeQuality := 1.0
	zeroQuality := 0.0
	poolRecord := executionRecordEvidence{
		SchemaVersion: SchemaVersion, ID: "pool-case", AttemptID: "attempt-pool",
		TrackID: "model_pool", CaseID: "case", Status: "succeeded",
		Success: boolPointer(true), Quality: &oracle,
	}
	largeRegretRecord := executionRecordEvidence{
		SchemaVersion: SchemaVersion, ID: "joint-case-0", AttemptID: "attempt-joint-0",
		TrackID: "joint", CaseID: "case", Status: "succeeded", Quality: &largeQuality,
	}
	selectedTracks := map[TrackID]bool{"model_pool": true, "joint": true}
	caseIDs := map[string]struct{}{"case": {}}
	if err := validateExecutionRecord(poolRecord, selectedTracks, caseIDs); err != nil {
		t.Fatalf("pool boundary record is not legal: %v", err)
	}
	if err := validateExecutionRecord(largeRegretRecord, selectedTracks, caseIDs); err != nil {
		t.Fatalf("joint boundary record is not legal: %v", err)
	}
	if err := reducer.observe(poolRecord); err != nil {
		t.Fatal(err)
	}
	if err := reducer.observe(largeRegretRecord); err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= 99_999; index++ {
		record := executionRecordEvidence{
			SchemaVersion: SchemaVersion, ID: fmt.Sprintf("joint-case-%d", index), AttemptID: fmt.Sprintf("attempt-joint-%d", index),
			TrackID: "joint", CaseID: "case", Status: "succeeded", Quality: &zeroQuality,
		}
		if err := validateExecutionRecord(record, selectedTracks, caseIDs); err != nil {
			t.Fatalf("joint record %d is not legal: %v", index, err)
		}
		if err := reducer.observe(record); err != nil {
			t.Fatal(err)
		}
	}
	attestation, err := reducer.finalize()
	if err != nil {
		t.Fatal(err)
	}
	if attestation.JointNormalizedRegret.Value == nil {
		t.Fatal("Go reducer returned an unavailable normalized regret")
	}

	pythonRoot, err := filepath.Abs("../../../src/vllm-sr")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(python, "-c", `
from cli.evaluation.metric_core import _canonical_ordered_float_sum
oracle = 1e-16
values = [(oracle - 1.0) / oracle]
values.extend((oracle - 0.0) / oracle for _ in range(99_999))
print(repr(_canonical_ordered_float_sum(values) / len(values)))
`)
	command.Dir = pythonRoot
	output, err := command.Output()
	if err != nil {
		t.Fatalf("run Python canonical reducer: %v", err)
	}
	pythonValue, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil {
		t.Fatalf("parse Python canonical reducer output %q: %v", output, err)
	}
	if math.Float64bits(*attestation.JointNormalizedRegret.Value) != math.Float64bits(pythonValue) {
		t.Fatalf("Go normalized regret=%v, Python normalized regret=%v", *attestation.JointNormalizedRegret.Value, pythonValue)
	}
}

func assertReducedMetric(t *testing.T, metric reducedMetricEvidence, wantValue float64, wantSamples int) {
	t.Helper()
	if metric.Value == nil || !reducedFloatsEqual(*metric.Value, wantValue) || metric.SampleCount != wantSamples {
		t.Fatalf("metric=%+v, want value=%v samples=%d", metric, wantValue, wantSamples)
	}
}

func TestRecordMetricReducerChecksSafetyAggregateOverflow(t *testing.T) {
	reducer := newRecordMetricReducer()
	maximum := int64(^uint64(0) >> 1)
	record := executionRecordEvidence{TrackID: "safety", Status: "succeeded", SafetyViolations: &maximum}
	if err := reducer.observe(record); err != nil {
		t.Fatal(err)
	}
	if err := reducer.observe(record); err != nil {
		t.Fatal(err)
	}
	if err := reducer.observe(record); err == nil || !strings.Contains(err.Error(), "overflows") {
		t.Fatalf("overflow error=%v", err)
	}
}

func TestValidateServerReducedMetricsRejectsForgedValueCountAndMetadata(t *testing.T) {
	attestation := recordMetricAttestation{
		SafetyViolationRate:   reducedMetricEvidence{Value: floatPointer(0.5), SampleCount: 2},
		SafetyBlockAccuracy:   reducedMetricEvidence{Value: floatPointer(1), ConfidenceInterval: serverWilsonInterval(2, 2), SampleCount: 2},
		JointNormalizedRegret: reducedMetricEvidence{Value: floatPointer(0.2), SampleCount: 3},
		CapacitySuccessRate:   reducedMetricEvidence{Value: floatPointer(0.75), ConfidenceInterval: serverWilsonInterval(3, 4), SampleCount: 4},
	}
	report := Report{
		Run: Run{TrackIDs: []TrackID{"safety", "joint", "capacity"}},
		Metrics: []Metric{
			canonicalReducedMetric("safety.violation_rate", "Safety violation rate", "safety", "violations/case", "lower_is_better", 0.5, 2),
			canonicalReducedMetric("safety.block_accuracy", "Blocking decision accuracy", "safety", "fraction", "higher_is_better", 1, 2),
			canonicalReducedMetric("joint.normalized_regret", "Normalized pool-oracle regret", "joint", "fraction", "lower_is_better", 0.2, 3),
			canonicalReducedMetric("capacity.success_rate", "Sweep success rate", "capacity", "fraction", "higher_is_better", 0.75, 4),
		},
	}
	report.Metrics[1].ConfidenceInterval = append([]float64(nil), attestation.SafetyBlockAccuracy.ConfidenceInterval...)
	report.Metrics[3].ConfidenceInterval = append([]float64(nil), attestation.CapacitySuccessRate.ConfidenceInterval...)
	if err := validateServerReducedMetrics(report, attestation); err != nil {
		t.Fatalf("canonical reduced metrics rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Metric)
		match  string
	}{
		{name: "value", mutate: func(metric *Metric) { metric.Value = floatPointer(0.6) }, match: "value does not match"},
		{name: "availability", mutate: func(metric *Metric) { metric.Value = nil }, match: "availability"},
		{name: "sample count", mutate: func(metric *Metric) { metric.SampleCount++ }, match: "sample_count"},
		{name: "name", mutate: func(metric *Metric) { metric.Name = "Trust me" }, match: "metadata"},
		{name: "track", mutate: func(metric *Metric) { metric.TrackID = "joint" }, match: "metadata"},
		{name: "unit", mutate: func(metric *Metric) { metric.Unit = "percent" }, match: "metadata"},
		{name: "direction", mutate: func(metric *Metric) { metric.Direction = "target" }, match: "metadata"},
		{name: "confidence interval", mutate: func(metric *Metric) { metric.ConfidenceInterval = []float64{0.99, 1} }, match: "confidence_interval"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			forged := report
			forged.Metrics = append([]Metric(nil), report.Metrics...)
			test.mutate(&forged.Metrics[0])
			err := validateServerReducedMetrics(forged, attestation)
			if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("error=%v, want ErrInvalid containing %q", err, test.match)
			}
		})
	}
}

func TestValidateWorkerSingleRunMetricOwnershipRejectsComparisons(t *testing.T) {
	baseline := 0.4
	delta := 0.1
	err := validateWorkerSingleRunMetricOwnership([]Metric{{ID: "routing.accuracy", BaselineValue: &baseline, Delta: &delta}})
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "baseline_value or delta") {
		t.Fatalf("comparison ownership error=%v", err)
	}
}

func canonicalReducedMetric(id, name string, track TrackID, unit, direction string, value float64, samples int) Metric {
	return Metric{ID: id, Name: name, TrackID: track, Value: floatPointer(value), Unit: unit, Direction: direction, SampleCount: samples}
}

func TestReducedFloatComparisonIsTightAndFinite(t *testing.T) {
	base := 0.2
	within := base
	for range maxReducedFloatULPs {
		within = math.Nextafter(within, math.Inf(1))
	}
	outside := math.Nextafter(within, math.Inf(1))
	if !reducedFloatsEqual(base, within) {
		t.Fatal("eight ULP difference was rejected")
	}
	if reducedFloatsEqual(base, outside) {
		t.Fatal("nine ULP difference was accepted")
	}
	if reducedFloatsEqual(math.Inf(1), math.Inf(1)) || reducedFloatsEqual(math.NaN(), math.NaN()) {
		t.Fatal("non-finite values were accepted")
	}
}
