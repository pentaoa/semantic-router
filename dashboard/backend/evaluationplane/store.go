package evaluationplane

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	runFileName      = "status.json"
	manifestFileName = "run-manifest.json"
	eventsFileName   = "control-events.jsonl"
	reportFileName   = "report.json"
	maxEventsPerRun  = uint64(8192)
	maxEventLogBytes = int64(16 * 1024 * 1024)
)

type Store struct {
	root                 string
	runsRoot             string
	suiteRoot            string
	attestationRoot      string
	lifecycleRoot        string
	lifecycleAuditRoot   string
	mu                   sync.Mutex
	runIndex             *runMetadataIndex
	lifecycle            *lifecycleCoordinator
	lifecyclePolicy      lifecycleStorePolicy
	lifecycleNow         func() time.Time
	lifecyclePersistence lifecyclePolicyPersistence
	lifecycleAuditWriter lifecycleAuditWriter
	statusPersistence    runStatusPersistence
}

func NewStore(root string) (*Store, error) {
	return newStoreWithLifecycleLimits(root, LifecycleLimits{})
}

func newStoreWithLifecycleLimits(root string, requestedLimits LifecycleLimits) (*Store, error) {
	if root == "" {
		return nil, fmt.Errorf("%w: evaluation data directory is required", ErrInvalid)
	}
	limits, err := normalizeLifecycleLimits(requestedLimits)
	if err != nil {
		return nil, err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve evaluation data directory: %w", err)
	}
	runsRoot := filepath.Join(absRoot, "runs")
	suiteRoot := filepath.Join(absRoot, "suites")
	attestationRoot := filepath.Join(absRoot, "attestations")
	lifecycleRoot := filepath.Join(absRoot, "lifecycle")
	lifecycleAuditRoot := filepath.Join(lifecycleRoot, lifecycleAuditDirectoryName)
	privateDirectories := []string{
		absRoot,
		filepath.Join(absRoot, "campaigns"),
		filepath.Join(absRoot, "objects"),
		filepath.Join(absRoot, "objects", "sha256"),
		runsRoot,
		suiteRoot,
		attestationRoot,
		lifecycleRoot,
		lifecycleAuditRoot,
		filepath.Join(suiteRoot, "objects", "visible", "sha256"),
		filepath.Join(suiteRoot, "objects", "grading", "sha256"),
		filepath.Join(suiteRoot, "objects", "metadata", "sha256"),
		filepath.Join(suiteRoot, "manifests", "sha256"),
		filepath.Join(suiteRoot, "index"),
	}
	for _, directory := range privateDirectories {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("create evaluation store directory: %w", err)
		}
		if err := requirePrivateDirectory(directory); err != nil {
			return nil, err
		}
	}
	if err := recoverStagedRunBundles(runsRoot); err != nil {
		return nil, err
	}
	if err := recoverStagedCampaigns(filepath.Join(absRoot, "campaigns")); err != nil {
		return nil, err
	}
	store := &Store{
		root: absRoot, runsRoot: runsRoot, suiteRoot: suiteRoot, attestationRoot: attestationRoot,
		lifecycleRoot: lifecycleRoot, lifecycleAuditRoot: lifecycleAuditRoot,
		runIndex:             sharedRunMetadataIndex(absRoot),
		lifecycle:            sharedLifecycleCoordinator(absRoot),
		lifecycleNow:         func() time.Time { return time.Now().UTC() },
		lifecyclePersistence: atomicLifecyclePolicyPersistence{},
		lifecycleAuditWriter: atomicLifecycleAuditWriter{},
		statusPersistence:    atomicRunStatusPersistence{},
	}
	store.lifecycle.mu.Lock()
	if err := store.initializeLifecyclePolicyUnlocked(limits); err != nil {
		store.lifecycle.mu.Unlock()
		return nil, err
	}
	if err := store.validateLifecycleAuditUnlocked(); err != nil {
		store.lifecycle.mu.Unlock()
		return nil, err
	}
	store.lifecycle.mu.Unlock()
	if err := store.recoverExecutionAttestations(); err != nil {
		return nil, err
	}
	if err := store.refreshRunIndex(); err != nil {
		return nil, err
	}
	if err := store.validateLifecycleRunBindings(); err != nil {
		return nil, err
	}
	if err := store.validateRunReferenceIntegrity(); err != nil {
		return nil, err
	}
	if err := store.validateCampaignReferenceIntegrity(); err != nil {
		return nil, err
	}
	store.recoverCASGarbage()
	return store, nil
}

func (s *Store) Root() string { return s.root }

func (s *Store) SuiteRoot() string { return s.suiteRoot }

func (s *Store) GetRun(id string) (Run, error) {
	run, err := s.getRunUnlocked(id)
	if err != nil {
		return Run{}, err
	}
	if _, err := s.readRunLifecycle(run); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Store) UpdateRun(run Run) error {
	if err := validateStoredRun(run.ID, run); err != nil {
		return fmt.Errorf("%w: evaluation run status is invalid: %w", ErrInvalid, err)
	}
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	runDir, err := s.checkedRunDir(run.ID)
	if err != nil {
		return err
	}
	if err := s.statusPersistence.Write(filepath.Join(runDir, runFileName), run); err != nil {
		// Atomic publication may have completed before a directory sync error.
		// Re-read the canonical fact so the in-memory projection never guesses.
		if durable, readErr := s.getRunUnlocked(run.ID); readErr == nil {
			s.runIndex.upsert(durable)
		}
		return err
	}
	s.runIndex.upsert(run)
	return nil
}

func (s *Store) ManifestPath(id string) (string, error) {
	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return "", err
	}
	path := filepath.Join(runDir, manifestFileName)
	file, err := openBundleFile(path, os.O_RDONLY)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: run manifest", ErrNotFound)
		}
		return "", fmt.Errorf("open run manifest: %w", err)
	}
	_ = file.Close()
	return path, nil
}

func (s *Store) ReadReport(id string) ([]byte, error) {
	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(runDir, reportFileName)
	file, err := openBundleFile(path, os.O_RDONLY)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: evaluation report", ErrNotFound)
		}
		return nil, fmt.Errorf("read evaluation report: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat evaluation report: %w", err)
	}
	if info.Size() > maxStructuredArtifactBytes {
		return nil, fmt.Errorf("evaluation report exceeds the structured artifact limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxStructuredArtifactBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read evaluation report: %w", err)
	}
	if int64(len(data)) > maxStructuredArtifactBytes {
		return nil, fmt.Errorf("evaluation report exceeds the structured artifact limit")
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("evaluation report is not valid JSON")
	}
	return data, nil
}

func (s *Store) WriteReport(id string, report any) error {
	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(runDir, reportFileName), report)
}

func (s *Store) checkedRunDir(id string) (string, error) {
	if err := validateResourceID(id); err != nil {
		return "", err
	}
	runDir := filepath.Join(s.runsRoot, id)
	info, err := os.Lstat(runDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: run %s", ErrNotFound, id)
		}
		return "", fmt.Errorf("stat evaluation run: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("evaluation run bundle is not a directory")
	}
	if err := requirePrivateDirectory(runDir); err != nil {
		return "", err
	}
	return runDir, nil
}

func (s *Store) getRunUnlocked(id string) (Run, error) {
	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return Run{}, err
	}
	var run Run
	if err := readJSON(filepath.Join(runDir, runFileName), &run); err != nil {
		return Run{}, err
	}
	if err := validateStoredRun(id, run); err != nil {
		return Run{}, fmt.Errorf("validate evaluation run status: %w", err)
	}
	return run, nil
}
