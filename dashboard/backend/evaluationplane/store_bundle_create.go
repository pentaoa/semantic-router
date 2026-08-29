package evaluationplane

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const stagedRunBundlePrefix = ".staged-evaluation-run-"

// CreateBundle publishes the complete initial run bundle in one directory
// rename. Readers can therefore observe either no run or a status, manifest,
// and initial snapshot event together, never a partially initialized run.
func (s *Store) CreateBundle(run Run, manifest RunManifest) (string, error) {
	if err := validateResourceID(run.ID); err != nil {
		return "", err
	}
	if manifest.RunID != run.ID {
		return "", fmt.Errorf("%w: run manifest identity does not match status", ErrInvalid)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := requirePrivateDirectory(s.runsRoot); err != nil {
		return "", fmt.Errorf("validate evaluation runs directory: %w", err)
	}

	runDir := filepath.Join(s.runsRoot, run.ID)
	if _, err := os.Lstat(runDir); err == nil {
		return "", fmt.Errorf("%w: run %s already exists", ErrConflict, run.ID)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect run bundle destination: %w", err)
	}

	stagedDir, err := os.MkdirTemp(s.runsRoot, stagedRunBundlePrefix)
	if err != nil {
		return "", fmt.Errorf("stage run bundle: %w", err)
	}
	published := false
	defer func() {
		if !published {
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
	if err := syncEvaluationDirectory(stagedDir, "staged run bundle"); err != nil {
		return "", err
	}

	// Recheck immediately before publication because another Store instance is
	// not covered by this instance's mutex. UUID identities make this collision
	// exceptional, but an existing destination must never be intentionally
	// replaced.
	if _, err := os.Lstat(runDir); err == nil {
		return "", fmt.Errorf("%w: run %s already exists", ErrConflict, run.ID)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect run bundle destination: %w", err)
	}
	if err := os.Rename(stagedDir, runDir); err != nil {
		if os.IsExist(err) {
			return "", fmt.Errorf("%w: run %s already exists", ErrConflict, run.ID)
		}
		return "", fmt.Errorf("publish run bundle: %w", err)
	}
	published = true
	s.sequences[run.ID] = 1
	if err := syncEvaluationDirectory(s.runsRoot, "evaluation runs"); err != nil {
		// The bundle is already complete and visible. Leave it in place so a
		// keyed retry can reconcile it instead of converting a sync error into
		// an index that points at missing data.
		return "", err
	}
	return filepath.Join(runDir, manifestFileName), nil
}

func writeInitialEventLog(path string, event Event) error {
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

func syncEvaluationDirectory(path, description string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s directory: %w", description, err)
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		return fmt.Errorf("sync %s directory: %w", description, syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s directory: %w", description, closeErr)
	}
	return nil
}
