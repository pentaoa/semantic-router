package evaluationplane

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func campaignV2StoredSchemaFixture(t *testing.T) Campaign {
	t.Helper()
	request := campaignV2Request("schema_adapter")
	request.GateBindings = CampaignGateBindings{
		G2RunID: "11111111-1111-4111-8111-111111111111",
		G4RunID: "44444444-4444-4444-8444-444444444444",
	}
	if err := validateCampaignRequest(request); err != nil {
		t.Fatalf("validate stored campaign request: %v", err)
	}
	subject := digestBytes([]byte("stored-campaign-candidate"))
	evidence := map[string]campaignRunEvidence{
		"g2:evidence": campaignV2SingleRunEvidence(
			request.ChangeProfile, "G2", request.GateBindings.G2RunID, subject,
		),
		"g4:evidence": campaignV2SingleRunEvidence(
			request.ChangeProfile, "G4", request.GateBindings.G4RunID, subject,
		),
	}
	if err := validateCampaignEvidenceSet(request.ChangeProfile, request.GateBindings, evidence); err != nil {
		t.Fatalf("validate stored campaign evidence: %v", err)
	}
	now := time.Date(2026, time.August, 31, 8, 0, 0, 0, time.UTC)
	campaign := Campaign{
		SchemaVersion: SchemaVersion, ContractVersion: CampaignContractVersion,
		ID: request.ClientRequestID, Name: request.Name, Description: request.Description,
		ChangeProfile: request.ChangeProfile, Status: CampaignStatusDecided,
		GateBindings: request.GateBindings, CreatedAt: now,
	}
	var err error
	campaign.ManifestDigest, err = campaignManifestDigest(campaign)
	if err != nil {
		t.Fatalf("digest stored campaign: %v", err)
	}
	campaign.Decision, err = buildCampaignDecision(campaign, evidence, now)
	if err != nil {
		t.Fatalf("build stored campaign decision: %v", err)
	}
	return campaign
}

func TestCampaignV2StoredDecisionValidatesTypedAnchorAndDigest(t *testing.T) {
	campaign := campaignV2StoredSchemaFixture(t)
	if err := validateStoredCampaign(campaign.ID, campaign); err != nil {
		t.Fatalf("valid stored campaign rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Campaign)
		want   string
	}{
		{
			name: "slot role substitution",
			mutate: func(value *Campaign) {
				value.Decision.Evidence[0].BindingRole = "candidate"
			},
			want: "evidence anchor",
		},
		{
			name: "candidate subject removal",
			mutate: func(value *Campaign) {
				value.Decision.Evidence[0].CandidateSubjectDigest = ""
			},
			want: "evidence anchor",
		},
		{
			name: "candidate subject drift",
			mutate: func(value *Campaign) {
				value.Decision.Evidence[1].CandidateSubjectDigest = digestBytes([]byte("different-subject"))
			},
			want: "one exact subject",
		},
		{
			name: "gate source substitution",
			mutate: func(value *Campaign) {
				value.Decision.Gates[4].Source = "server_anchors"
			},
			want: "source ownership",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := campaign
			candidate.Decision.Gates = append([]CampaignGate(nil), campaign.Decision.Gates...)
			candidate.Decision.Evidence = append([]CampaignEvidenceAnchor(nil), campaign.Decision.Evidence...)
			test.mutate(&candidate)
			var err error
			candidate.Decision.DecisionDigest, err = campaignDecisionDigest(candidate.Decision)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateStoredCampaign(candidate.ID, candidate); err == nil ||
				!strings.Contains(err.Error(), test.want) {
				t.Fatalf("tampered campaign error=%v", err)
			}
		})
	}
}

func TestCampaignV2RestartRejectsLegacyContractAndTamperedAnchor(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Campaign)
		want   string
	}{
		{
			name: "legacy v1 contract",
			mutate: func(value *Campaign) {
				value.ContractVersion = "evaluation-campaign.v1"
			},
			want: "identity is invalid",
		},
		{
			name: "tampered typed anchor",
			mutate: func(value *Campaign) {
				value.Decision.Evidence[0].SlotID = "g9"
				value.Decision.DecisionDigest, _ = campaignDecisionDigest(value.Decision)
			},
			want: "evidence anchor",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newPrivateTestStore(t)
			campaign := campaignV2StoredSchemaFixture(t)
			campaign.Decision.Evidence = append([]CampaignEvidenceAnchor(nil), campaign.Decision.Evidence...)
			test.mutate(&campaign)
			directory := filepath.Join(store.root, "campaigns", campaign.ID)
			if err := os.Mkdir(directory, 0o700); err != nil {
				t.Fatalf("create campaign fixture directory: %v", err)
			}
			if err := writeJSONAtomic(filepath.Join(directory, campaignFileName), campaign); err != nil {
				t.Fatalf("write campaign fixture: %v", err)
			}
			if _, err := NewStore(store.root); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("restart accepted invalid campaign: %v", err)
			}
		})
	}
}

func TestCampaignV2TypedBindingsProtectEveryReferencedRun(t *testing.T) {
	store := newPrivateTestStore(t)
	campaign := campaignV2StoredSchemaFixture(t)
	directory := filepath.Join(store.root, "campaigns", campaign.ID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(directory, campaignFileName), campaign); err != nil {
		t.Fatal(err)
	}
	for _, runID := range []string{campaign.GateBindings.G2RunID, campaign.GateBindings.G4RunID} {
		if err := store.ensureRunNotCampaignReferencedUnlocked(runID); err == nil ||
			!strings.Contains(err.Error(), campaign.ID) {
			t.Fatalf("referenced run %s deletion error=%v", runID, err)
		}
	}
	if err := store.ensureRunNotCampaignReferencedUnlocked("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"); err != nil {
		t.Fatalf("unreferenced run was blocked: %v", err)
	}
}
