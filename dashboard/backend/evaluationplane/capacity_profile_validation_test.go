package evaluationplane

import (
	"context"
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

func TestValidateCapacityProfileArtifactAcceptsStrictProfile(t *testing.T) {
	runDir := t.TempDir()
	writeCapacityRecords(t, runDir)
	if err := os.WriteFile(
		filepath.Join(runDir, capacityProfileArtifactName),
		capacityProfileJSON(capacityLevelJSON(1)),
		0o600,
	); err != nil {
		t.Fatalf("write capacity profile: %v", err)
	}
	if err := validateCapacityProfileArtifact(runDir, capacityManifest(), capacityReport(), capacityRecordsAttestation()); err != nil {
		t.Fatalf("validateCapacityProfileArtifact: %v", err)
	}
}

func TestValidateCapacityProfileArtifactRejectsMalformedEvidence(t *testing.T) {
	validLevel := capacityLevelJSON(1)
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "malformed json", raw: []byte("{not-json\n")},
		{name: "null levels", raw: []byte(`{"schema_version":"evaluation.v1","kind":"bounded-concurrency-sweep","levels":null,"slo":null}`)},
		{name: "untyped slo object", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"slo":null`, `"slo":{"api_key":"public"}`, 1))},
		{name: "NaN", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"throughput_rps":1.5`, `"throughput_rps":NaN`, 1))},
		{name: "duplicate concurrency", raw: capacityProfileJSON(validLevel + "," + capacityLevelJSON(1))},
		{name: "missing required field", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"requests":2,`, "", 1))},
		{name: "negative count", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"errors":0`, `"errors":-1`, 1))},
		{name: "inconsistent outcome counts", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"successes":2`, `"successes":1`, 1))},
		{name: "non finite exponent", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"elapsed_seconds":2.0`, `"elapsed_seconds":1e1000`, 1))},
		{name: "unknown field", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"runtime_cost_usd":0.01`, `"runtime_cost_usd":0.01,"forged":true`, 1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runDir := t.TempDir()
			writeCapacityRecords(t, runDir)
			if err := os.WriteFile(filepath.Join(runDir, capacityProfileArtifactName), test.raw, 0o600); err != nil {
				t.Fatalf("write capacity profile: %v", err)
			}
			if err := validateCapacityProfileArtifact(runDir, capacityManifest(), capacityReport(), capacityRecordsAttestation()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("validateCapacityProfileArtifact error=%v, want ErrInvalid", err)
			}
		})
	}
}

func TestValidateCapacityProfileArtifactRejectsSelfConsistentRecordForgery(t *testing.T) {
	runDir := t.TempDir()
	writeCapacityRecords(t, runDir)
	forged := capacityProfileJSON(strings.NewReplacer(
		`"requests":2`, `"requests":3`,
		`"successes":2`, `"successes":3`,
	).Replace(capacityLevelJSON(1)))
	if err := os.WriteFile(filepath.Join(runDir, capacityProfileArtifactName), forged, 0o600); err != nil {
		t.Fatalf("write forged capacity profile: %v", err)
	}
	err := validateCapacityProfileArtifact(
		runDir,
		capacityManifest(),
		capacityReport(),
		capacityRecordsAttestation(),
	)
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "does not match validated records") {
		t.Fatalf("self-consistent forged profile error=%v, want record mismatch ErrInvalid", err)
	}
}

func TestRealWorkerSealRejectsForgedCapacityProfileWithRecomputedReceipts(t *testing.T) {
	python := os.Getenv("VLLM_SR_EVALUATION_TEST_PYTHON")
	if python == "" {
		t.Skip("set VLLM_SR_EVALUATION_TEST_PYTHON to run the real Python worker")
	}
	pythonRoot, err := filepath.Abs("../../../src/vllm-sr")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PYTHONPATH", pythonRoot)
	t.Setenv("TMPDIR", "/tmp")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/models":
			_, _ = writer.Write([]byte(`{"data":[{"id":"entrypoint-a","routing":{"resolution":"virtual","selectable":true,"default_route":true}}]}`))
		case "/v1/chat/completions":
			writer.Header().Set("x-vsr-selected-model", "provider-fast")
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
	if writeErr := os.WriteFile(configPath, []byte("version: v0.3\nrouting:\n  modelCards: []\n"), 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	service, err := NewService(Options{
		DataDir: root, PythonPath: python, ConfigPath: configPath,
		RouterAPIURL: server.URL, EnvoyURL: server.URL,
		CodeRevision: testSourceRevision, MaxConcurrent: 1, Process: &controlledProcess{},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = service.Close() })
	run, err := service.CreateRun(context.Background(), CreateRunRequest{
		Name: "capacity receipt forgery", SuiteIDs: []string{"live-capacity"},
		TrackIDs: []TrackID{"capacity"}, Mode: ModeLive, TargetID: "runtime",
		ChangeProfile: "runtime_capacity", SampleLimit: 4, Concurrency: 2, Seed: 17,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	startedAt := time.Now().UTC()
	run.Status = StatusRunning
	run.StartedAt = &startedAt
	if err := service.store.UpdateRun(run); err != nil {
		t.Fatalf("stage running run: %v", err)
	}
	spec := ProcessSpec{
		ManifestPath: filepath.Join(root, "runs", run.ID, manifestFileName),
		StorePath:    root,
	}
	if err := NewCommandProcess(python).Run(context.Background(), spec, func(WorkerEvent) error { return nil }); err != nil {
		t.Fatalf("real capacity worker: %v", err)
	}
	if err := forgeCapacityProfileWithRecomputedReceipts(filepath.Join(root, "runs", run.ID)); err != nil {
		t.Fatalf("forge self-consistent capacity bundle: %v", err)
	}
	if _, err := service.validatePrivateReceipt(run.ID); err != nil {
		t.Fatalf("recomputed private receipt is not self-consistent: %v", err)
	}
	var forgedReport Report
	if err := readJSON(filepath.Join(root, "runs", run.ID, reportFileName), &forgedReport); err != nil {
		t.Fatal(err)
	}
	publicReceipt, present := findArtifactByName(forgedReport, publicChecksumArtifactName)
	if !present {
		t.Fatal("forged report lost its public receipt")
	}
	if err := service.verifyPublicChecksum(run.ID, forgedReport, publicReceipt); err != nil {
		t.Fatalf("recomputed public receipt is not self-consistent: %v", err)
	}
	sealErr := service.validateAndAnchorReport(run.ID)
	if !errors.Is(sealErr, ErrInvalid) || !strings.Contains(sealErr.Error(), "capacity profile does not match validated records") {
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
	if err := writeJSONAtomic(filepath.Join(runDir, reportFileName), report); err != nil {
		return err
	}
	return writeTestPrivateReceiptWithoutTesting(runDir)
}

func capacityManifest() RunManifest {
	return RunManifest{Mode: ModeLive, TrackIDs: []TrackID{"capacity"}}
}

func capacityReport() Report {
	return Report{Artifacts: []Artifact{{
		Name: capacityProfileArtifactName, URI: capacityProfileArtifactName, MediaType: "application/json",
	}}}
}

func capacityProfileJSON(levels string) []byte {
	return []byte(fmt.Sprintf(
		`{"schema_version":"%s","kind":"bounded-concurrency-sweep","levels":[%s],"slo":null}`,
		SchemaVersion,
		levels,
	))
}

func capacityLevelJSON(concurrency int) string {
	return fmt.Sprintf(`{
		"concurrency":%d,
		"requests":2,
		"successes":2,
		"errors":0,
		"elapsed_seconds":2.0,
		"throughput_rps":1.5,
		"latency_p50_ms":20.0,
		"latency_p95_ms":29.0,
		"latency_p99_ms":29.8,
		"input_tokens":100,
		"output_tokens":20,
		"runtime_cost_usd":0.01
	}`, concurrency)
}

func writeCapacityRecords(t *testing.T, runDir string) {
	t.Helper()
	rows := `{"schema_version":"evaluation.v1","id":"capacity-case-1-a","track_id":"capacity","case_id":"case-1","attempt_id":"capacity-1","status":"succeeded","success":true,"latency_ms":10,"input_tokens":40,"output_tokens":10,"runtime_cost":0.005,"concurrency":1,"throughput_rps":1.5,"load_elapsed_seconds":2}` + "\n" +
		`{"schema_version":"evaluation.v1","id":"capacity-case-2-a","track_id":"capacity","case_id":"case-2","attempt_id":"capacity-2","status":"succeeded","success":true,"latency_ms":30,"input_tokens":60,"output_tokens":10,"runtime_cost":0.005,"concurrency":1,"throughput_rps":1.5,"load_elapsed_seconds":2}` + "\n"
	if err := os.WriteFile(filepath.Join(runDir, "records.jsonl"), []byte(rows), 0o600); err != nil {
		t.Fatalf("write capacity records: %v", err)
	}
}

func capacityRecordsAttestation() recordAttestation {
	return recordAttestation{
		validated: true,
		Total:     2,
		Succeeded: 2,
		ByTrack: map[TrackID]recordStatusCounts{
			"capacity": {Succeeded: 2},
		},
	}
}
