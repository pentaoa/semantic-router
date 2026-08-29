package evaluationplane

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReportReadRejectsConfiguredSecretAfterSealing(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	service.envoyAPIKeyEnv = "VLLM_SR_TEST_ENVOY_SECRET"
	t.Setenv(service.envoyAPIKeyEnv, `credential"fragment`)
	run, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	report := reportForRun(run, nil)
	report.Recommendations = []string{`diagnostic credential"fragment must not be public`}
	if err := service.store.WriteReport(run.ID, report); err != nil {
		t.Fatalf("WriteReport: %v", err)
	}
	sealTestReport(t, service, run.ID)
	if _, err := service.ReportJSON(run.ID); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "configured credential") {
		t.Fatalf("ReportJSON secret error=%v, want ErrInvalid without disclosure", err)
	}
}

func TestArtifactDownloadRejectsConfiguredSecretWithRecomputedReceipts(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	service.envoyAPIKeyEnv = "VLLM_SR_TEST_ENVOY_SECRET"
	const secret = "eval-secret-token-123"
	t.Setenv(service.envoyAPIKeyEnv, secret)
	run, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	runDir := filepath.Join(root, "runs", run.ID)
	cases := []byte(`{"schema_version":"evaluation.v1","id":"case-1","messages":[{"role":"user","content":"test"}],"modality":"text","tags":[]}` + "\n")
	// Encode one character non-canonically so the configured secret is absent
	// from the raw bytes but present in the decoded JSON string.
	trace := []byte(`{"schema_version":"evaluation.v1","case_id":"case-1","recipe":"eval-\u0073ecret-token-123","plugins":[],"recommended_models":[],"traces":[],"signals":[]}` + "\n")
	if strings.Contains(string(trace), secret) {
		t.Fatal("test fixture must exercise a non-canonical JSON encoding")
	}
	if err := os.WriteFile(filepath.Join(runDir, "cases.jsonl"), cases, 0o600); err != nil {
		t.Fatalf("write cases: %v", err)
	}
	if err := os.WriteFile(filepath.Join(runDir, "routing-traces.jsonl"), trace, 0o600); err != nil {
		t.Fatalf("write routing trace: %v", err)
	}
	// This helper recomputes both public/private receipts and the report anchor,
	// proving digest self-consistency cannot make a disclosed credential public.
	writeReportWithPublicReceipt(t, service, run, []Artifact{
		artifactForBytes("traces", "routing-traces.jsonl", "application/x-ndjson", trace),
	})
	if _, err := service.OpenArtifact(run.ID, "traces"); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "configured credential") {
		t.Fatalf("OpenArtifact secret error=%v, want ErrInvalid without disclosure", err)
	}
}
