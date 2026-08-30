package evaluationplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateCapacityProfileArtifactAcceptsRepeatedClosedLoopEvidence(t *testing.T) {
	runDir := t.TempDir()
	writeCapacityRecords(t, runDir)
	writeCapacityProfile(t, runDir, capacityTestProfile())
	attestation, err := validateCapacityProfileArtifact(
		runDir,
		capacityManifest(),
		capacityReport(),
		capacityRecordsAttestation(),
	)
	if err != nil {
		t.Fatalf("validateCapacityProfileArtifact: %v", err)
	}
	if attestation == nil || attestation.Headroom != 1 || attestation.LevelCount != 2 {
		t.Fatalf("capacity SLO attestation = %#v", attestation)
	}
}

func TestValidateCapacityProfileArtifactRejectsMalformedOrWeakEvidence(t *testing.T) {
	valid, err := json.Marshal(capacityTestProfile())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "malformed JSON", raw: []byte("{not-json\n")},
		{name: "unknown field", raw: bytes.Replace(valid, []byte(`"kind":"repeated-closed-loop-capacity"`), []byte(`"kind":"repeated-closed-loop-capacity","forged":true`), 1)},
		{name: "missing protocol", raw: bytes.Replace(valid, []byte(`"protocol":{`), []byte(`"protocol":null,"discarded":{`), 1)},
		{name: "tiny measurement window", raw: bytes.Replace(valid, []byte(`"measurement_requests_per_repetition":100`), []byte(`"measurement_requests_per_repetition":2`), 1)},
		{name: "forged derived error bound", raw: bytes.Replace(valid, []byte(`"error_rate_upper_bound":0.008937872175128179`), []byte(`"error_rate_upper_bound":0`), 1)},
		{name: "missing repetition", raw: bytes.Replace(valid, []byte(`"repetition":2`), []byte(`"repetition":9`), 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runDir := t.TempDir()
			writeCapacityRecords(t, runDir)
			if err := os.WriteFile(filepath.Join(runDir, capacityProfileArtifactName), test.raw, 0o600); err != nil {
				t.Fatal(err)
			}
			_, validationErr := validateCapacityProfileArtifact(
				runDir,
				capacityManifest(),
				capacityReport(),
				capacityRecordsAttestation(),
			)
			if !errors.Is(validationErr, ErrInvalid) {
				t.Fatalf("validation error=%v, want ErrInvalid", validationErr)
			}
		})
	}
}

func TestValidateCapacityProfileArtifactRejectsSelfConsistentProfileForgery(t *testing.T) {
	runDir := t.TempDir()
	writeCapacityRecords(t, runDir)
	profile := capacityTestProfile()
	*profile.Levels[0].Throughput += 1
	writeCapacityProfile(t, runDir, profile)
	_, err := validateCapacityProfileArtifact(
		runDir,
		capacityManifest(),
		capacityReport(),
		capacityRecordsAttestation(),
	)
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "does not match records") {
		t.Fatalf("forged profile error=%v, want record mismatch ErrInvalid", err)
	}
}

func TestRealWorkerSealRejectsForgedCapacityProfileWithRecomputedReceipts(t *testing.T) {
	python := os.Getenv("VLLM_SR_EVALUATION_TEST_PYTHON")
	if python == "" {
		t.Skip("set VLLM_SR_EVALUATION_TEST_PYTHON to run the real Python worker")
	}
	pythonRoot, pathErr := filepath.Abs("../../../src/vllm-sr")
	if pathErr != nil {
		t.Fatal(pathErr)
	}
	t.Setenv("PYTHONPATH", pythonRoot)
	t.Setenv("TMPDIR", "/tmp")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/models":
			_, _ = writer.Write([]byte(`{"data":[{"id":"entrypoint-a","routing":{"resolution":"virtual","selectable":true,"default_route":true,"recipe":"default"}}]}`))
		case "/v1/chat/completions":
			writer.Header().Set("x-vsr-selected-model", "Org/Fast Model")
			writer.Header().Set("x-vsr-selected-algorithm", "static")
			writer.Header().Set("x-vsr-selected-recipe", "default")
			writer.Header().Set("x-vsr-selected-decision", "route")
			_, _ = writer.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(server.Close)

	root := filepath.Join(t.TempDir(), "evaluation")
	if mkdirErr := os.Mkdir(root, 0o700); mkdirErr != nil {
		t.Fatal(mkdirErr)
	}
	configPath := filepath.Join(root, "config.yaml")
	if writeErr := os.WriteFile(configPath, []byte(modelArmTestYAML), 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	service, serviceErr := NewService(Options{
		DataDir: root, PythonPath: python, ConfigPath: configPath,
		RouterAPIURL: server.URL, EnvoyURL: server.URL,
		CodeRevision: testSourceRevision, MaxConcurrent: 1, Process: &controlledProcess{},
	})
	if serviceErr != nil {
		t.Fatalf("NewService: %v", serviceErr)
	}
	t.Cleanup(func() { _ = service.Close() })
	run, createErr := service.CreateRun(context.Background(), CreateRunRequest{
		ClientRequestID: newTestClientRequestID(),
		Name:            "capacity receipt forgery", SuiteIDs: []string{"live-capacity"},
		TrackIDs: []TrackID{"capacity"}, Mode: ModeLive, TargetID: mixtureTargetID("default"),
		ChangeProfile: "runtime_capacity", SampleLimit: 4, Concurrency: 2, Seed: 17,
		CapacitySLO:          testCapacitySLO(2),
		CapacityLoadProtocol: defaultCapacityLoadProtocol(2),
	})
	if createErr != nil {
		t.Fatalf("CreateRun: %v", createErr)
	}
	startedAt := time.Now().UTC()
	run.Status = StatusRunning
	run.StartedAt = &startedAt
	if updateErr := service.store.UpdateRun(run); updateErr != nil {
		t.Fatalf("stage running run: %v", updateErr)
	}
	spec := ProcessSpec{
		ManifestPath:       filepath.Join(root, "runs", run.ID, manifestFileName),
		StorePath:          root,
		SuiteStorePath:     service.store.SuiteRoot(),
		executionContracts: serviceExecutionContractsForTest(t, service),
	}
	result, processErr := NewCommandProcess(python).Run(context.Background(), spec, func(WorkerEvent) error { return nil })
	if processErr != nil {
		t.Fatalf("real capacity worker: %v", processErr)
	}
	defer result.discardStagedEvidence()
	if err := service.beginSealing(run.ID); err != nil {
		t.Fatalf("begin capacity evidence sealing: %v", err)
	}
	if err := result.publishStagedEvidence(); err != nil {
		t.Fatalf("publish capacity worker evidence: %v", err)
	}
	if _, err := service.persistExecutionAttestation(run.ID, result.ExecutionTranscript); err != nil {
		t.Fatalf("attest real capacity worker: %v", err)
	}
	if err := forgeCapacityProfileWithRecomputedReceipts(filepath.Join(root, "runs", run.ID)); err != nil {
		t.Fatalf("forge self-consistent capacity bundle: %v", err)
	}
	if _, err := service.validatePrivateReceipt(run.ID); err != nil {
		t.Fatalf("recomputed private receipt is not self-consistent: %v", err)
	}
	sealErr := service.validateAndAnchorReport(run.ID)
	if !errors.Is(sealErr, ErrInvalid) || !strings.Contains(sealErr.Error(), "capacity profile does not match records") {
		t.Fatalf("forged capacity seal error=%v, want records mismatch ErrInvalid", sealErr)
	}
}

func forgeCapacityProfileWithRecomputedReceipts(runDir string) error {
	var profile map[string]any
	if err := readJSON(filepath.Join(runDir, capacityProfileArtifactName), &profile); err != nil {
		return err
	}
	levels, ok := profile["levels"].([]any)
	if !ok || len(levels) == 0 {
		return fmt.Errorf("capacity profile has no forgeable level")
	}
	level, ok := levels[0].(map[string]any)
	if !ok {
		return fmt.Errorf("capacity profile level is not an object")
	}
	throughput, ok := level["throughput_rps"].(float64)
	if !ok {
		return fmt.Errorf("capacity throughput is not numeric")
	}
	level["throughput_rps"] = throughput + 1
	if err := writeJSONAtomic(filepath.Join(runDir, capacityProfileArtifactName), profile); err != nil {
		return err
	}

	var report Report
	if err := readJSON(filepath.Join(runDir, reportFileName), &report); err != nil {
		return err
	}
	var receipt strings.Builder
	update := func(artifact *Artifact, includeReceipt bool) error {
		if artifact.Name == publicChecksumArtifactName {
			return nil
		}
		data, err := os.ReadFile(filepath.Join(runDir, artifact.Name))
		if err != nil {
			return err
		}
		artifact.Digest = digestBytes(data)
		artifact.SizeBytes = int64(len(data))
		if includeReceipt {
			receipt.WriteString(strings.TrimPrefix(artifact.Digest, "sha256:"))
			receipt.WriteString("  ")
			receipt.WriteString(artifact.Name)
			receipt.WriteByte('\n')
		}
		return nil
	}
	for index := range report.Artifacts {
		if err := update(&report.Artifacts[index], true); err != nil {
			return err
		}
	}
	for trackIndex := range report.Tracks {
		for artifactIndex := range report.Tracks[trackIndex].Artifacts {
			if err := update(&report.Tracks[trackIndex].Artifacts[artifactIndex], true); err != nil {
				return err
			}
		}
	}
	receiptBytes := []byte(receipt.String())
	if err := os.WriteFile(filepath.Join(runDir, publicChecksumArtifactName), receiptBytes, 0o600); err != nil {
		return err
	}
	updateReceipt := func(artifact *Artifact) {
		if artifact.Name == publicChecksumArtifactName {
			artifact.Digest = digestBytes(receiptBytes)
			artifact.SizeBytes = int64(len(receiptBytes))
		}
	}
	for index := range report.Artifacts {
		updateReceipt(&report.Artifacts[index])
	}
	for trackIndex := range report.Tracks {
		for artifactIndex := range report.Tracks[trackIndex].Artifacts {
			updateReceipt(&report.Tracks[trackIndex].Artifacts[artifactIndex])
		}
	}
	if err := writeJSONAtomic(filepath.Join(runDir, reportFileName), workerReportFromReport(report)); err != nil {
		return err
	}
	return writeTestPrivateReceiptWithoutTesting(runDir)
}

func capacityManifest() RunManifest {
	return RunManifest{
		Mode: ModeLive, TrackIDs: []TrackID{"capacity"}, Concurrency: 2,
		CapacitySLO:          testCapacitySLO(1),
		CapacityLoadProtocol: defaultCapacityLoadProtocol(2),
	}
}

func testCapacitySLO(required int64) *CapacitySLO {
	return &CapacitySLO{
		SchemaVersion: SchemaVersion, RequiredConcurrency: required,
		MaxLatencyP95MS: 30, MaxErrorRate: 0.05, MinThroughputRPS: 1,
		MinThroughputScalingEfficiency: 0.5,
	}
}

func capacityReport() Report {
	return Report{Artifacts: []Artifact{{
		Name: capacityProfileArtifactName, URI: capacityProfileArtifactName, MediaType: "application/json",
	}}}
}

func capacityTestProfile() capacityProfileEvidence {
	protocol := defaultCapacityLoadProtocol(2)
	slo := testCapacitySLO(1)
	levels := make([]capacityProfileLevel, 0, len(protocol.ConcurrencyLevels))
	for levelIndex, concurrency := range protocol.ConcurrencyLevels {
		throughput := float64(concurrency * 10)
		repetitions := make([]capacityProfileRepetition, 0, protocol.RepetitionsPerLevel)
		for repetition := int64(1); repetition <= protocol.RepetitionsPerLevel; repetition++ {
			repetitions = append(repetitions, capacityProfileRepetition{
				Concurrency: capacityInt64Pointer(concurrency), Repetition: capacityInt64Pointer(repetition),
				Requests: capacityInt64Pointer(100), Successes: capacityInt64Pointer(100), Errors: capacityInt64Pointer(0),
				Elapsed: capacityFloatPointer(100 / throughput), Throughput: capacityFloatPointer(throughput),
				LatencyP95MS: capacityFloatPointer(20),
			})
		}
		runtimeCost := 0.0
		for range 300 {
			runtimeCost += 0.001
		}
		scaling := json.RawMessage("null")
		if levelIndex > 0 {
			scaling = json.RawMessage("1")
		}
		levels = append(levels, capacityProfileLevel{
			Concurrency:    capacityInt64Pointer(concurrency),
			WarmupRequests: capacityInt64Pointer(concurrency * 2), WarmupErrors: capacityInt64Pointer(0),
			WarmupElapsed: capacityFloatPointer(0.2), MeasurementRequests: capacityInt64Pointer(300),
			Successes: capacityInt64Pointer(300), Errors: capacityInt64Pointer(0),
			Elapsed: capacityFloatPointer(300 / throughput), Throughput: capacityFloatPointer(throughput),
			ThroughputCV: capacityFloatPointer(0), LatencyP50MS: capacityFloatPointer(20),
			LatencyP95MS: capacityFloatPointer(20), LatencyP99MS: capacityFloatPointer(20),
			LatencyP95CV: capacityFloatPointer(0), ErrorRate: capacityFloatPointer(0),
			ErrorRateUpperBound: capacityFloatPointer(capacityOneSidedWilsonUpper(0, 300)),
			InputTokens:         capacityInt64Pointer(300), OutputTokens: capacityInt64Pointer(300),
			RuntimeCost: capacityFloatPointer(runtimeCost), Repetitions: repetitions,
			ScalingEfficiency: scaling, WarmupPassed: capacityBoolPointer(true),
			LatencySLOPassed: capacityBoolPointer(true), ErrorSLOPassed: capacityBoolPointer(true),
			ThroughputSLOPassed: capacityBoolPointer(true), ScalingSLOPassed: capacityBoolPointer(true),
			ThroughputStabilityPassed: capacityBoolPointer(true), LatencyStabilityPassed: capacityBoolPointer(true),
			Qualified: capacityBoolPointer(true),
		})
	}
	return capacityProfileEvidence{
		SchemaVersion: SchemaVersion, Kind: "repeated-closed-loop-capacity",
		Protocol: protocol, Levels: levels, SLO: slo,
		Assessment: capacityProfileAssessment{
			QualifiedConcurrency: json.RawMessage("2"), SaturationConcurrency: json.RawMessage("null"),
			SLOHeadroom: capacityInt64Pointer(1), Verdict: "pass", FailureReasons: []string{},
		},
	}
}

func writeCapacityProfile(t *testing.T, runDir string, profile capacityProfileEvidence) {
	t.Helper()
	if err := writeJSONAtomic(filepath.Join(runDir, capacityProfileArtifactName), profile); err != nil {
		t.Fatal(err)
	}
}

func writeCapacityRecords(t *testing.T, runDir string) {
	t.Helper()
	protocol := defaultCapacityLoadProtocol(2)
	var output bytes.Buffer
	for _, concurrency := range protocol.ConcurrencyLevels {
		writeCapacityBatchRows(t, &output, concurrency, "warmup", 0, concurrency*2, float64(concurrency*10))
		for repetition := int64(1); repetition <= protocol.RepetitionsPerLevel; repetition++ {
			writeCapacityBatchRows(t, &output, concurrency, "measurement", repetition, 100, float64(concurrency*10))
		}
	}
	if err := os.WriteFile(filepath.Join(runDir, "records.jsonl"), output.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeCapacityBatchRows(
	t *testing.T,
	output *bytes.Buffer,
	concurrency int64,
	phase string,
	repetition int64,
	requests int64,
	throughput float64,
) {
	t.Helper()
	for index := int64(0); index < requests; index++ {
		attempt := fmt.Sprintf("capacity-c%d-%s%d-q%d", concurrency, phase[:1], repetition, index)
		receipt := digestBytes([]byte(attempt))
		record := executionRecordEvidence{
			SchemaVersion: SchemaVersion, ID: attempt, TrackID: "capacity", CaseID: "case-1", AttemptID: attempt,
			Status: "succeeded", Success: capacityBoolPointer(true), LatencyMS: capacityFloatPointer(20),
			InputTokens: capacityInt64Pointer(1), OutputTokens: capacityInt64Pointer(1), RuntimeCost: capacityFloatPointer(0.001),
			Concurrency: capacityInt64Pointer(concurrency), ThroughputRPS: capacityFloatPointer(throughput),
			LoadElapsedSeconds: capacityFloatPointer(float64(requests) / throughput),
			LoadPhase:          &phase, LoadRepetition: capacityInt64Pointer(repetition), LoadRequestIndex: capacityInt64Pointer(index),
			EvidenceKind: capacityStringPointer("capacity.closed-loop.v1"), BrokerReceipt: &receipt,
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		output.Write(encoded)
		output.WriteByte('\n')
	}
}

func capacityRecordsAttestation() recordAttestation {
	const total = 606
	return recordAttestation{
		validated: true, Total: total, Succeeded: total,
		ByTrack: map[TrackID]recordStatusCounts{"capacity": {Succeeded: total}},
	}
}

func capacityBoolPointer(value bool) *bool { return &value }

func capacityStringPointer(value string) *string { return &value }
