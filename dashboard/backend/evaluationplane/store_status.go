package evaluationplane

import (
	"fmt"
	"path/filepath"
)

// runStatusPersistence is the narrow atomic-publication seam for the one
// authoritative lifecycle fact. Tests can exercise transient storage failures
// without weakening the production filesystem contract.
type runStatusPersistence interface {
	Write(path string, run Run) error
}

type atomicRunStatusPersistence struct{}

func (atomicRunStatusPersistence) Write(path string, run Run) error {
	return writeJSONAtomic(path, run)
}

// commitRunSealing is the atomic cut between cancellable execution and
// server-owned evidence publication. No canonical worker evidence may be
// published before this transition commits.
func (s *Store) commitRunSealing(id string) (Run, error) {
	if err := validateResourceID(id); err != nil {
		return Run{}, err
	}
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return Run{}, err
	}
	current, err := s.getRunUnlocked(id)
	if err != nil {
		return Run{}, err
	}
	if current.Status != StatusRunning {
		return current, fmt.Errorf("%w: run cannot transition from %s to %s", ErrConflict, current.Status, StatusSealing)
	}
	sealing := current
	sealing.Status = StatusSealing
	sealing.Progress.Message = "Sealing evaluation evidence"
	if err := validateStoredRun(sealing.ID, sealing); err != nil {
		return current, fmt.Errorf("%w: sealing run status is invalid: %w", ErrInvalid, err)
	}
	if err := s.statusPersistence.Write(filepath.Join(runDir, runFileName), sealing); err != nil {
		if durable, readErr := s.getRunUnlocked(id); readErr == nil {
			s.runIndex.upsert(durable)
			return durable, err
		}
		return current, err
	}
	s.runIndex.upsert(sealing)
	return sealing, nil
}

// commitSealedEvidenceLevels persists the run headline and per-track evidence
// strengths independently derived by the server while preserving every other
// sealing-state field.
func (s *Store) commitSealedEvidenceLevels(id string, levels sealedEvidenceLevels) (Run, error) {
	if err := validateResourceID(id); err != nil {
		return Run{}, err
	}
	if evidenceLevelRank(levels.Run) < 0 {
		return Run{}, fmt.Errorf("%w: sealed evidence level is invalid", ErrInvalid)
	}
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	runDir, err := s.checkedRunDir(id)
	if err != nil {
		return Run{}, err
	}
	current, err := s.getRunUnlocked(id)
	if err != nil {
		return Run{}, err
	}
	if current.Status != StatusSealing {
		return current, fmt.Errorf("%w: run cannot seal evidence from %s", ErrConflict, current.Status)
	}
	sealed := current
	sealed.EvidenceLevel = levels.Run
	sealed.TrackEvidenceLevels = copyTrackEvidenceLevels(levels.ByTrack)
	if err := validateStoredRun(sealed.ID, sealed); err != nil {
		return current, fmt.Errorf("%w: sealed evidence status is invalid: %w", ErrInvalid, err)
	}
	if err := s.statusPersistence.Write(filepath.Join(runDir, runFileName), sealed); err != nil {
		if durable, readErr := s.getRunUnlocked(id); readErr == nil {
			s.runIndex.upsert(durable)
			return durable, err
		}
		return current, err
	}
	s.runIndex.upsert(sealed)
	return sealed, nil
}

// commitTerminalRun atomically orders the final status publication after every
// control event across all Store instances sharing this root. The returned SSE
// event is derived from that committed status and the immutable log tail.
func (s *Store) commitTerminalRun(run Run) (Event, error) {
	if err := validateStoredRun(run.ID, run); err != nil {
		return Event{}, fmt.Errorf("%w: terminal run status is invalid: %w", ErrInvalid, err)
	}
	if !terminalStatus(run.Status) {
		return Event{}, fmt.Errorf("%w: terminal run status is required", ErrInvalid)
	}
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	runDir, err := s.checkedRunDir(run.ID)
	if err != nil {
		return Event{}, err
	}
	current, err := s.getRunUnlocked(run.ID)
	if err != nil {
		return Event{}, err
	}
	sequence, err := lastEventSequence(filepath.Join(runDir, eventsFileName), run.ID)
	if err != nil {
		return Event{}, err
	}
	if terminalStatus(current.Status) {
		return terminalEventForRun(current, sequence+1)
	}
	switch current.Status {
	case StatusRunning:
		if run.Status != StatusFailed && run.Status != StatusCancelled {
			return Event{}, fmt.Errorf("%w: run cannot transition from %s to %s", ErrConflict, current.Status, run.Status)
		}
	case StatusSealing:
		if run.Status != StatusCompleted && run.Status != StatusFailed {
			return Event{}, fmt.Errorf("%w: run cannot transition from %s to %s", ErrConflict, current.Status, run.Status)
		}
	default:
		return Event{}, fmt.Errorf("%w: run cannot transition from %s to %s", ErrConflict, current.Status, run.Status)
	}
	terminalEvent, err := terminalEventForRun(run, sequence+1)
	if err != nil {
		return Event{}, err
	}
	if err := s.statusPersistence.Write(filepath.Join(runDir, runFileName), run); err != nil {
		if durable, readErr := s.getRunUnlocked(run.ID); readErr == nil {
			s.runIndex.upsert(durable)
		}
		return Event{}, err
	}
	s.runIndex.upsert(run)
	return terminalEvent, nil
}
