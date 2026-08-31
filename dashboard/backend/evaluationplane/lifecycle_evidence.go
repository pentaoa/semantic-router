package evaluationplane

import (
	"encoding/json"
	"fmt"
)

// withEvidencePublication owns the complete lock order for a lifecycle-bound
// evidence transaction. Callers inside the transaction must use the
// *DuringPublication helpers rather than attempting to acquire either outer
// lock again.
func (s *Store) withEvidencePublication(transaction func() error) error {
	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
	return transaction()
}

// writeLifecycleBoundExecutionAttestationDuringPublication is the non-locking
// attestation writer. The caller owns the lifecycle and evidence-publication
// locks through withEvidencePublication.
func (s *Store) writeLifecycleBoundExecutionAttestationDuringPublication(attestation executionAttestation) error {
	encoded, err := json.Marshal(attestation)
	if err != nil || int64(len(encoded)) > maxExecutionAttestationBytes {
		return fmt.Errorf("encode evaluation execution attestation")
	}
	publicationBytes := int64(len(encoded) + 1)

	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireEvidenceQuotaUnlocked(
		attestation.RunID, publicationBytes, 0, publicationBytes,
	); err != nil {
		return err
	}
	return s.writeExecutionAttestation(attestation)
}

// importWorkerEvidence publishes worker artifacts under the same lifecycle,
// quota, index, and evidence lock order used by every other durable mutation.
func (s *Store) importWorkerEvidence(staging *workerStaging) error {
	return s.withEvidencePublication(func() error {
		s.runIndex.coordinator.Lock()
		defer s.runIndex.coordinator.Unlock()
		s.mu.Lock()
		defer s.mu.Unlock()
		return staging.importEvidenceDuringPublication(maxWorkerBundleBytes, s.requireEvidenceQuotaUnlocked)
	})
}
