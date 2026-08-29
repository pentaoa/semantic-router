package evaluationplane

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

const indexedClientRequestID = "4d0b4f2c-1fc5-40b0-b04e-876ad9d4d8e2"

func TestCreateRunClientRequestIndexSurvivesRestartAndRejectsChangedPayload(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	created, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close original service: %v", closeErr)
	}

	restarted, err := NewService(Options{
		DataDir: root, PythonPath: "python3", ConfigPath: filepath.Join(root, "config.yaml"),
		RouterAPIURL: "http://router.invalid", EnvoyURL: "http://envoy.invalid",
		CodeRevision: testSourceRevision, MaxConcurrent: 1, Process: &controlledProcess{},
	})
	if err != nil {
		t.Fatalf("restart NewService: %v", err)
	}
	t.Cleanup(func() { _ = restarted.Close() })

	replayed, err := restarted.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("replayed CreateRun after restart: %v", err)
	}
	if replayed.ID != created.ID {
		t.Fatalf("replayed CreateRun id=%s, want durable indexed id=%s", replayed.ID, created.ID)
	}
	changed := request
	changed.Description = "different payload"
	if _, changedErr := restarted.CreateRun(context.Background(), changed); !errors.Is(changedErr, ErrConflict) {
		t.Fatalf("changed indexed replay error=%v, want ErrConflict", changedErr)
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("indexed retries left %d run bundles, err=%v, want 1", len(entries), err)
	}
}

func TestCreateRunReconcilesDeletedClientRequestIndexAfterCompletedMigration(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	created, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	indexPath, pathErr := service.store.clientRequestIndexPath(indexedClientRequestID)
	if pathErr != nil {
		t.Fatalf("clientRequestIndexPath: %v", pathErr)
	}
	if _, markerErr := os.Stat(service.store.clientRequestMigrationMarkerPath()); markerErr != nil {
		t.Fatalf("completed migration marker is unavailable: %v", markerErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close original service: %v", closeErr)
	}
	if removeErr := os.Remove(indexPath); removeErr != nil {
		t.Fatalf("remove per-key index: %v", removeErr)
	}

	restarted := reopenTestService(t, root)
	replayed, replayErr := restarted.CreateRun(context.Background(), request)
	if replayErr != nil || replayed.ID != created.ID {
		t.Fatalf("reconciled retry returned run=%+v err=%v, want %s", replayed, replayErr, created.ID)
	}
	changed := request
	changed.Description = "conflicting retry after index reconciliation"
	if _, conflictErr := restarted.CreateRun(context.Background(), changed); !errors.Is(conflictErr, ErrConflict) {
		t.Fatalf("conflicting reconciled retry error=%v, want ErrConflict", conflictErr)
	}
	entries, readErr := os.ReadDir(filepath.Join(root, "runs"))
	if readErr != nil || len(entries) != 1 || entries[0].Name() != created.ID {
		t.Fatalf("reconciled retries changed run bundles=%v err=%v", entries, readErr)
	}
}

func TestCreateRunReconcilesDeletedClientRequestIndexAcrossStores(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	created, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	indexPath, pathErr := service.store.clientRequestIndexPath(indexedClientRequestID)
	if pathErr != nil {
		t.Fatalf("clientRequestIndexPath: %v", pathErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close original service: %v", closeErr)
	}
	if removeErr := os.Remove(indexPath); removeErr != nil {
		t.Fatalf("remove per-key index: %v", removeErr)
	}

	first, firstErr := newServiceForExistingRoot(root)
	if firstErr != nil {
		t.Fatalf("open first service: %v", firstErr)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, secondErr := newServiceForExistingRoot(root)
	if secondErr != nil {
		t.Fatalf("open second service: %v", secondErr)
	}
	t.Cleanup(func() { _ = second.Close() })

	type result struct {
		run Run
		err error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for _, candidate := range []*Service{first, second} {
		workers.Add(1)
		go func(candidate *Service) {
			defer workers.Done()
			<-start
			run, createErr := candidate.CreateRun(context.Background(), request)
			results <- result{run: run, err: createErr}
		}(candidate)
	}
	close(start)
	workers.Wait()
	close(results)
	for retry := range results {
		if retry.err != nil || retry.run.ID != created.ID {
			t.Fatalf("concurrent reconciled retry returned run=%+v err=%v, want %s", retry.run, retry.err, created.ID)
		}
	}
	entries, readErr := os.ReadDir(filepath.Join(root, "runs"))
	if readErr != nil || len(entries) != 1 || entries[0].Name() != created.ID {
		t.Fatalf("concurrent reconciliation changed run bundles=%v err=%v", entries, readErr)
	}
}

func TestCreateRunDeletedIndexFailsClosedForUnclassifiableBundle(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	created, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	indexPath, pathErr := service.store.clientRequestIndexPath(indexedClientRequestID)
	if pathErr != nil {
		t.Fatalf("clientRequestIndexPath: %v", pathErr)
	}
	if removeErr := os.Remove(indexPath); removeErr != nil {
		t.Fatalf("remove per-key index: %v", removeErr)
	}
	if writeErr := os.WriteFile(
		filepath.Join(root, "runs", created.ID, runFileName),
		[]byte("{not-json\n"),
		0o600,
	); writeErr != nil {
		t.Fatalf("corrupt run status: %v", writeErr)
	}
	if _, replayErr := service.CreateRun(context.Background(), request); !errors.Is(replayErr, ErrConflict) {
		t.Fatalf("retry with deleted index and corrupt bundle error=%v, want ErrConflict", replayErr)
	}
	entries, readErr := os.ReadDir(filepath.Join(root, "runs"))
	if readErr != nil || len(entries) != 1 || entries[0].Name() != created.ID {
		t.Fatalf("failed reconciliation changed run bundles=%v err=%v", entries, readErr)
	}
}

func TestHydrateLegacyClientRequestIndexSurvivesUpgrade(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	legacyRequest := validCreateRequest()
	legacyRun, err := service.CreateRun(context.Background(), legacyRequest)
	if err != nil {
		t.Fatalf("create legacy run: %v", err)
	}
	legacyRun.ClientRequestID = indexedClientRequestID
	if updateErr := service.store.UpdateRun(legacyRun); updateErr != nil {
		t.Fatalf("add legacy client_request_id: %v", updateErr)
	}
	if removeErr := os.Remove(service.store.clientRequestMigrationMarkerPath()); removeErr != nil {
		t.Fatalf("remove migration marker to simulate upgrade: %v", removeErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close legacy service: %v", closeErr)
	}

	restarted := reopenTestService(t, root)
	retry := legacyRequest
	retry.ClientRequestID = indexedClientRequestID
	replayed, replayErr := restarted.CreateRun(context.Background(), retry)
	if replayErr != nil {
		t.Fatalf("retry hydrated legacy request: %v", replayErr)
	}
	if replayed.ID != legacyRun.ID {
		t.Fatalf("hydrated retry id=%s, want legacy id=%s", replayed.ID, legacyRun.ID)
	}
	indexed, found, indexErr := restarted.store.ClientRequestIndex(indexedClientRequestID)
	if indexErr != nil || !found || indexed.RunID != legacyRun.ID {
		t.Fatalf("hydrated index=%+v found=%t err=%v", indexed, found, indexErr)
	}
}

func TestHydrateLegacyClientRequestIndexRejectsAmbiguousKey(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	first, firstErr := service.CreateRun(context.Background(), validCreateRequest())
	if firstErr != nil {
		t.Fatalf("create first legacy run: %v", firstErr)
	}
	secondRequest := validCreateRequest()
	secondRequest.Name = "second legacy run"
	second, secondErr := service.CreateRun(context.Background(), secondRequest)
	if secondErr != nil {
		t.Fatalf("create second legacy run: %v", secondErr)
	}
	first.ClientRequestID = indexedClientRequestID
	second.ClientRequestID = indexedClientRequestID
	if updateErr := service.store.UpdateRun(first); updateErr != nil {
		t.Fatalf("index first legacy run: %v", updateErr)
	}
	if updateErr := service.store.UpdateRun(second); updateErr != nil {
		t.Fatalf("index second legacy run: %v", updateErr)
	}
	if removeErr := os.Remove(service.store.clientRequestMigrationMarkerPath()); removeErr != nil {
		t.Fatalf("remove migration marker: %v", removeErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close legacy service: %v", closeErr)
	}

	restarted, restartErr := newServiceForExistingRoot(root)
	if restartErr != nil {
		t.Fatalf("ambiguous legacy hydration prevented service startup: %v", restartErr)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	keyedRequest := validCreateRequest()
	keyedRequest.ClientRequestID = indexedClientRequestID
	if _, createErr := restarted.CreateRun(context.Background(), keyedRequest); !errors.Is(createErr, ErrConflict) {
		t.Fatalf("ambiguous legacy keyed create error=%v, want ErrConflict", createErr)
	}
	if _, markerErr := os.Stat(filepath.Join(root, "index", clientRequestMigrationMarkerFileName)); !os.IsNotExist(markerErr) {
		t.Fatalf("ambiguous migration published completion marker: %v", markerErr)
	}
}

func TestHydrateLegacyClientRequestIndexRejectsCorruptBundle(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	legacyRun, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("create legacy run: %v", err)
	}
	legacyRun.ClientRequestID = indexedClientRequestID
	if updateErr := service.store.UpdateRun(legacyRun); updateErr != nil {
		t.Fatalf("add legacy client_request_id: %v", updateErr)
	}
	if removeErr := os.Remove(service.store.clientRequestMigrationMarkerPath()); removeErr != nil {
		t.Fatalf("remove migration marker: %v", removeErr)
	}
	if writeErr := os.WriteFile(
		filepath.Join(root, "runs", legacyRun.ID, runFileName),
		[]byte("{not-json\n"),
		0o600,
	); writeErr != nil {
		t.Fatalf("corrupt legacy status: %v", writeErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close legacy service: %v", closeErr)
	}

	restarted, restartErr := newServiceForExistingRoot(root)
	if restartErr != nil {
		t.Fatalf("corrupt legacy hydration prevented service startup: %v", restartErr)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	ledger, listErr := restarted.ListRunLedger()
	if listErr != nil || ledger.LedgerComplete || len(ledger.Warnings) != 1 || ledger.Warnings[0].RunID != legacyRun.ID {
		t.Fatalf("corrupt legacy ledger=%+v err=%v, want one quarantined run", ledger, listErr)
	}
	keyedRequest := validCreateRequest()
	keyedRequest.ClientRequestID = indexedClientRequestID
	if _, createErr := restarted.CreateRun(context.Background(), keyedRequest); !errors.Is(createErr, ErrConflict) {
		t.Fatalf("corrupt legacy keyed create error=%v, want ErrConflict", createErr)
	}
	if repairErr := writeJSONAtomic(
		filepath.Join(root, "runs", legacyRun.ID, runFileName),
		legacyRun,
	); repairErr != nil {
		t.Fatalf("repair legacy status: %v", repairErr)
	}
	replayed, replayErr := restarted.CreateRun(context.Background(), keyedRequest)
	if replayErr != nil || replayed.ID != legacyRun.ID {
		t.Fatalf("hydration retry after repair returned run=%+v err=%v", replayed, replayErr)
	}
}

func TestCreateRunClientRequestIndexFailsClosedForCorruptRun(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	created, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	statusPath := filepath.Join(root, "runs", created.ID, runFileName)
	if writeErr := os.WriteFile(statusPath, []byte("{not-json\n"), 0o600); writeErr != nil {
		t.Fatalf("corrupt indexed run status: %v", writeErr)
	}

	if _, replayErr := service.CreateRun(context.Background(), request); !errors.Is(replayErr, ErrConflict) {
		t.Fatalf("replay against corrupt indexed run error=%v, want ErrConflict", replayErr)
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 1 || entries[0].Name() != created.ID {
		t.Fatalf("corrupt indexed replay changed run bundles=%v err=%v", entries, err)
	}
}

func TestCreateRunClientRequestIndexFailsClosedWhenIndexIsCorrupt(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	path, err := service.store.clientRequestIndexPath(indexedClientRequestID)
	if err != nil {
		t.Fatalf("clientRequestIndexPath: %v", err)
	}
	if writeErr := os.WriteFile(path, []byte("{not-json\n"), 0o600); writeErr != nil {
		t.Fatalf("corrupt client request index: %v", writeErr)
	}
	request := validCreateRequest()
	request.ClientRequestID = indexedClientRequestID
	if _, createErr := service.CreateRun(context.Background(), request); !errors.Is(createErr, ErrConflict) {
		t.Fatalf("CreateRun with corrupt index error=%v, want ErrConflict", createErr)
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("corrupt index created run bundles=%v err=%v", entries, err)
	}
}

func TestReserveClientRequestIndexIsAtomicAcrossStores(t *testing.T) {
	root := filepath.Join(t.TempDir(), "evaluation")
	firstStore, err := NewStore(root)
	if err != nil {
		t.Fatalf("NewStore first: %v", err)
	}
	secondStore, err := NewStore(root)
	if err != nil {
		t.Fatalf("NewStore second: %v", err)
	}
	entries := []clientRequestIndexEntry{
		{
			SchemaVersion: SchemaVersion, ClientRequestID: indexedClientRequestID,
			RunID: "11111111-1111-4111-8111-111111111111", RequestDigest: digestBytes([]byte("first")),
		},
		{
			SchemaVersion: SchemaVersion, ClientRequestID: indexedClientRequestID,
			RunID: "22222222-2222-4222-8222-222222222222", RequestDigest: digestBytes([]byte("second")),
		},
	}
	type reservation struct {
		entry   clientRequestIndexEntry
		created bool
		err     error
	}
	results := make(chan reservation, 2)
	start := make(chan struct{})
	stores := []*Store{firstStore, secondStore}
	var workers sync.WaitGroup
	for index := range stores {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			entry, created, reserveErr := stores[index].ReserveClientRequestIndex(entries[index])
			results <- reservation{entry: entry, created: created, err: reserveErr}
		}(index)
	}
	close(start)
	workers.Wait()
	close(results)

	createdCount := 0
	var winner clientRequestIndexEntry
	var observed []clientRequestIndexEntry
	for result := range results {
		if result.err != nil {
			t.Fatalf("ReserveClientRequestIndex: %v", result.err)
		}
		if result.created {
			createdCount++
			winner = result.entry
		}
		observed = append(observed, result.entry)
	}
	if createdCount != 1 {
		t.Fatalf("created reservations=%d, want exactly 1", createdCount)
	}
	for _, entry := range observed {
		if entry != winner {
			t.Fatalf("independent stores observed different index winners: winner=%+v observed=%+v", winner, observed)
		}
	}
	persisted, found, err := secondStore.ClientRequestIndex(indexedClientRequestID)
	if err != nil || !found || persisted != winner {
		t.Fatalf("persisted index=%+v found=%t err=%v, want winner=%+v", persisted, found, err, winner)
	}
	indexEntries, err := os.ReadDir(filepath.Join(root, "index"))
	if err != nil || len(indexEntries) != 1 {
		t.Fatalf("atomic index directory entries=%v err=%v, want one published file", indexEntries, err)
	}
}

func reopenTestService(t *testing.T, root string) *Service {
	t.Helper()
	service, err := newServiceForExistingRoot(root)
	if err != nil {
		t.Fatalf("restart NewService: %v", err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return service
}

func newServiceForExistingRoot(root string) (*Service, error) {
	return NewService(Options{
		DataDir: root, PythonPath: "python3", ConfigPath: filepath.Join(root, "config.yaml"),
		RouterAPIURL: "http://router.invalid", EnvoyURL: "http://envoy.invalid",
		CodeRevision: testSourceRevision, MaxConcurrent: 1, Process: &controlledProcess{},
	})
}
