package evaluationplane

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func recoverStagedCampaigns(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("list staged evaluation campaigns: %w", err)
	}
	removed := false
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), stagedCampaignPrefix) {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || requirePrivateDirectory(path) != nil {
			return fmt.Errorf("%w: staged evaluation campaign is invalid", ErrInvalid)
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove staged evaluation campaign: %w", err)
		}
		removed = true
	}
	if removed {
		return syncEvaluationDirectory(root, "evaluation campaign recovery")
	}
	return nil
}

const (
	campaignFileName     = "campaign.json"
	stagedCampaignPrefix = ".staged-evaluation-campaign-"
)

type campaignManifestSubject struct {
	SchemaVersion   string               `json:"schema_version"`
	ContractVersion string               `json:"contract_version"`
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	Description     string               `json:"description"`
	ChangeProfile   ChangeProfile        `json:"change_profile"`
	GateBindings    CampaignGateBindings `json:"gate_bindings"`
	CreatedAt       time.Time            `json:"created_at"`
}

func campaignManifestDigest(campaign Campaign) (string, error) {
	subject := campaignManifestSubject{
		SchemaVersion: campaign.SchemaVersion, ContractVersion: campaign.ContractVersion,
		ID: campaign.ID, Name: campaign.Name, Description: campaign.Description,
		ChangeProfile: campaign.ChangeProfile, GateBindings: campaign.GateBindings, CreatedAt: campaign.CreatedAt,
	}
	encoded, err := json.Marshal(subject)
	if err != nil {
		return "", fmt.Errorf("encode evaluation campaign identity: %w", err)
	}
	return fmt.Sprintf("sha256:%x", sha256.Sum256(encoded)), nil
}

func campaignDecisionDigest(decision CampaignDecision) (string, error) {
	decision.DecisionDigest = ""
	encoded, err := json.Marshal(decision)
	if err != nil {
		return "", fmt.Errorf("encode evaluation campaign decision: %w", err)
	}
	return fmt.Sprintf("sha256:%x", sha256.Sum256(encoded)), nil
}

func (s *Store) CreateCampaign(campaign Campaign) error {
	if err := validateStoredCampaign(campaign.ID, campaign); err != nil {
		return err
	}
	root := filepath.Join(s.root, "campaigns")
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validateCampaignRunReferencesUnlocked(campaign); err != nil {
		return fmt.Errorf("%w: campaign run evidence is unavailable: %w", ErrInvalid, err)
	}
	if err := requirePrivateDirectory(root); err != nil {
		return err
	}
	destination := filepath.Join(root, campaign.ID)
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("%w: campaign %s already exists", ErrConflict, campaign.ID)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect evaluation campaign destination: %w", err)
	}
	staged, err := os.MkdirTemp(root, stagedCampaignPrefix)
	if err != nil {
		return fmt.Errorf("stage evaluation campaign: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(staged)
		}
	}()
	if err := writeJSONAtomic(filepath.Join(staged, campaignFileName), campaign); err != nil {
		return err
	}
	if err := syncEvaluationDirectory(staged, "staged evaluation campaign"); err != nil {
		return err
	}
	if err := os.Rename(staged, destination); err != nil {
		if _, statErr := os.Lstat(destination); statErr == nil {
			return fmt.Errorf("%w: campaign %s already exists", ErrConflict, campaign.ID)
		}
		return fmt.Errorf("publish evaluation campaign: %w", err)
	}
	published = true
	return syncEvaluationDirectory(root, "evaluation campaigns")
}

func (s *Store) GetCampaign(id string) (Campaign, error) {
	if !validClientRequestID(id) {
		return Campaign{}, fmt.Errorf("%w: campaign id must be a canonical UUID", ErrInvalid)
	}
	directory := filepath.Join(s.root, "campaigns", id)
	if err := requirePrivateDirectory(directory); err != nil {
		if os.IsNotExist(err) {
			return Campaign{}, fmt.Errorf("%w: campaign %s", ErrNotFound, id)
		}
		return Campaign{}, err
	}
	var campaign Campaign
	if err := readJSON(filepath.Join(directory, campaignFileName), &campaign); err != nil {
		return Campaign{}, err
	}
	if err := validateStoredCampaign(id, campaign); err != nil {
		return Campaign{}, err
	}
	return campaign, nil
}

func validateStoredCampaign(id string, campaign Campaign) error {
	if campaign.SchemaVersion != SchemaVersion || campaign.ContractVersion != CampaignContractVersion ||
		campaign.ID != id || !validClientRequestID(id) || campaign.Status != CampaignStatusDecided ||
		campaign.CreatedAt.IsZero() || !validChangeProfile(campaign.ChangeProfile) {
		return fmt.Errorf("%w: evaluation campaign identity is invalid", ErrInvalid)
	}
	digest, err := campaignManifestDigest(campaign)
	if err != nil || campaign.ManifestDigest != digest || campaign.Decision.CampaignDigest != digest {
		return fmt.Errorf("%w: evaluation campaign manifest digest is invalid", ErrInvalid)
	}
	decision := campaign.Decision
	decisionDigest, digestErr := campaignDecisionDigest(decision)
	if decision.SchemaVersion != SchemaVersion || decision.ContractVersion != CampaignContractVersion ||
		decision.AttestationRevision != ServerAttestationRevision || decision.CampaignID != id ||
		digestErr != nil || decision.DecisionDigest != decisionDigest ||
		decision.CreatedAt.IsZero() || len(decision.Gates) != len(requiredGateIDs) || decision.Evidence == nil ||
		decision.Recommendations == nil {
		return fmt.Errorf("%w: evaluation campaign decision is invalid", ErrInvalid)
	}
	if err := validateCampaignDecisionContract(campaign); err != nil {
		return err
	}
	return nil
}
