package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const validControlledPairRequestJSON = `{
  "client_request_id":"df2c738b-b4d2-4378-b9fb-c0dfce81e448",
  "baseline_source_run_id":"e698c676-1119-4dcb-86fc-3d53c1ecae50",
  "candidate_source_run_id":"d3e802cf-d413-4104-9be8-1e8fc451eb09",
  "baseline_run_id":"05f97c0e-bbc2-4bf6-94bc-2c65c4819d7f",
  "candidate_run_id":"09b53ed3-20de-4480-a861-604156229bbb"
}`

func TestControlledPairWireRejectsClientTargetAndVersionClaims(t *testing.T) {
	service := newEvaluationHandlerService(t, "")
	handler := NewInternalEvaluationPlaneHandler(service, false)

	for _, field := range []string{
		`"endpoint":"https://attacker.invalid"`,
		`"baseline_endpoint":"https://baseline.invalid"`,
		`"candidate_label":"pretend-v2"`,
		`"credential_env":"ATTACKER_KEY"`,
	} {
		body := strings.Replace(validControlledPairRequestJSON, "\n}", ",\n  "+field+"\n}", 1)
		response := httptest.NewRecorder()
		handler.ControlledPairs(
			response,
			httptest.NewRequest(http.MethodPost, evaluationAPIBase+"/controlled-pairs", strings.NewReader(body)),
		)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("client target field %s status=%d body=%s", field, response.Code, response.Body.String())
		}
	}

	readonly := NewInternalEvaluationPlaneHandler(service, true)
	denied := httptest.NewRecorder()
	readonly.ControlledPairs(
		denied,
		httptest.NewRequest(http.MethodPost, evaluationAPIBase+"/controlled-pairs", strings.NewReader(validControlledPairRequestJSON)),
	)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("readonly controlled pair status=%d body=%s", denied.Code, denied.Body.String())
	}
}
