package evaluationplane

import (
	"context"
	"encoding/json"
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
	if err := service.store.WriteReport(run.ID, workerReportFromReport(report)); err != nil {
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
	cases := []byte(`{"schema_version":"evaluation.v1","id":"case-1","track_ids":["routing"],"messages":[{"role":"user","content":"test"}],"modality":"text","tags":[]}` + "\n")
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

func TestPublicEvidenceRejectsEveryServerOwnedEvaluationCredential(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	service.routerAPIKeyEnv = "VLLM_SR_TEST_ROUTER_SECRET"
	service.envoyAPIKeyEnv = "VLLM_SR_TEST_ENVOY_SECRET"
	service.agentTaskLedger = secretValidationEndpoint("VLLM_SR_TEST_AGENT_TASK_SECRET")
	service.faultRecoveryLedger = secretValidationEndpoint("VLLM_SR_TEST_RECOVERY_SECRET")
	service.hardPolicyLedger = secretValidationEndpoint("VLLM_SR_TEST_POLICY_SECRET")
	service.productionExperimentLedger = secretValidationEndpoint("VLLM_SR_TEST_PRODUCTION_SECRET")

	credentials := map[string]string{
		service.routerAPIKeyEnv:                       `router"credential`,
		service.envoyAPIKeyEnv:                        `envoy"credential`,
		service.agentTaskLedger.APIKey.Env:            `agent"credential`,
		service.faultRecoveryLedger.APIKey.Env:        `recovery"credential`,
		service.hardPolicyLedger.APIKey.Env:           `policy"credential`,
		service.productionExperimentLedger.APIKey.Env: `production"credential`,
	}
	for envName, credential := range credentials {
		t.Setenv(envName, credential)
		payload, err := json.Marshal(map[string]string{"value": credential})
		if err != nil {
			t.Fatalf("marshal %s credential: %v", envName, err)
		}
		if err := service.rejectConfiguredSecretBytes(payload); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s credential was not rejected: %v", envName, err)
		}
		decodedOnly := []byte(strings.ReplaceAll(string(payload), `\"`, `\u0022`))
		if err := service.rejectConfiguredSecretBytes(decodedOnly); !errors.Is(err, ErrInvalid) {
			t.Fatalf("decoded %s credential was not rejected: %v", envName, err)
		}
	}
}

func secretValidationEndpoint(envName string) *ServiceEndpoint {
	return &ServiceEndpoint{
		SchemaVersion:  SchemaVersion,
		URL:            "https://ledger.invalid",
		APIKey:         &SecretRef{SchemaVersion: SchemaVersion, Env: envName},
		TimeoutSeconds: 30,
	}
}
