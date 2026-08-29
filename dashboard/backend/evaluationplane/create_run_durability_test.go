package evaluationplane

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const (
	bundleFailureClientRequestID = "bd732c76-dab8-4fb8-9c53-99ad5a8c6e43"
	crashWindowClientRequestID   = "f99f74f3-f3eb-4886-a503-cef54f297dd8"
	concurrentClientRequestID    = "1f529ed8-1997-4193-ab4d-9bad3b0efab2"
	concurrentCreateRequestID    = "ad4df680-cf36-441d-83c5-f4edc94aed01"
)

func TestPersistPendingRunBundleFailureNeverPublishesClientRequestIndex(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = bundleFailureClientRequestID
	request, run, manifest, requestDigest := preparePendingIndexedRun(t, service, request)

	// Force a deterministic publication conflict for the already-selected run
	// identity. The index must remain absent because bundle publication is the
	// first durable step.
	if err := os.Mkdir(filepath.Join(root, "runs", run.ID), 0o700); err != nil {
		t.Fatalf("create conflicting run destination: %v", err)
	}
	if _, err := service.persistPendingRun(request, run, manifest, requestDigest); !errors.Is(err, ErrConflict) {
		t.Fatalf("persistPendingRun error=%v, want ErrConflict", err)
	}
	if indexed, found, err := service.store.ClientRequestIndex(request.ClientRequestID); err != nil || found {
		t.Fatalf("bundle failure published index=%+v found=%t err=%v", indexed, found, err)
	}
	assertNoStagedRunBundles(t, filepath.Join(root, "runs"))
}

func TestPersistPendingRunReservationFailureLeavesRecoverableBundle(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = crashWindowClientRequestID
	request, run, manifest, requestDigest := preparePendingIndexedRun(t, service, request)
	indexPath, pathErr := service.store.clientRequestIndexPath(request.ClientRequestID)
	if pathErr != nil {
		t.Fatalf("clientRequestIndexPath: %v", pathErr)
	}
	if writeErr := os.WriteFile(indexPath, []byte("{not-json\n"), 0o600); writeErr != nil {
		t.Fatalf("stage corrupt reservation: %v", writeErr)
	}

	if _, persistErr := service.persistPendingRun(request, run, manifest, requestDigest); !errors.Is(persistErr, ErrConflict) {
		t.Fatalf("persistPendingRun reservation error=%v, want ErrConflict", persistErr)
	}
	if persisted, getErr := service.store.GetRun(run.ID); getErr != nil || persisted.ID != run.ID {
		t.Fatalf("reservation failure lost recoverable run=%+v err=%v", persisted, getErr)
	}
	assertInitialSnapshotEvent(t, service.store, run.ID)
	if removeErr := os.Remove(indexPath); removeErr != nil {
		t.Fatalf("remove failed reservation: %v", removeErr)
	}
	if closeErr := service.Close(); closeErr != nil {
		t.Fatalf("Close original service: %v", closeErr)
	}

	restarted := reopenTestService(t, root)
	recovered, err := restarted.CreateRun(context.Background(), request)
	if err != nil || recovered.ID != run.ID {
		t.Fatalf("restart did not reconcile recoverable run=%+v err=%v, want %s", recovered, err, run.ID)
	}
}

func TestCreateRunReconcilesCrashAfterAtomicBundleBeforeIndex(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	request := validCreateRequest()
	request.ClientRequestID = crashWindowClientRequestID
	request, run, manifest, _ := preparePendingIndexedRun(t, service, request)

	// Publishing only the atomic bundle models termination in the precise
	// post-rename, pre-index window.
	if _, err := service.store.CreateBundle(run, manifest); err != nil {
		t.Fatalf("publish crash-window bundle: %v", err)
	}
	if indexed, found, err := service.store.ClientRequestIndex(request.ClientRequestID); err != nil || found {
		t.Fatalf("crash-window bundle unexpectedly indexed=%+v found=%t err=%v", indexed, found, err)
	}
	assertInitialSnapshotEvent(t, service.store, run.ID)
	if err := service.Close(); err != nil {
		t.Fatalf("Close crashed service: %v", err)
	}

	restarted := reopenTestService(t, root)
	recovered, err := restarted.CreateRun(context.Background(), request)
	if err != nil || recovered.ID != run.ID {
		t.Fatalf("crash-window retry returned run=%+v err=%v, want %s", recovered, err, run.ID)
	}
	indexed, found, err := restarted.store.ClientRequestIndex(request.ClientRequestID)
	if err != nil || !found || indexed.RunID != run.ID {
		t.Fatalf("reconciled index=%+v found=%t err=%v", indexed, found, err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 1 || entries[0].Name() != run.ID {
		t.Fatalf("crash-window reconciliation left runs=%v err=%v", entries, err)
	}
	if _, startErr := restarted.StartRun(context.Background(), run.ID); startErr != nil {
		t.Fatalf("start reconciled crash-window run: %v", startErr)
	}
	events, err := restarted.EventsAfter(run.ID, "")
	if err != nil || len(events) < 2 || events[0].ID != "1" || events[1].ID != "2" {
		t.Fatalf("restarted event sequence=%+v err=%v, want snapshot 1 then start 2", events, err)
	}
}

func TestPersistPendingRunConcurrentStoresConvergeAndRemoveLoserBundle(t *testing.T) {
	first, root := newTestService(t, &controlledProcess{}, 1)
	second, err := newServiceForExistingRoot(root)
	if err != nil {
		t.Fatalf("open second service: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })
	request := validCreateRequest()
	request.ClientRequestID = concurrentClientRequestID
	firstRequest, firstRun, firstManifest, firstDigest := preparePendingIndexedRun(t, first, request)
	secondRequest, secondRun, secondManifest, secondDigest := preparePendingIndexedRun(t, second, request)
	if firstRun.ID == secondRun.ID {
		t.Fatal("independent pending runs unexpectedly reused an identity")
	}

	type result struct {
		run Run
		err error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		run, persistErr := first.persistPendingRun(firstRequest, firstRun, firstManifest, firstDigest)
		results <- result{run: run, err: persistErr}
	}()
	go func() {
		defer workers.Done()
		<-start
		run, persistErr := second.persistPendingRun(secondRequest, secondRun, secondManifest, secondDigest)
		results <- result{run: run, err: persistErr}
	}()
	close(start)
	workers.Wait()
	close(results)

	var winnerID string
	for outcome := range results {
		if outcome.err != nil {
			t.Fatalf("concurrent persistPendingRun: %v", outcome.err)
		}
		if winnerID == "" {
			winnerID = outcome.run.ID
		}
		if outcome.run.ID != winnerID {
			t.Fatalf("concurrent stores returned different runs: got %s, want %s", outcome.run.ID, winnerID)
		}
	}
	indexed, found, err := first.store.ClientRequestIndex(request.ClientRequestID)
	if err != nil || !found || indexed.RunID != winnerID {
		t.Fatalf("concurrent winner index=%+v found=%t err=%v, want %s", indexed, found, err, winnerID)
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 1 || entries[0].Name() != winnerID {
		t.Fatalf("concurrent publication left loser bundles=%v err=%v, want only %s", entries, err, winnerID)
	}
	assertInitialSnapshotEvent(t, first.store, winnerID)
	assertNoStagedRunBundles(t, filepath.Join(root, "runs"))
}

func TestCreateRunClientRequestIDCollapsesConcurrentStores(t *testing.T) {
	first, root := newTestService(t, &controlledProcess{}, 1)
	second, err := newServiceForExistingRoot(root)
	if err != nil {
		t.Fatalf("open second service: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })
	request := validCreateRequest()
	request.ClientRequestID = concurrentCreateRequestID

	type result struct {
		run Run
		err error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for _, service := range []*Service{first, second} {
		workers.Add(1)
		go func(service *Service) {
			defer workers.Done()
			<-start
			run, createErr := service.CreateRun(context.Background(), request)
			results <- result{run: run, err: createErr}
		}(service)
	}
	close(start)
	workers.Wait()
	close(results)

	var winnerID string
	for outcome := range results {
		if outcome.err != nil {
			t.Fatalf("concurrent cross-store CreateRun: %v", outcome.err)
		}
		if winnerID == "" {
			winnerID = outcome.run.ID
		}
		if outcome.run.ID != winnerID {
			t.Fatalf("concurrent cross-store creates returned %s and %s", winnerID, outcome.run.ID)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, "runs"))
	if err != nil || len(entries) != 1 || entries[0].Name() != winnerID {
		t.Fatalf("concurrent cross-store create left runs=%v err=%v, want only %s", entries, err, winnerID)
	}
	assertInitialSnapshotEvent(t, first.store, winnerID)
}

func TestAppendEventRejectsNonMonotonicDurableHistoryAfterCacheLoss(t *testing.T) {
	service, root := newTestService(t, &controlledProcess{}, 1)
	run, err := service.CreateRun(context.Background(), validCreateRequest())
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	eventsPath := filepath.Join(root, "runs", run.ID, eventsFileName)
	initial, err := os.ReadFile(eventsPath)
	if err != nil {
		t.Fatalf("read initial event history: %v", err)
	}
	if err := os.WriteFile(eventsPath, append(initial, initial...), 0o600); err != nil {
		t.Fatalf("duplicate initial event history: %v", err)
	}
	service.store.mu.Lock()
	delete(service.store.sequences, run.ID)
	service.store.mu.Unlock()
	if _, err := service.store.AppendEvent(Event{RunID: run.ID, Type: "progress"}); err == nil || !strings.Contains(err.Error(), "strictly monotonic") {
		t.Fatalf("AppendEvent non-monotonic history error=%v", err)
	}
}

func preparePendingIndexedRun(
	t *testing.T,
	service *Service,
	request CreateRunRequest,
) (CreateRunRequest, Run, RunManifest, string) {
	t.Helper()
	registry, snapshot, err := service.registrySnapshot()
	if err != nil {
		t.Fatalf("registrySnapshot: %v", err)
	}
	validated, target, err := service.validateCreateRequest(registry, request)
	if err != nil {
		t.Fatalf("validateCreateRequest: %v", err)
	}
	evidenceLevel, err := selectedSuiteEvidenceLevel(registry, validated.SuiteIDs)
	if err != nil {
		t.Fatalf("selectedSuiteEvidenceLevel: %v", err)
	}
	run, manifest, err := service.newPendingRunManifest(registry, validated, target, snapshot, evidenceLevel)
	if err != nil {
		t.Fatalf("newPendingRunManifest: %v", err)
	}
	requestDigest, err := createRequestDigest(validated)
	if err != nil {
		t.Fatalf("createRequestDigest: %v", err)
	}
	return validated, run, manifest, requestDigest
}

func assertInitialSnapshotEvent(t *testing.T, store *Store, runID string) {
	t.Helper()
	events, err := store.EventsAfter(runID, 0)
	if err != nil {
		t.Fatalf("EventsAfter initial snapshot: %v", err)
	}
	if len(events) != 1 || events[0].ID != "1" || events[0].RunID != runID || events[0].Type != "snapshot" {
		t.Fatalf("initial events=%+v, want one canonical snapshot", events)
	}
}

func assertNoStagedRunBundles(t *testing.T, runsRoot string) {
	t.Helper()
	entries, err := os.ReadDir(runsRoot)
	if err != nil {
		t.Fatalf("read runs root: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), stagedRunBundlePrefix) {
			t.Fatalf("staged run bundle leaked after publication: %s", entry.Name())
		}
	}
}
