package evaluationplane

import (
	"bytes"
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListRunsIsolatesCorruptBundleAndRetainsWarning(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	first, createFirstErr := service.CreateRun(context.Background(), validCreateRequest())
	if createFirstErr != nil {
		t.Fatalf("create first run: %v", createFirstErr)
	}
	request := validCreateRequest()
	request.Name = "second run"
	second, createSecondErr := service.CreateRun(context.Background(), request)
	if createSecondErr != nil {
		t.Fatalf("create second run: %v", createSecondErr)
	}

	statusPath := filepath.Join(root, "runs", second.ID, runFileName)
	if writeErr := os.WriteFile(statusPath, []byte("{not-json\n"), 0o600); writeErr != nil {
		t.Fatalf("corrupt second run status: %v", writeErr)
	}
	var logged bytes.Buffer
	previousLogOutput := log.Writer()
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(previousLogOutput) })

	ledger, listErr := service.ListRunLedger()
	if listErr != nil {
		t.Fatalf("ListRunLedger with one corrupt bundle: %v", listErr)
	}
	runs := ledger.Runs
	if len(runs) != 1 || runs[0].ID != first.ID {
		t.Fatalf("ListRunLedger returned runs=%+v, want only intact run %s", runs, first.ID)
	}
	if ledger.LedgerComplete || ledger.SchemaVersion != SchemaVersion || len(ledger.Warnings) != 1 {
		t.Fatalf("corrupt ledger integrity metadata=%+v", ledger)
	}
	publicWarning := ledger.Warnings[0]
	if publicWarning.Code != corruptRunBundleWarningCode || publicWarning.RunID != second.ID ||
		publicWarning.EvidenceFile != runFileName || publicWarning.Message != quarantinedRunMessage ||
		strings.Contains(publicWarning.Message, root) || strings.Contains(publicWarning.Message, "decode evaluation bundle") {
		t.Fatalf("public quarantine warning is missing or leaks diagnostics: %+v", publicWarning)
	}
	if _, getErr := service.GetRun(second.ID); getErr == nil {
		t.Fatal("GetRun silently accepted the corrupt bundle")
	}
	warnings := service.store.activeRunListWarnings()
	if len(warnings) != 1 || warnings[0].Code != corruptRunBundleWarningCode || warnings[0].RunID != second.ID ||
		!strings.Contains(warnings[0].Message, "decode evaluation bundle") {
		t.Fatalf("active run-list warnings=%+v, want structured corruption warning", warnings)
	}
	if _, repeatErr := service.ListRuns(); repeatErr != nil {
		t.Fatalf("repeat ListRuns with unchanged corruption: %v", repeatErr)
	}
	if count := strings.Count(logged.String(), "warning_code="+corruptRunBundleWarningCode); count != 1 {
		t.Fatalf("corruption warning logged %d times, want one transition log: %q", count, logged.String())
	}

	if repairErr := writeJSONAtomic(statusPath, second); repairErr != nil {
		t.Fatalf("repair second run status: %v", repairErr)
	}
	ledger, listErr = service.ListRunLedger()
	if listErr != nil || len(ledger.Runs) != 2 || !ledger.LedgerComplete || len(ledger.Warnings) != 0 {
		t.Fatalf("ListRunLedger after repair returned %+v, err=%v", ledger, listErr)
	}
	if warnings := service.store.activeRunListWarnings(); len(warnings) != 0 {
		t.Fatalf("warning did not clear after bundle repair: %+v", warnings)
	}
}

func TestRecoverInterruptedRunsContinuesPastCorruptBundle(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	running, createRunningErr := service.CreateRun(context.Background(), validCreateRequest())
	if createRunningErr != nil {
		t.Fatalf("create running candidate: %v", createRunningErr)
	}
	running.Status = StatusRunning
	if updateErr := service.store.UpdateRun(running); updateErr != nil {
		t.Fatalf("mark run running: %v", updateErr)
	}
	request := validCreateRequest()
	request.Name = "corrupt run"
	corrupt, createCorruptErr := service.CreateRun(context.Background(), request)
	if createCorruptErr != nil {
		t.Fatalf("create corrupt candidate: %v", createCorruptErr)
	}
	if writeErr := os.WriteFile(
		filepath.Join(root, "runs", corrupt.ID, runFileName),
		[]byte("not-json\n"),
		0o600,
	); writeErr != nil {
		t.Fatalf("corrupt status: %v", writeErr)
	}

	if recoverErr := service.RecoverInterruptedRuns(); recoverErr != nil {
		t.Fatalf("RecoverInterruptedRuns: %v", recoverErr)
	}
	recovered, getErr := service.GetRun(running.ID)
	if getErr != nil || recovered.Status != StatusFailed || !strings.Contains(recovered.Error, "restarted") {
		t.Fatalf("valid interrupted run was not recovered: run=%+v err=%v", recovered, getErr)
	}
	warnings := service.store.activeRunListWarnings()
	if len(warnings) != 1 || warnings[0].RunID != corrupt.ID {
		t.Fatalf("corrupt bundle warning was not retained during recovery: %+v", warnings)
	}
}

func TestListRunsRejectsStatusIdentityAndStateCorruption(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	run, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	statusPath := filepath.Join(root, "runs", run.ID, runFileName)

	tests := []struct {
		name   string
		mutate func(*Run)
		match  string
	}{
		{name: "schema", mutate: func(candidate *Run) { candidate.SchemaVersion = "evaluation.v2" }, match: "schema_version"},
		{name: "identity", mutate: func(candidate *Run) { candidate.ID = "different-run" }, match: "identity"},
		{name: "state", mutate: func(candidate *Run) { candidate.Status = "unknown" }, match: "state"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := run
			test.mutate(&candidate)
			if err := writeJSONAtomic(statusPath, candidate); err != nil {
				t.Fatalf("write corrupt status: %v", err)
			}
			if _, err := service.GetRun(run.ID); err == nil {
				t.Fatal("GetRun silently accepted corrupt status metadata")
			}
			runs, err := service.ListRuns()
			if err != nil || len(runs) != 0 {
				t.Fatalf("ListRuns returned runs=%+v err=%v, want isolated bundle", runs, err)
			}
			warnings := service.store.activeRunListWarnings()
			if len(warnings) != 1 || warnings[0].RunID != run.ID || !strings.Contains(warnings[0].Message, test.match) {
				t.Fatalf("warning=%+v, want %q corruption", warnings, test.match)
			}
		})
	}
}
