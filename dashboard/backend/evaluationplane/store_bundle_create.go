package evaluationplane

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const stagedRunBundlePrefix = ".staged-evaluation-run-"

var stagedRunBundleNamePattern = regexp.MustCompile(`^\.staged-evaluation-run-[A-Za-z0-9]+$`)

func recoverStagedRunBundles(runsRoot string) error {
	entries, err := os.ReadDir(runsRoot)
	if err != nil {
		return fmt.Errorf("list staged evaluation bundles: %w", err)
	}
	removed := false
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), stagedRunBundlePrefix) {
			continue
		}
		if !stagedRunBundleNamePattern.MatchString(entry.Name()) {
			return fmt.Errorf("invalid staged evaluation bundle entry")
		}
		path := filepath.Join(runsRoot, entry.Name())
		if err := requirePrivateDirectory(path); err != nil {
			return fmt.Errorf("validate staged evaluation bundle recovery: %w", err)
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove staged evaluation bundle: %w", err)
		}
		removed = true
	}
	if removed {
		return syncEvaluationDirectory(runsRoot, "evaluation runs recovery")
	}
	return nil
}

// CreateBundle publishes the complete initial run bundle in one directory
// rename. Readers can therefore observe either no run or a status, manifest,
// and initial snapshot event together, never a partially initialized run.
func (s *Store) CreateBundle(run Run, manifest RunManifest) (string, error) {
	return s.CreateBundleAs(SystemActor(), run, manifest)
}

func (s *Store) CreateBundleAs(actor Actor, run Run, manifest RunManifest) (string, error) {
	if err := validateActor(actor); err != nil {
		return "", err
	}
	if err := validateStoredRun(run.ID, run); err != nil {
		return "", fmt.Errorf("%w: initial run status is invalid: %w", ErrInvalid, err)
	}
	if run.Status != StatusPending || run.StartedAt != nil || run.CompletedAt != nil || run.Error != "" {
		return "", fmt.Errorf("%w: initial run status must be pending", ErrInvalid)
	}
	if err := validateRunManifestContract(manifest); err != nil {
		return "", fmt.Errorf("%w: initial run manifest is invalid: %w", ErrInvalid, err)
	}
	if err := validateRunManifestFrozenFields(run, manifest); err != nil {
		return "", err
	}
	lifecycle := newRunLifecycle(run, actor)

	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := requirePrivateDirectory(s.runsRoot); err != nil {
		return "", fmt.Errorf("validate evaluation runs directory: %w", err)
	}
	if err := s.validateNewRunReferenceUnlocked(run); err != nil {
		return "", err
	}

	runDir := filepath.Join(s.runsRoot, run.ID)
	if err := s.requireAvailableRunDestinationUnlocked(actor, run.ID, runDir); err != nil {
		return "", err
	}
	if reason, quotaErr := s.requireCreateQuotaUnlocked(actor, 0); quotaErr != nil {
		if _, auditErr := s.appendLifecycleAuditUnlocked(
			actor, "create", "denied", reason, run.ID, actor.principalDigest,
		); auditErr != nil {
			return "", auditErr
		}
		return "", quotaErr
	}

	stagedDir, err := s.stageInitialRunBundleUnlocked(actor, run, manifest, lifecycle)
	if err != nil {
		return "", err
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(stagedDir)
		}
	}()

	// Recheck immediately before publication because another Store instance is
	// not covered by this instance's mutex. UUID identities make this collision
	// exceptional, but an existing destination must never be intentionally
	// replaced.
	if err := s.requireAvailableRunDestinationUnlocked(actor, run.ID, runDir); err != nil {
		return "", err
	}
	if err := os.Rename(stagedDir, runDir); err != nil {
		// Rename reports destination conflicts differently across filesystems
		// (EEXIST, ENOTEMPTY, or platform-specific wrappers). The destination
		// state, not the errno spelling, defines the idempotency conflict.
		if _, statErr := os.Lstat(runDir); statErr == nil {
			return "", fmt.Errorf("%w: run %s already exists", ErrConflict, run.ID)
		}
		return "", fmt.Errorf("publish run bundle: %w", err)
	}
	published = true
	s.runIndex.upsert(run)
	s.runIndex.setEventSequence(run.ID, 1)
	if err := syncEvaluationDirectory(s.runsRoot, "evaluation runs"); err != nil {
		// The bundle is already complete and visible. Leave it in place so a
		// keyed retry can reconcile it instead of converting a sync error into
		// an index that points at missing data.
		return "", err
	}
	return filepath.Join(runDir, manifestFileName), nil
}

func (s *Store) requireAvailableRunDestinationUnlocked(actor Actor, runID, runDir string) error {
	if _, err := os.Lstat(runDir); err == nil {
		_, _ = s.appendLifecycleAuditUnlocked(
			actor, "create", "denied", "conflict", runID, actor.principalDigest,
		)
		return fmt.Errorf("%w: run %s already exists", ErrConflict, runID)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect run bundle destination: %w", err)
	}
	return nil
}

func (s *Store) stageInitialRunBundleUnlocked(
	actor Actor,
	run Run,
	manifest RunManifest,
	lifecycle RunLifecycle,
) (string, error) {
	stagedDir, stageErr := os.MkdirTemp(s.runsRoot, stagedRunBundlePrefix)
	if stageErr != nil {
		return "", fmt.Errorf("stage run bundle: %w", stageErr)
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(stagedDir)
		}
	}()
	if err := requirePrivateDirectory(stagedDir); err != nil {
		return "", fmt.Errorf("validate staged run bundle: %w", err)
	}
	if err := writeJSONAtomic(filepath.Join(stagedDir, runFileName), run); err != nil {
		return "", err
	}
	if err := writeJSONAtomic(filepath.Join(stagedDir, manifestFileName), manifest); err != nil {
		return "", err
	}
	progress := run.Progress
	initialEvent := Event{
		ID: "1", RunID: run.ID, Type: "snapshot", Timestamp: run.CreatedAt,
		Message: "Immutable run manifest created", Progress: &progress,
	}
	if err := writeInitialEventLog(filepath.Join(stagedDir, eventsFileName), initialEvent); err != nil {
		return "", err
	}
	stagedBytes, err := privateDirectoryBytes(stagedDir, "")
	if err != nil {
		return "", err
	}
	if stagedBytes > s.lifecyclePolicy.ReservedRunBytes {
		return "", fmt.Errorf("%w: initial run bundle exceeds its lifecycle reservation", ErrInvalid)
	}
	createAudit, err := s.appendLifecycleAuditUnlocked(
		actor, "create", "allowed", lifecycleAuthorizationReason(actor, lifecycle), run.ID, actor.principalDigest,
	)
	if err != nil {
		return "", err
	}
	lifecycle.CreationAuditDigest = createAudit.Digest
	lifecycle.PolicyDigest = lifecycleDigest(lifecycle)
	if err := validateRunLifecycle(run, lifecycle); err != nil {
		return "", err
	}
	if err := writeJSONAtomic(filepath.Join(stagedDir, lifecycleFileName), lifecycle); err != nil {
		return "", err
	}
	if err := syncEvaluationDirectory(stagedDir, "staged run bundle"); err != nil {
		return "", err
	}
	keep = true
	return stagedDir, nil
}

func writeInitialEventLog(path string, event Event) error {
	if err := validateStoredEvent(event); err != nil {
		return err
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode initial evaluation event: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("initialize evaluation event log: %w", err)
	}
	if _, err = file.Write(append(encoded, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return fmt.Errorf("write initial evaluation event: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close initial evaluation event log: %w", closeErr)
	}
	return nil
}
