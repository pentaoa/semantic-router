package evaluationplane

import (
	"strings"
	"testing"
)

func TestMixtureContractRequiresAtLeastTwoFrozenArms(t *testing.T) {
	mixture := brokerTestMixture()
	mixture.ModelArms = mixture.ModelArms[:1]
	mixture.PoolDigest = modelPoolSnapshotDigest(mixture.ModelArms)
	mixture.Decisions[0].ArmIDs = []string{mixture.ModelArms[0].ID}

	if err := validateManifestMixtureContract(mixture); err == nil || !strings.Contains(err.Error(), "at least two") {
		t.Fatalf("single-arm Mixture contract error = %v, want at-least-two rejection", err)
	}
}

func TestCampaignSuiteEligibilityRequiresExactCohortContract(t *testing.T) {
	registry, err := NewRegistry("", "")
	if err != nil {
		t.Fatal(err)
	}
	want := builtinSuites()[1]
	tests := map[string]func(*CatalogSuite){
		"executor":   func(suite *CatalogSuite) { suite.Executors[ModeReplay] = fixtureReplayExecutorID },
		"evidence":   func(suite *CatalogSuite) { suite.EvidenceLevel = "E1" },
		"case count": func(suite *CatalogSuite) { suite.CaseCount = 63 },
		"minimum":    func(suite *CatalogSuite) { suite.CampaignMinimumCases = 58 },
		"tracks":     func(suite *CatalogSuite) { suite.TrackIDs = []TrackID{"routing", "model_pool"} },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			suite := copyCatalogSuite(want)
			suite.ID = "campaign-test-" + strings.ReplaceAll(name, " ", "-")
			mutate(&suite)
			if registerErr := registry.registerSuite(suite); registerErr == nil {
				t.Fatalf("invalid campaign suite was registered: %+v", suite)
			}
		})
	}
}
