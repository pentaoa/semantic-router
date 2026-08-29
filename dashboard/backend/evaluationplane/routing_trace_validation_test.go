package evaluationplane

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateRoutingTraceArtifactAcceptsStrictBoundedCaseJoinedRows(t *testing.T) {
	runDir := t.TempDir()
	writeRoutingTraceRows(t, runDir, routingTraceRow("case-1"))
	if err := validateRoutingTraceArtifact(runDir, map[string]struct{}{"case-1": {}}); err != nil {
		t.Fatalf("validateRoutingTraceArtifact: %v", err)
	}
}

func TestValidateRoutingTraceArtifactEnforcesGlobalNodeAndByteBudgets(t *testing.T) {
	t.Run("maximum global node budget", func(t *testing.T) {
		runDir := t.TempDir()
		row := routingTraceRowWithNodes("case-1", maxRoutingTraceNodes)
		writeRoutingTraceRows(t, runDir, row)
		if err := validateRoutingTraceArtifact(runDir, map[string]struct{}{"case-1": {}}); err != nil {
			t.Fatalf("maximum bounded worker trace rejected: %v", err)
		}
	})

	t.Run("truncated flag cannot bypass global node budget", func(t *testing.T) {
		runDir := t.TempDir()
		row := routingTraceRowWithNodes("case-1", maxRoutingTraceNodes+1)
		row["truncated"] = true
		writeRoutingTraceRows(t, runDir, row)
		err := validateRoutingTraceArtifact(runDir, map[string]struct{}{"case-1": {}})
		if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "global node budget") {
			t.Fatalf("oversized trace error=%v, want global-node ErrInvalid", err)
		}
	})

	t.Run("serialized line byte budget", func(t *testing.T) {
		runDir := t.TempDir()
		row := routingTraceRow("case-1")
		row["recipe"] = strings.Repeat("a", maxRoutingTraceLineBytes)
		writeRoutingTraceRows(t, runDir, row)
		if err := validateRoutingTraceArtifact(runDir, map[string]struct{}{"case-1": {}}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("oversized serialized line error=%v, want ErrInvalid", err)
		}
	})
}

func TestRealWorkerRoutingTracePassesServerBudgets(t *testing.T) {
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
		case "/api/v1/eval":
			_, _ = writer.Write([]byte(`{"recipe":"fixture-recipe","decision_result":{"decision_name":"route","algorithm":"confidence","plugins":["audit"]},"recommended_models":["provider-fast"],"selected_model":"provider-fast","selection_status":"selected","selection_method":"confidence","eval_trace":[{"decision_name":"route","matched":true,"confidence":0.9,"root_trace":{"node_type":"leaf","matched":true,"confidence":0.9,"children":[]}}],"signal_confidences":{"domain:reasoning":0.9}}`))
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
		Name: "real routing trace", SuiteIDs: []string{"live-routing-core"},
		TrackIDs: []TrackID{"routing"}, Mode: ModeLive, TargetID: "runtime",
		ChangeProfile: "recipe", SampleLimit: 4, Concurrency: 1, Seed: 17,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	startedAt := time.Now().UTC()
	run.Status = StatusRunning
	run.StartedAt = &startedAt
	if updateErr := service.store.UpdateRun(run); updateErr != nil {
		t.Fatalf("stage running run: %v", updateErr)
	}
	spec := ProcessSpec{
		ManifestPath: filepath.Join(root, "runs", run.ID, manifestFileName),
		StorePath:    root,
	}
	if processErr := NewCommandProcess(python).Run(context.Background(), spec, func(WorkerEvent) error { return nil }); processErr != nil {
		t.Fatalf("real routing worker: %v", processErr)
	}
	if validationErr := service.validateAndAnchorReport(run.ID); validationErr != nil {
		t.Fatalf("Go rejected a bounded real-worker routing trace: %v", validationErr)
	}
	traceBytes, err := os.ReadFile(filepath.Join(root, "runs", run.ID, "routing-traces.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(traceBytes), `"truncated":false`) {
		t.Fatalf("real worker trace omitted its explicit truncation status: %s", traceBytes)
	}
}

func TestValidateRoutingTraceArtifactRejectsUntrustedOrUnboundedRows(t *testing.T) {
	tests := []struct {
		name  string
		rows  []map[string]any
		cases map[string]struct{}
		match string
	}{
		{
			name: "unknown prompt field",
			rows: []map[string]any{func() map[string]any {
				row := routingTraceRow("case-1")
				row["prompt"] = "must remain private"
				return row
			}()},
			cases: map[string]struct{}{"case-1": {}}, match: "unknown field",
		},
		{
			name:  "case is not joined",
			rows:  []map[string]any{routingTraceRow("other-case")},
			cases: map[string]struct{}{"case-1": {}}, match: "absent from the validated case set",
		},
		{
			name:  "duplicate case",
			rows:  []map[string]any{routingTraceRow("case-1"), routingTraceRow("case-1")},
			cases: map[string]struct{}{"case-1": {}, "case-2": {}}, match: "duplicate case_id",
		},
		{
			name: "null collection",
			rows: []map[string]any{func() map[string]any {
				row := routingTraceRow("case-1")
				row["signals"] = nil
				return row
			}()},
			cases: map[string]struct{}{"case-1": {}}, match: "collections cannot be null",
		},
		{
			name: "token collection exceeds bound",
			rows: []map[string]any{func() map[string]any {
				row := routingTraceRow("case-1")
				row["plugins"] = make([]string, maxRoutingTraceTokens+1)
				for index := range row["plugins"].([]string) {
					row["plugins"].([]string)[index] = "plugin"
				}
				return row
			}()},
			cases: map[string]struct{}{"case-1": {}}, match: "cardinality limit",
		},
		{
			name:  "trace tree exceeds depth",
			rows:  []map[string]any{routingTraceRowWithDepth("case-1", maxRoutingTraceDepth+1)},
			cases: map[string]struct{}{"case-1": {}}, match: "depth limit",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runDir := t.TempDir()
			writeRoutingTraceRows(t, runDir, test.rows...)
			if err := validateRoutingTraceArtifact(runDir, test.cases); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("validateRoutingTraceArtifact error=%v, want ErrInvalid containing %q", err, test.match)
			}
		})
	}
}

func routingTraceRow(caseID string) map[string]any {
	return map[string]any{
		"schema_version":     SchemaVersion,
		"case_id":            caseID,
		"truncated":          false,
		"recipe":             "default recipe",
		"plugins":            []string{},
		"recommended_models": []string{},
		"traces":             []any{},
		"signals":            []any{},
	}
}

func routingTraceRowWithNodes(caseID string, count int) map[string]any {
	row := routingTraceRow(caseID)
	root := map[string]any{
		"node_type": "signal", "matched": true, "confidence_scored": false, "children": []any{},
	}
	queue := []map[string]any{root}
	remaining := count - 1
	for len(queue) > 0 && remaining > 0 {
		parent := queue[0]
		queue = queue[1:]
		childCount := maxRoutingTraceChildren
		if remaining < childCount {
			childCount = remaining
		}
		children := make([]any, 0, childCount)
		for range childCount {
			child := map[string]any{
				"node_type": "signal", "matched": true, "confidence_scored": false, "children": []any{},
			}
			children = append(children, child)
			queue = append(queue, child)
		}
		parent["children"] = children
		remaining -= childCount
	}
	row["traces"] = []any{map[string]any{
		"decision_name": "route", "matched": true, "root_trace": root,
	}}
	return row
}

func routingTraceRowWithDepth(caseID string, depth int) map[string]any {
	row := routingTraceRow(caseID)
	var node map[string]any
	for index := 0; index < depth; index++ {
		children := []any{}
		current := map[string]any{
			"node_type": "signal", "matched": true, "confidence_scored": false, "children": children,
		}
		if node != nil {
			current["children"] = []any{node}
		}
		node = current
	}
	row["traces"] = []any{map[string]any{
		"decision_name": "route", "matched": true, "root_trace": node,
	}}
	return row
}

func writeRoutingTraceRows(t *testing.T, runDir string, rows ...map[string]any) {
	t.Helper()
	var encoded strings.Builder
	for _, row := range rows {
		data, err := json.Marshal(row)
		if err != nil {
			t.Fatalf("marshal routing trace: %v", err)
		}
		encoded.Write(data)
		encoded.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(runDir, "routing-traces.jsonl"), []byte(encoded.String()), 0o600); err != nil {
		t.Fatalf("write routing traces: %v", err)
	}
}
