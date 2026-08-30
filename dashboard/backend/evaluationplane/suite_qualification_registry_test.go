package evaluationplane

import "testing"

func TestNormalizedImportProvenanceMatchesPythonGolden(t *testing.T) {
	var golden struct {
		SchemaVersion           string        `json:"schema_version"`
		EvidenceLevel           EvidenceLevel `json:"evidence_level"`
		Origins                 []string      `json:"origins"`
		NativeExecutionAttested bool          `json:"native_execution_attested"`
		PromotionEligible       bool          `json:"promotion_eligible"`
		QualifiedGateIDs        []string      `json:"qualified_gate_ids"`
	}
	decodeGoldenStrict(t, "normalized-import-provenance.json", &golden)
	if golden.SchemaVersion != suiteQualificationContractVersion || golden.EvidenceLevel != "E0" ||
		golden.NativeExecutionAttested || golden.PromotionEligible || len(golden.QualifiedGateIDs) != 0 ||
		len(golden.Origins) != 2 || !validImportOrigin(golden.Origins[0], true) ||
		!validImportOrigin(golden.Origins[1], false) {
		t.Fatalf("invalid normalized import provenance golden: %+v", golden)
	}
}

func TestNormalizedAdapterRegistryPinsSourceAndWorkloadOnly(t *testing.T) {
	if len(normalizedAdapterContracts) != 11 {
		t.Fatalf("normalized adapter count=%d, want 11 executable adapters", len(normalizedAdapterContracts))
	}
	for adapterID, contract := range normalizedAdapterContracts {
		if !portableSuiteIDPattern.MatchString(adapterID) ||
			!adapterSourceRevisionPattern.MatchString(contract.sourceRevision) ||
			contract.decisionUnit == "" || contract.actionSpace == "" ||
			!canonicalTrackOrder(contract.trackIDs) {
			t.Fatalf("adapter %q has an invalid import contract: %+v", adapterID, contract)
		}
		if contract.datasetRevision != "" && !adapterSourceRevisionPattern.MatchString(contract.datasetRevision) {
			t.Fatalf("adapter %q has an invalid dataset revision", adapterID)
		}
	}
}

func TestNormalizedAdapterTrackValidationDoesNotImplyEvidenceStrength(t *testing.T) {
	contract := normalizedAdapterContracts["routerarena"]
	if !normalizedAdapterTracksMatch(contract, []TrackID{"routing"}) {
		t.Fatal("registered RouterArena routing track was rejected")
	}
	if normalizedAdapterTracksMatch(contract, []TrackID{"safety"}) {
		t.Fatal("unregistered RouterArena safety track was accepted")
	}
}
