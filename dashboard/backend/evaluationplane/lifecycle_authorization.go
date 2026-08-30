package evaluationplane

import (
	"errors"
	"fmt"
)

func (s *Store) auditExistingCreate(actor Actor, run Run) error {
	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	if err := validateActor(actor); err != nil {
		return err
	}
	lifecycle, err := s.readRunLifecycle(run)
	if err != nil {
		return err
	}
	if !actor.administrator && actor.principalDigest != lifecycle.OwnerPrincipalDigest {
		if _, auditErr := s.appendLifecycleAuditUnlocked(
			actor, "create", "denied", "not_owner", run.ID, lifecycle.OwnerPrincipalDigest,
		); auditErr != nil {
			return auditErr
		}
		return fmt.Errorf("%w: client_request_id belongs to another evaluation principal", ErrForbidden)
	}
	_, err = s.appendLifecycleAuditUnlocked(
		actor, "create", "allowed", lifecycleAuthorizationReason(actor, lifecycle), run.ID, lifecycle.OwnerPrincipalDigest,
	)
	return err
}

func (s *Store) authorizeRunActionUnlocked(actor Actor, runID, action string) error {
	if err := validateActor(actor); err != nil {
		return err
	}
	if !validClientRequestID(runID) || !validLifecycleAction(action) || action == "create" || action == "gc" {
		return fmt.Errorf("%w: lifecycle action identity is invalid", ErrInvalid)
	}
	run, err := s.getRunUnlocked(runID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			if _, auditErr := s.appendLifecycleAuditUnlocked(
				actor, action, "denied", "not_found", runID, "",
			); auditErr != nil {
				return auditErr
			}
		}
		return err
	}
	lifecycle, err := s.readRunLifecycle(run)
	if err != nil {
		return err
	}
	if !actor.administrator && actor.principalDigest != lifecycle.OwnerPrincipalDigest {
		if _, auditErr := s.appendLifecycleAuditUnlocked(
			actor, action, "denied", "not_owner", runID, lifecycle.OwnerPrincipalDigest,
		); auditErr != nil {
			return auditErr
		}
		return fmt.Errorf("%w: run belongs to another evaluation principal", ErrForbidden)
	}
	if action == "delete" {
		if lifecycle.EvidenceHold {
			if _, auditErr := s.appendLifecycleAuditUnlocked(
				actor, action, "denied", "evidence_hold", runID, lifecycle.OwnerPrincipalDigest,
			); auditErr != nil {
				return auditErr
			}
			return fmt.Errorf("%w: held evidence cannot be deleted", ErrConflict)
		}
		if lifecycle.RetentionClass == RetentionProtected {
			if _, auditErr := s.appendLifecycleAuditUnlocked(
				actor, action, "denied", "protected_retention", runID, lifecycle.OwnerPrincipalDigest,
			); auditErr != nil {
				return auditErr
			}
			return fmt.Errorf("%w: protected evidence cannot be deleted", ErrConflict)
		}
		return nil
	}
	_, err = s.appendLifecycleAuditUnlocked(
		actor, action, "allowed", lifecycleAuthorizationReason(actor, lifecycle), runID, lifecycle.OwnerPrincipalDigest,
	)
	return err
}

func (s *Store) authorizeAdministratorActionUnlocked(actor Actor, action, reason string) error {
	if err := validateActor(actor); err != nil {
		return err
	}
	if !actor.administrator {
		if _, auditErr := s.appendLifecycleAuditUnlocked(
			actor, action, "denied", "not_administrator", "", "",
		); auditErr != nil {
			return auditErr
		}
		return fmt.Errorf("%w: administrator authority is required", ErrForbidden)
	}
	_, err := s.appendLifecycleAuditUnlocked(actor, action, "allowed", reason, "", "")
	return err
}
