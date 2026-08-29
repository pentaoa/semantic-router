package evaluationplane

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func diagnosticGateReport() Report {
	run := Run{EvidenceLevel: "E0", ChangeProfile: "schema_adapter"}
	gates := testReleaseGates(run.ChangeProfile, time.Now().UTC())
	setTestGatePlanCoverage(gates, "routing", 1, 1)
	return Report{
		Run: run,
		Summary: ReportSummary{
			Verdict: "unavailable", PassedGates: 2, UnavailableGates: 5,
		},
		Gates: gates,
	}
}

func diagnosticRecordAttestation() recordAttestation {
	return recordAttestation{
		validated: true, Total: 1, Succeeded: 1,
		ByTrack: map[TrackID]recordStatusCounts{"routing": {Succeeded: 1}},
		PlannedCaseIDsByTrack: map[TrackID]map[string]struct{}{
			"routing": {"case-1": {}},
		},
		EvaluatedCaseIDsByTrack: map[TrackID]map[string]struct{}{
			"routing": {"case-1": {}},
		},
	}
}

func TestServerOwnedGateReducerRejectsForgedPassesAndUnknownThresholds(t *testing.T) {
	valid := diagnosticGateReport()
	records := diagnosticRecordAttestation()
	if err := validateServerOwnedGateSemantics(valid, records); err != nil {
		t.Fatalf("canonical diagnostic gates rejected: %v", err)
	}

	t.Run("missing records attestation", func(t *testing.T) {
		if err := validateServerOwnedGateSemantics(diagnosticGateReport(), recordAttestation{}); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "records attestation") {
			t.Fatalf("missing records attestation error=%v, want ErrInvalid", err)
		}
	})

	t.Run("forged records coverage", func(t *testing.T) {
		forged := diagnosticGateReport()
		forged.Gates[0].Coverage.Total = 2
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "records attestation") {
			t.Fatalf("forged records coverage error=%v, want ErrInvalid", err)
		}
	})

	t.Run("unknown operator", func(t *testing.T) {
		forged := diagnosticGateReport()
		forged.Gates[0].Threshold.Operator = "approximately"
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "threshold") {
			t.Fatalf("unknown operator error=%v, want threshold ErrInvalid", err)
		}
	})

	t.Run("low safety metric marked pass", func(t *testing.T) {
		forged := diagnosticGateReport()
		violationRate := 0.5
		forged.Metrics = []Metric{{ID: "safety.violation_rate", Value: &violationRate}}
		forged.Gates[2].Verdict = "pass"
		forged.Gates[2].Observed = &violationRate
		forged.Gates[2].Threshold = &GateThreshold{Operator: "<=", Value: 0, Unit: "violations/case"}
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "contradicts") {
			t.Fatalf("forged low-metric pass error=%v, want contradiction ErrInvalid", err)
		}
	})

	t.Run("observed does not match metric", func(t *testing.T) {
		forged := diagnosticGateReport()
		metricValue, claimed := 0.5, 0.25
		forged.Metrics = []Metric{{ID: "safety.violation_rate", Value: &metricValue}}
		forged.Gates[2].Verdict = "fail"
		forged.Gates[2].Observed = &claimed
		forged.Gates[2].Threshold = &GateThreshold{Operator: "<=", Value: 0, Unit: "violations/case"}
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "does not match metric") {
			t.Fatalf("forged observed error=%v, want metric mismatch ErrInvalid", err)
		}
	})

	t.Run("E0 promotion pass", func(t *testing.T) {
		forged := diagnosticGateReport()
		forged.Summary.Verdict = "pass"
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "E0") {
			t.Fatalf("E0 pass error=%v, want E0 ErrInvalid", err)
		}
	})

	t.Run("unattested promotion gate", func(t *testing.T) {
		forged := diagnosticGateReport()
		observed := 1.0
		forged.Gates[4].Verdict = "pass"
		forged.Gates[4].Observed = &observed
		forged.Gates[4].Threshold = &GateThreshold{Operator: ">=", Value: 1, Unit: "boolean"}
		if err := validateServerOwnedGateSemantics(forged, records); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "server-owned") {
			t.Fatalf("unattested pass error=%v, want attestation ErrInvalid", err)
		}
	})
}

func TestServerOwnedGateReducerRejectsEveryUnqualifiedG2ThroughG9Verdict(t *testing.T) {
	thresholds := map[int]GateThreshold{
		2: {Operator: "<=", Value: 0, Unit: "violations/case"},
		3: {Operator: "<=", Value: defaultNormalizedRegretMaximum, Unit: "fraction"},
		4: {Operator: ">=", Value: 1, Unit: "boolean"},
		5: {Operator: ">=", Value: 1, Unit: "boolean"},
		6: {Operator: ">=", Value: 1, Unit: "boolean"},
		7: {Operator: ">=", Value: defaultCapacitySuccessMinimum, Unit: "fraction"},
		8: {Operator: ">=", Value: 1, Unit: "boolean"},
		9: {Operator: ">=", Value: 1, Unit: "boolean"},
	}
	for index := 2; index < 10; index++ {
		for _, verdict := range []GateVerdict{"pass", "fail"} {
			t.Run(reportGateTestName(index, verdict), func(t *testing.T) {
				report := diagnosticGateReport()
				gate := &report.Gates[index]
				gate.Disposition = "advisory"
				gate.Verdict = verdict
				threshold := thresholds[index]
				gate.Threshold = &threshold
				observed := threshold.Value
				if verdict == "fail" {
					if threshold.Operator == ">=" {
						observed = threshold.Value - 0.5
					} else {
						observed = threshold.Value + 0.5
					}
				}
				gate.Observed = &observed
				switch index {
				case 2:
					report.Metrics = []Metric{{ID: "safety.violation_rate", Value: &observed}}
				case 3:
					report.Metrics = []Metric{{ID: "joint.normalized_regret", Value: &observed}}
				case 7:
					report.Metrics = []Metric{{ID: "capacity.success_rate", Value: &observed}}
				}
				err := validateServerOwnedGateSemantics(report, diagnosticRecordAttestation())
				if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "qualification attestation") {
					t.Fatalf("gate %s verdict %s error=%v, want qualification ErrInvalid", gate.ID, verdict, err)
				}
			})
		}
	}
}

func TestServerOwnedGateReducerRejectsObservationOnUnavailableGate(t *testing.T) {
	report := diagnosticGateReport()
	observed := 0.1
	report.Gates[3].Observed = &observed
	report.Metrics = []Metric{{ID: "joint.normalized_regret", Value: &observed}}
	err := validateServerOwnedGateSemantics(report, diagnosticRecordAttestation())
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "qualification attestation") {
		t.Fatalf("unqualified observation error=%v, want qualification ErrInvalid", err)
	}
}

func TestServerOwnedGateReducerRejectsWorkerOwnedGateCoverageInterval(t *testing.T) {
	report := diagnosticGateReport()
	report.Gates[0].Coverage.ConfidenceLevel = 0.95
	report.Gates[0].Coverage.ConfidenceInterval = []float64{0.99, 1}
	err := validateServerOwnedGateSemantics(report, diagnosticRecordAttestation())
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "records attestation") {
		t.Fatalf("worker-owned gate interval error=%v, want coverage ErrInvalid", err)
	}
}

func TestServerOwnedGateReducerRejectsHundredCasePlanReportedAsOneOfOne(t *testing.T) {
	report := diagnosticGateReport()
	records := diagnosticRecordAttestation()
	records.PlannedCaseIDsByTrack["routing"] = make(map[string]struct{}, 100)
	for index := range 100 {
		records.PlannedCaseIDsByTrack["routing"][fmt.Sprintf("case-%d", index)] = struct{}{}
	}
	err := validateServerOwnedGateSemantics(report, records)
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "records attestation") {
		t.Fatalf("omitted plan cells error=%v, want records coverage ErrInvalid", err)
	}
}

func reportGateTestName(index int, verdict GateVerdict) string {
	return fmt.Sprintf("G%d-%s", index, verdict)
}
