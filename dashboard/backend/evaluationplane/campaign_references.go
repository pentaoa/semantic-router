package evaluationplane

import (
	"fmt"
	"os"
	"path/filepath"
)

func (s *Store) validateCampaignReferenceIntegrity() error {
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	campaigns, err := s.loadStoredCampaignsUnlocked()
	if err != nil {
		return err
	}
	for _, campaign := range campaigns {
		if err := s.validateCampaignRunReferencesUnlocked(campaign); err != nil {
			return fmt.Errorf("%w: campaign %s has unavailable sealed run evidence: %w", ErrInvalid, campaign.ID, err)
		}
	}
	return nil
}

func (s *Store) validateCampaignRunReferencesUnlocked(campaign Campaign) error {
	for _, expected := range campaign.Decision.Evidence {
		runDir, err := s.checkedRunDir(expected.RunID)
		if err != nil {
			return err
		}
		anchor, err := s.readReportAnchor(expected.RunID)
		if err != nil {
			return err
		}
		if anchor.ManifestSemanticDigest != expected.ManifestSemanticDigest ||
			anchor.ManifestArtifactDigest != expected.ManifestArtifactDigest ||
			anchor.ReportDigest != expected.ReportDigest ||
			anchor.PrivateReceiptDigest != expected.PrivateReceiptDigest ||
			anchor.ExecutionAttestationDigest != expected.ExecutionAttestationDigest ||
			anchor.CreatedAt.After(campaign.CreatedAt) {
			return fmt.Errorf("campaign evidence anchor does not match its sealed run")
		}
		manifest, err := readEvidenceBytes(filepath.Join(runDir, manifestFileName), maxStructuredArtifactBytes)
		if err != nil || digestBytes(manifest) != expected.ManifestArtifactDigest {
			return fmt.Errorf("campaign manifest evidence is unavailable or changed")
		}
		report, err := s.ReadReport(expected.RunID)
		if err != nil {
			return err
		}
		reportDigest, reportSize := digestAndSize(report)
		if reportDigest != expected.ReportDigest || reportSize != anchor.ReportSize {
			return fmt.Errorf("campaign report evidence is unavailable or changed")
		}
		privateReceipt, err := readEvidenceBytes(
			filepath.Join(runDir, privateChecksumArtifactName), maxStructuredArtifactBytes,
		)
		if err != nil || digestBytes(privateReceipt) != expected.PrivateReceiptDigest {
			return fmt.Errorf("campaign private receipt is unavailable or changed")
		}
		if expected.ExecutionAttestationDigest != "" {
			attestation, attestationErr := s.readExecutionAttestation(expected.RunID)
			if attestationErr != nil || attestation.Digest != expected.ExecutionAttestationDigest {
				return fmt.Errorf("campaign execution attestation is unavailable or changed")
			}
		}
	}
	return nil
}

func (s *Store) ensureRunNotCampaignReferencedUnlocked(runID string) error {
	campaigns, err := s.loadStoredCampaignsUnlocked()
	if err != nil {
		return fmt.Errorf("%w: campaign reference ledger cannot be verified: %w", ErrConflict, err)
	}
	for _, campaign := range campaigns {
		bindings, bindingErr := campaignEvidenceBindings(campaign.GateBindings)
		if bindingErr != nil {
			return fmt.Errorf("%w: campaign binding ledger is invalid: %w", ErrConflict, bindingErr)
		}
		for _, binding := range bindings {
			if binding.runID == runID {
				return fmt.Errorf("%w: run is referenced by immutable campaign %s", ErrConflict, campaign.ID)
			}
		}
	}
	return nil
}

func (s *Store) loadStoredCampaignsUnlocked() ([]Campaign, error) {
	root := filepath.Join(s.root, "campaigns")
	if err := requirePrivateDirectory(root); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("list evaluation campaigns: %w", err)
	}
	campaigns := make([]Campaign, 0, len(entries))
	for _, entry := range entries {
		if !validClientRequestID(entry.Name()) || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("evaluation campaign store contains an invalid entry")
		}
		directory := filepath.Join(root, entry.Name())
		if err := requirePrivateDirectory(directory); err != nil {
			return nil, err
		}
		files, err := os.ReadDir(directory)
		if err != nil || len(files) != 1 || files[0].Name() != campaignFileName ||
			!files[0].Type().IsRegular() || files[0].Type()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("evaluation campaign bundle is invalid")
		}
		var campaign Campaign
		if err := readJSON(filepath.Join(directory, campaignFileName), &campaign); err != nil {
			return nil, err
		}
		if err := validateStoredCampaign(entry.Name(), campaign); err != nil {
			return nil, err
		}
		campaigns = append(campaigns, campaign)
	}
	return campaigns, nil
}
