package evaluationplane

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func createBaselineAndCandidateForReferenceTest(t *testing.T) (*Service, string, Run, Run) {
	t.Helper()
	service, root := newTestService(t, &controlledProcess{}, 1)
	baseline, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("create baseline: %v", err)
	}
	baseline = completeTestRun(t, service, baseline)
	service.codeRevision = strings.Repeat("b", 40)
	request := validCreateRequest()
	request.Name = "candidate"
	request.BaselineRunID = baseline.ID
	candidate, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("create candidate: %v", err)
	}
	return service, root, baseline, candidate
}

func TestServiceDeletePreservesRunBaselineReferences(t *testing.T) {
	service, _, baseline, candidate := createBaselineAndCandidateForReferenceTest(t)
	if err := service.DeleteRun(baseline.ID); !errors.Is(err, ErrConflict) ||
		!strings.Contains(err.Error(), candidate.ID) {
		t.Fatalf("delete referenced baseline error=%v, want candidate-bound conflict", err)
	}
	if err := service.DeleteRun(candidate.ID); err != nil {
		t.Fatalf("delete candidate: %v", err)
	}
	if err := service.DeleteRun(baseline.ID); err != nil {
		t.Fatalf("delete released baseline: %v", err)
	}
}

func TestStoreDeleteFailsClosedWhenRunReferenceLedgerIsCorrupt(t *testing.T) {
	service, root, baseline, candidate := createBaselineAndCandidateForReferenceTest(t)
	if err := os.WriteFile(
		filepath.Join(root, "runs", candidate.ID, runFileName),
		[]byte("not-json\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := service.store.DeleteRun(baseline.ID); !errors.Is(err, ErrConflict) ||
		!strings.Contains(err.Error(), "cannot be verified") {
		t.Fatalf("delete with corrupt reference ledger error=%v", err)
	}
}

func TestStoreStartupRejectsDanglingBaselineReference(t *testing.T) {
	_, root, baseline, _ := createBaselineAndCandidateForReferenceTest(t)
	if err := os.RemoveAll(filepath.Join(root, "runs", baseline.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(root); !errors.Is(err, ErrInvalid) ||
		!strings.Contains(err.Error(), "baseline reference") {
		t.Fatalf("restart with dangling baseline error=%v, want ErrInvalid", err)
	}
}
