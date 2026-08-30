package evaluationplane

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

type lifecyclePolicyPersistence interface {
	Write(path string, value any) error
}

type atomicLifecyclePolicyPersistence struct{}

func (atomicLifecyclePolicyPersistence) Write(path string, value any) error {
	return writeJSONAtomic(path, value)
}

func (s *Store) initializeLifecyclePolicyUnlocked(limits LifecycleLimits) error {
	expected := newLifecycleStorePolicy(limits)
	path := filepath.Join(s.lifecycleRoot, lifecyclePolicyFileName)
	var stored lifecycleStorePolicy
	if err := readJSON(path, &stored); err != nil {
		if !errors.Is(err, ErrNotFound) {
			return fmt.Errorf("read evaluation lifecycle policy: %w", err)
		}
		empty, emptyErr := s.lifecycleStoreIsFreshUnlocked()
		if emptyErr != nil {
			return emptyErr
		}
		if !empty {
			return fmt.Errorf(
				"%w: evaluation store predates the current lifecycle contract; use a fresh store",
				ErrInvalid,
			)
		}
		if writeErr := writeJSONAtomic(path, expected); writeErr != nil {
			return writeErr
		}
		stored = expected
	}
	if err := validateLifecycleStorePolicy(stored); err != nil {
		return err
	}
	if !reflect.DeepEqual(stored, expected) {
		return fmt.Errorf("%w: configured lifecycle limits do not match the durable store policy", ErrConflict)
	}
	s.lifecyclePolicy = stored
	return nil
}

func (s *Store) lifecycleStoreIsFreshUnlocked() (bool, error) {
	for _, directory := range []string{s.runsRoot, s.lifecycleAuditRoot} {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return false, err
		}
		if len(entries) != 0 {
			return false, nil
		}
	}
	return true, nil
}

func validateLifecycleStorePolicy(policy lifecycleStorePolicy) error {
	limits, err := normalizeLifecycleLimits(policy.Limits)
	if err != nil || policy.SchemaVersion != lifecyclePolicySchemaVersion ||
		policy.PolicyRevision != lifecyclePolicyRevision || policy.ReservedRunBytes != reservedRunBytes ||
		!reflect.DeepEqual(limits, policy.Limits) || policy.PolicyDigest != lifecycleDigest(policy) {
		return fmt.Errorf("%w: durable evaluation lifecycle policy is invalid", ErrInvalid)
	}
	return nil
}

func (s *Store) readRunLifecycle(run Run) (RunLifecycle, error) {
	runDir, err := s.checkedRunDir(run.ID)
	if err != nil {
		return RunLifecycle{}, err
	}
	var lifecycle RunLifecycle
	if err := readJSON(filepath.Join(runDir, lifecycleFileName), &lifecycle); err != nil {
		return RunLifecycle{}, fmt.Errorf("validate run lifecycle: %w", err)
	}
	if err := validateRunLifecycle(run, lifecycle); err != nil {
		return RunLifecycle{}, err
	}
	return lifecycle, nil
}

func (s *Store) validateLifecycleRunBindings() error {
	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	for _, run := range s.runIndex.allRuns() {
		lifecycle, err := s.readRunLifecycle(run)
		if err != nil {
			// Corrupt lifecycle metadata is represented by the run ledger's
			// quarantine warning. The store remains readable, while every
			// scientific or destructive decision fails on the incomplete ledger.
			continue
		}
		record, exists := s.lifecycle.records[lifecycle.CreationAuditDigest]
		if !exists || record.Action != "create" || record.Decision != "allowed" ||
			record.RunID != run.ID || record.OwnerDigest != lifecycle.OwnerPrincipalDigest {
			return fmt.Errorf("%w: run lifecycle is not bound to its creation audit", ErrInvalid)
		}
	}
	return nil
}

func retentionDeleteAfter(class RetentionClass, now time.Time) (*time.Time, error) {
	now = now.UTC().Truncate(time.Microsecond)
	var duration time.Duration
	switch class {
	case RetentionEphemeral:
		duration = 7 * 24 * time.Hour
	case RetentionStandard:
		duration = 30 * 24 * time.Hour
	case RetentionProtected:
		return nil, nil
	default:
		return nil, fmt.Errorf("%w: unsupported retention class", ErrInvalid)
	}
	deleteAfter := now.Add(duration)
	return &deleteAfter, nil
}

func (s *Store) lifecycleForActor(actor Actor, runID string) (RunLifecycle, error) {
	if err := validateActor(actor); err != nil {
		return RunLifecycle{}, err
	}
	run, err := s.getRunUnlocked(runID)
	if err != nil {
		return RunLifecycle{}, err
	}
	lifecycle, err := s.readRunLifecycle(run)
	if err != nil {
		return RunLifecycle{}, err
	}
	if !actor.administrator && lifecycle.OwnerPrincipalDigest != actor.principalDigest {
		return RunLifecycle{}, fmt.Errorf("%w: run belongs to another evaluation principal", ErrForbidden)
	}
	return lifecycle, nil
}

func (s *Store) RunLifecycle(actor Actor, runID string) (RunLifecycleView, error) {
	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	lifecycle, lifecycleErr := s.lifecycleForActor(actor, runID)
	if lifecycleErr != nil {
		return RunLifecycleView{}, lifecycleErr
	}
	return publicRunLifecycle(lifecycle), nil
}

func (s *Store) UpdateRunLifecycle(
	actor Actor,
	runID string,
	request UpdateRunLifecycleRequest,
) (RunLifecycleView, error) {
	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	lifecycle, lifecycleErr := s.lifecycleForActor(actor, runID)
	if lifecycleErr != nil {
		if validClientRequestID(runID) && validateActor(actor) == nil {
			owner := ""
			if run, readErr := s.getRunUnlocked(runID); readErr == nil {
				if current, currentLifecycleErr := s.readRunLifecycle(run); currentLifecycleErr == nil {
					owner = current.OwnerPrincipalDigest
				}
			}
			if auditErr := s.auditLifecycleMutationDenialUnlocked(
				actor, runID, owner, request, lifecycleDenialReason(lifecycleErr),
			); auditErr != nil {
				return RunLifecycleView{}, auditErr
			}
		}
		return RunLifecycleView{}, lifecycleErr
	}
	if request.RetentionClass == nil && request.EvidenceHold == nil {
		return RunLifecycleView{}, fmt.Errorf("%w: lifecycle update contains no mutation", ErrInvalid)
	}
	now := s.lifecycleNow().UTC().Truncate(time.Microsecond)
	updated := lifecycle
	actions := make([]string, 0, 2)
	if request.RetentionClass != nil && *request.RetentionClass != lifecycle.RetentionClass {
		deleteAfter, retentionErr := retentionDeleteAfter(*request.RetentionClass, now)
		if retentionErr != nil {
			if _, auditErr := s.appendLifecycleAuditUnlocked(
				actor, "retention", "denied", "invalid_request", runID, lifecycle.OwnerPrincipalDigest,
			); auditErr != nil {
				return RunLifecycleView{}, auditErr
			}
			return RunLifecycleView{}, retentionErr
		}
		updated.RetentionClass, updated.DeleteAfter = *request.RetentionClass, deleteAfter
		actions = append(actions, "retention")
	}
	if request.EvidenceHold != nil && *request.EvidenceHold != lifecycle.EvidenceHold {
		updated.EvidenceHold = *request.EvidenceHold
		if updated.EvidenceHold {
			actions = append(actions, "hold")
		} else {
			actions = append(actions, "release")
		}
	}
	if len(actions) == 0 {
		return publicRunLifecycle(lifecycle), nil
	}
	reason := lifecycleAuthorizationReason(actor, lifecycle)
	for _, action := range actions {
		if _, err := s.appendLifecycleAuditUnlocked(
			actor, action, "allowed", reason, runID, lifecycle.OwnerPrincipalDigest,
		); err != nil {
			return RunLifecycleView{}, err
		}
	}
	updated.UpdatedAt, updated.PolicyDigest = now, ""
	updated.PolicyDigest = lifecycleDigest(updated)
	run, runErr := s.getRunUnlocked(runID)
	if runErr != nil {
		return RunLifecycleView{}, runErr
	}
	if err := validateRunLifecycle(run, updated); err != nil {
		return RunLifecycleView{}, err
	}
	runDir, err := s.checkedRunDir(runID)
	if err != nil {
		return RunLifecycleView{}, err
	}
	if err := s.lifecyclePersistence.Write(filepath.Join(runDir, lifecycleFileName), updated); err != nil {
		return RunLifecycleView{}, err
	}
	return publicRunLifecycle(updated), nil
}

func lifecycleAuthorizationReason(actor Actor, lifecycle RunLifecycle) string {
	if actor.principalDigest == SystemActor().principalDigest {
		return "system"
	}
	if actor.administrator {
		return "administrator"
	}
	if actor.principalDigest == lifecycle.OwnerPrincipalDigest {
		return "owner"
	}
	return "not_owner"
}

func lifecycleDenialReason(err error) string {
	if isForbidden(err) {
		return "not_owner"
	}
	if errors.Is(err, ErrNotFound) {
		return "not_found"
	}
	return "conflict"
}

func isForbidden(err error) bool {
	return errors.Is(err, ErrForbidden)
}

func lifecycleMutationActions(request UpdateRunLifecycleRequest) []string {
	actions := make([]string, 0, 2)
	if request.RetentionClass != nil {
		actions = append(actions, "retention")
	}
	if request.EvidenceHold != nil {
		if *request.EvidenceHold {
			actions = append(actions, "hold")
		} else {
			actions = append(actions, "release")
		}
	}
	return actions
}

func (s *Store) auditLifecycleMutationDenialUnlocked(
	actor Actor,
	runID string,
	ownerDigest string,
	request UpdateRunLifecycleRequest,
	reason string,
) error {
	for _, action := range lifecycleMutationActions(request) {
		if _, err := s.appendLifecycleAuditUnlocked(
			actor, action, "denied", reason, runID, ownerDigest,
		); err != nil {
			return err
		}
	}
	return nil
}
