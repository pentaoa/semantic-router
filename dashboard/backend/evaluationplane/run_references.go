package evaluationplane

import (
	"fmt"
	"os"
)

// validateRunReferenceIntegrity rejects a store whose durable run graph cannot
// be reconstructed exactly. Baseline links are scientific cohort identities,
// not best-effort UI metadata.
func (s *Store) validateRunReferenceIntegrity() error {
	// Corrupt bundles remain quarantined by the run ledger. Valid candidates
	// must still resolve their baseline within the valid projection; otherwise
	// startup would publish a dangling scientific comparison graph.
	runs := s.runIndex.allRuns()
	byID := make(map[string]Run, len(runs))
	for _, run := range runs {
		byID[run.ID] = run
	}
	for _, run := range runs {
		if run.BaselineRunID == "" {
			continue
		}
		baseline, found := byID[run.BaselineRunID]
		if !found || baseline.ID == run.ID || !baseline.CreatedAt.Before(run.CreatedAt) {
			return fmt.Errorf("%w: run %s has a dangling or non-causal baseline reference", ErrInvalid, run.ID)
		}
	}
	return nil
}

func (s *Store) loadCompleteRunReferenceLedgerUnlocked() ([]Run, error) {
	entries, err := os.ReadDir(s.runsRoot)
	if err != nil {
		return nil, fmt.Errorf("list evaluation runs: %w", err)
	}
	runs := make([]Run, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validClientRequestID(entry.Name()) {
			return nil, fmt.Errorf("evaluation run ledger contains an invalid entry")
		}
		run, readErr := s.getRunUnlocked(entry.Name())
		if readErr != nil {
			return nil, readErr
		}
		runs = append(runs, run)
	}
	return runs, nil
}

func (s *Store) ensureRunNotBaselineReferencedUnlocked(runID string) error {
	runs, err := s.loadCompleteRunReferenceLedgerUnlocked()
	if err != nil {
		return fmt.Errorf("%w: run reference ledger cannot be verified: %w", ErrConflict, err)
	}
	for _, run := range runs {
		if run.BaselineRunID == runID {
			return fmt.Errorf("%w: run is the baseline of run %s", ErrConflict, run.ID)
		}
	}
	return nil
}

func (s *Store) validateNewRunReferenceUnlocked(run Run) error {
	if run.BaselineRunID == "" {
		return nil
	}
	runs, err := s.loadCompleteRunReferenceLedgerUnlocked()
	if err != nil {
		return fmt.Errorf("%w: run reference ledger cannot be verified before candidate publication: %w", ErrConflict, err)
	}
	var baseline Run
	found := false
	for _, stored := range runs {
		if stored.ID == run.BaselineRunID {
			baseline, found = stored, true
			break
		}
	}
	if !found || baseline.Status != StatusCompleted || !baseline.CreatedAt.Before(run.CreatedAt) {
		return fmt.Errorf("%w: baseline is no longer a completed causal predecessor", ErrConflict)
	}
	return nil
}
