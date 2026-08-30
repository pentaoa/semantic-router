package evaluationplane

import (
	"encoding/json"
	"fmt"
)

// writeLifecycleBoundExecutionAttestation publishes server evidence inside the
// same quota/publication coordination used by worker artifacts and deletion.
// The lower-level writer remains available only for restart fault fixtures that
// deliberately construct orphan attestations.
func (s *Store) writeLifecycleBoundExecutionAttestation(attestation executionAttestation) error {
	encoded, err := json.Marshal(attestation)
	if err != nil || int64(len(encoded)) > maxExecutionAttestationBytes {
		return fmt.Errorf("encode evaluation execution attestation")
	}
	publicationBytes := int64(len(encoded) + 1)

	s.lifecycle.mu.Lock()
	defer s.lifecycle.mu.Unlock()
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
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
