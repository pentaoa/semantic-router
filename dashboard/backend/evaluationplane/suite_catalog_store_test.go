package evaluationplane

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type importedSuiteFixtureOptions struct {
	adapterID              string
	sourceRevisionOverride string
	trackIDs               []TrackID
	evidenceLevel          EvidenceLevel
	origin                 string
	parserVerified         bool
	nativeRunAttested      bool
	promotionEligible      bool
	gradingCaseOverrides   map[string]any
	visibleCaseBytes       []byte
	gradingCaseBytes       []byte
	perturbationBytes      []byte
	caseCount              int
	armIDs                 []string
}

func normalizedImportedSuiteFixtureOptions(
	t *testing.T,
	custom []importedSuiteFixtureOptions,
) importedSuiteFixtureOptions {
	t.Helper()
	options := importedSuiteFixtureOptions{
		adapterID:     "routerarena",
		trackIDs:      []TrackID{"routing"},
		evidenceLevel: "E0",
		origin:        "user_provided_import",
	}
	if len(custom) > 1 {
		t.Fatal("only one imported suite fixture options value is accepted")
	}
	if len(custom) == 1 {
		options = custom[0]
	}
	if options.evidenceLevel == "" {
		options.evidenceLevel = "E0"
	}
	if options.origin == "" {
		options.origin = "user_provided_import"
	}
	if options.armIDs == nil {
		options.armIDs = []string{}
	}
	return options
}

func importedSuiteFixtureCases(
	t *testing.T,
	options importedSuiteFixtureOptions,
) ([]byte, []byte) {
	t.Helper()
	visibleModality := "text"
	visibleContent := any("private")
	if containsTrack(options.trackIDs, "multimodal") {
		visibleModality = "image"
		visibleContent = []map[string]any{{
			"type": "image_url", "image_url": map[string]any{
				"url": "data:image/png;base64,AA==", "detail": "low",
			},
		}}
	}
	visibleCase, err := json.Marshal(map[string]any{
		"schema_version": SchemaVersion,
		"id":             "case-1",
		"track_ids":      options.trackIDs,
		"messages":       []map[string]any{{"role": "user", "content": visibleContent}},
		"modality":       visibleModality,
		"tags":           []string{},
	})
	if err != nil {
		t.Fatalf("marshal visible suite fixture: %v", err)
	}
	gradingCase := map[string]any{
		"schema_version": SchemaVersion,
		"case_id":        "case-1",
		"weight":         1.0,
	}
	for field, value := range options.gradingCaseOverrides {
		gradingCase[field] = value
	}
	gradingCaseBytes, err := json.Marshal(gradingCase)
	if err != nil {
		t.Fatalf("marshal grading suite fixture: %v", err)
	}
	return append(visibleCase, '\n'), append(gradingCaseBytes, '\n')
}

func writeImportedSuiteFixtureArtifacts(
	t *testing.T,
	root string,
	visibleCase []byte,
	gradingCase []byte,
) map[string]any {
	t.Helper()
	artifacts := map[string]any{}
	contents := map[string]struct {
		domain, mediaType string
		data              []byte
	}{
		"visible_cases":    {"visible", "application/x-ndjson", visibleCase},
		"grading_cases":    {"grading", "application/x-ndjson", gradingCase},
		"decisions":        {"grading", "application/x-ndjson", []byte("{\"schema_version\":\"evaluation-suite.v1\",\"case_id\":\"case-1\",\"selected_arm_id\":\"arm-a\",\"selection_status\":\"selected\",\"success\":true,\"fallback\":false,\"source_record_digest\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n")},
		"license_manifest": {"metadata", "application/json", []byte("{\"schema_version\":\"evaluation-suite-license.v1\",\"licenses\":[{\"id\":\"upstream\",\"name\":\"fixture\",\"redistribution\":\"metadata_only\"}]}")},
	}
	for role, content := range contents {
		digest := suiteDocumentDigest(content.data)
		path := filepath.Join(root, "objects", content.domain, "sha256", digest[len("sha256:"):])
		if err := os.WriteFile(path, content.data, 0o600); err != nil {
			t.Fatalf("write suite object: %v", err)
		}
		artifacts[role] = map[string]any{
			"schema_version": SchemaVersion, "digest": digest,
			"media_type": content.mediaType, "size_bytes": len(content.data),
		}
	}
	return artifacts
}

func writeImportedSuiteFixture(t *testing.T, root, suiteID string, custom ...importedSuiteFixtureOptions) string {
	t.Helper()
	options := normalizedImportedSuiteFixtureOptions(t, custom)
	visibleCase, gradingCaseBytes := importedSuiteFixtureCases(t, options)
	if len(options.visibleCaseBytes) != 0 {
		visibleCase = options.visibleCaseBytes
	}
	if len(options.gradingCaseBytes) != 0 {
		gradingCaseBytes = options.gradingCaseBytes
	}
	contract, knownAdapter := normalizedAdapterContracts[options.adapterID]
	if !knownAdapter {
		t.Fatalf("unknown normalized fixture adapter %q", options.adapterID)
	}
	sourceRevision := contract.sourceRevision
	if options.sourceRevisionOverride != "" {
		sourceRevision = options.sourceRevisionOverride
	}
	artifacts := writeImportedSuiteFixtureArtifacts(t, root, visibleCase, gradingCaseBytes)
	addImportedSuitePerturbation(t, root, options.perturbationBytes, artifacts)
	manifest := importedSuiteFixtureManifest(
		t, suiteID, options, contract, sourceRevision, artifacts,
	)
	return writeImportedSuiteManifest(t, root, suiteID, manifest)
}

func addImportedSuitePerturbation(
	t *testing.T,
	root string,
	content []byte,
	artifacts map[string]any,
) {
	t.Helper()
	if len(content) == 0 {
		return
	}
	digest := suiteDocumentDigest(content)
	path := filepath.Join(root, "objects", "grading", "sha256", digest[len("sha256:"):])
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("write perturbation suite object: %v", err)
	}
	artifacts["perturbations"] = map[string]any{
		"schema_version": SchemaVersion, "digest": digest,
		"media_type": "application/x-ndjson", "size_bytes": len(content),
	}
}

func importedSuiteFixtureManifest(
	t *testing.T,
	suiteID string,
	options importedSuiteFixtureOptions,
	contract normalizedAdapterContract,
	sourceRevision string,
	artifacts map[string]any,
) map[string]any {
	t.Helper()
	source := map[string]any{
		"schema_version": adapterContractVersion, "adapter_id": options.adapterID,
		"expected_source_revision": sourceRevision,
		"observed_source_revision": sourceRevision,
		"source_clean":             true, "verified": true,
	}
	if contract.datasetRevision != "" {
		source["expected_dataset_revision"] = contract.datasetRevision
		source["observed_dataset_revision"] = contract.datasetRevision
		source["dataset_clean"] = true
	}
	manifest := map[string]any{
		"schema_version": normalizedSuiteSchemaVersion,
		"id":             suiteID, "name": "Imported normalized suite fixture", "adapter_id": options.adapterID,
		"adapter_contract_version": adapterContractVersion, "source_receipt": source,
		"decision_unit": contract.decisionUnit, "action_space": contract.actionSpace, "track_ids": options.trackIDs,
		"split_protocol": "fixed test split", "case_count": fixtureCaseCount(options), "arm_ids": options.armIDs,
		"data_classification": "restricted", "redistribution": "metadata_only",
		"artifacts": artifacts, "limitations": []string{"test only"},
	}
	subjectDigest, subjectDigestErr := canonicalValueDigest(manifest)
	if subjectDigestErr != nil {
		t.Fatalf("subject digest: %v", subjectDigestErr)
	}
	sourceDigest, _ := canonicalValueDigest(source)
	artifactDigest, _ := canonicalValueDigest(artifacts)
	qualification := map[string]any{
		"schema_version":            suiteQualificationContractVersion,
		"status":                    "exploratory_import",
		"origin":                    options.origin,
		"parser_verified":           options.parserVerified,
		"native_execution_attested": options.nativeRunAttested,
		"promotion_eligible":        options.promotionEligible,
	}
	manifest["qualification_receipt"] = map[string]any{
		"schema_version": suiteQualificationContractVersion, "evidence_level": options.evidenceLevel,
		"manifest_subject_digest": subjectDigest, "source_receipt_digest": sourceDigest,
		"artifact_set_digest": artifactDigest, "executor_id": normalizedSuiteExecutorID,
		"executor_digest": normalizedSuiteExecutorDigest,
		"qualification":   qualification,
	}
	return manifest
}

func writeImportedSuiteManifest(
	t *testing.T,
	root string,
	suiteID string,
	manifest map[string]any,
) string {
	t.Helper()
	revision, revisionErr := canonicalValueDigest(manifest)
	if revisionErr != nil {
		t.Fatalf("suite revision: %v", revisionErr)
	}
	manifest["revision"] = revision
	manifestBytes, manifestJSONErr := canonicalJSON(manifest)
	if manifestJSONErr != nil {
		t.Fatalf("manifest JSON: %v", manifestJSONErr)
	}
	var roundTripped map[string]any
	if unmarshalErr := json.Unmarshal(manifestBytes, &roundTripped); unmarshalErr != nil {
		t.Fatalf("round trip suite manifest: %v", unmarshalErr)
	}
	delete(roundTripped, "revision")
	roundTrippedRevision, roundTripErr := canonicalValueDigest(roundTripped)
	if roundTripErr != nil || roundTrippedRevision != revision {
		t.Fatalf("fixture revision drift: initial=%s round-trip=%s error=%v", revision, roundTrippedRevision, roundTripErr)
	}
	manifestDigest := suiteDocumentDigest(manifestBytes)
	manifestPath := filepath.Join(root, "manifests", "sha256", manifestDigest[len("sha256:"):])
	if writeErr := os.WriteFile(manifestPath, manifestBytes, 0o600); writeErr != nil {
		t.Fatalf("write suite manifest: %v", writeErr)
	}
	indexBytes, indexJSONErr := canonicalJSON(suiteIndexRecord{
		ID: suiteID, Revision: revision, ManifestDigest: manifestDigest, ManifestSizeBytes: int64(len(manifestBytes)),
	})
	if indexJSONErr != nil {
		t.Fatalf("index JSON: %v", indexJSONErr)
	}
	if writeErr := os.WriteFile(filepath.Join(root, "index", suiteID+".json"), indexBytes, 0o600); writeErr != nil {
		t.Fatalf("write suite index: %v", writeErr)
	}
	return revision
}

func fixtureCaseCount(options importedSuiteFixtureOptions) int {
	if options.caseCount > 0 {
		return options.caseCount
	}
	return 1
}

func declaredShiftCatalogFixtureOptions(t *testing.T, parserVerified bool, sourceCaseID string) importedSuiteFixtureOptions {
	t.Helper()
	visible := testJSONLines(t,
		map[string]any{
			"schema_version": SchemaVersion, "id": "source", "track_ids": []TrackID{"routing"},
			"messages": []map[string]any{{"role": "user", "content": "source"}}, "modality": "text", "tags": []string{},
		},
		map[string]any{
			"schema_version": SchemaVersion, "id": "perturbed", "track_ids": []TrackID{"routing"},
			"messages": []map[string]any{{"role": "user", "content": "perturbed"}}, "modality": "text", "tags": []string{},
		},
	)
	grading := testJSONLines(t,
		map[string]any{"schema_version": SchemaVersion, "case_id": "source", "weight": 1.0},
		map[string]any{"schema_version": SchemaVersion, "case_id": "perturbed", "weight": 1.0},
	)
	perturbations := testJSONLines(t, map[string]any{
		"schema_version": normalizedSuiteSchemaVersion, "pair_id": "pair-1",
		"source_case_id": sourceCaseID, "perturbed_case_id": "perturbed", "relation": "invariant",
		"slice_ids": []string{"declared:paraphrase"}, "native_pair_count": 1,
		"source_record_digest": digestString("declared-shift-catalog-source"),
	})
	origin := "user_provided_import"
	if parserVerified {
		origin = "registered_parser_import"
	}
	return importedSuiteFixtureOptions{
		adapterID: "routerarena", trackIDs: []TrackID{"routing"}, origin: origin,
		parserVerified: parserVerified, visibleCaseBytes: visible, gradingCaseBytes: grading,
		perturbationBytes: perturbations, caseCount: 2,
	}
}

func TestInstalledCatalogExposesOnlyQualifiedLiveDeclaredShiftMethod(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	writeImportedSuiteFixture(
		t, service.suiteStorePath, "qualified-declared-shift",
		declaredShiftCatalogFixtureOptions(t, true, "source"),
	)
	writeImportedSuiteFixture(
		t, service.suiteStorePath, "unverified-declared-shift",
		declaredShiftCatalogFixtureOptions(t, false, "source"),
	)

	catalog, err := service.Catalog()
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	methodsBySuite := make(map[string]map[string]CatalogMethod)
	for _, suite := range catalog.Suites {
		methods := make(map[string]CatalogMethod, len(suite.Methods))
		for _, method := range suite.Methods {
			methods[method.ID] = method
		}
		methodsBySuite[suite.ID] = methods
	}
	qualified := methodsBySuite["qualified-declared-shift"][declaredShiftLiveMethodID]
	if qualified.ID != declaredShiftLiveMethodID || qualified.TrackID != "routing" ||
		qualified.EvidenceSource != "server_brokered_live" || qualified.Status != "configured" ||
		len(qualified.QualifiedGateIDs) != 1 || qualified.QualifiedGateIDs[0] != "G4" {
		t.Fatalf("qualified declared-shift method is not exact: %+v", qualified)
	}
	if _, present := methodsBySuite["unverified-declared-shift"][declaredShiftLiveMethodID]; present {
		t.Fatal("an unverified normalized import advertised the server-live declared-shift method")
	}
	for _, suiteID := range []string{"qualified-declared-shift", "unverified-declared-shift"} {
		method := methodsBySuite[suiteID]["routerarena.predictions-and-robustness.v2.routing"]
		if method.EvidenceSource != "normalized_import" || len(method.QualifiedGateIDs) != 0 {
			t.Fatalf("suite %q promoted its normalized import method: %+v", suiteID, method)
		}
	}
}

func TestInstalledCatalogRejectsQualifiedDeclaredShiftWithUnknownPairCase(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	writeImportedSuiteFixture(
		t, service.suiteStorePath, "invalid-declared-shift",
		declaredShiftCatalogFixtureOptions(t, true, "missing-source"),
	)
	if _, err := service.Catalog(); err == nil {
		t.Fatal("a parser-qualified declared-shift artifact referencing an unknown case was accepted")
	}
}

func TestInstalledSuiteCatalogAndCreateFreezeSameExecutor(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	if err := os.WriteFile(service.configPath, []byte(modelArmTestYAML), 0o600); err != nil {
		t.Fatalf("write Mixture-of-Models config: %v", err)
	}
	revision := writeImportedSuiteFixture(t, service.suiteStorePath, "imported.routing")

	catalog, err := service.Catalog()
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	var installed *CatalogSuite
	for index := range catalog.Suites {
		if catalog.Suites[index].ID == "imported.routing" {
			installed = &catalog.Suites[index]
			break
		}
	}
	if installed == nil || installed.Executors[ModeReplay] != normalizedSuiteExecutorID ||
		installed.Executors[ModeLive] != normalizedSuiteLiveExecutorID ||
		installed.Revision != revision || installed.EvidenceLevel != "E0" {
		t.Fatalf("installed suite is not executable catalog evidence: %+v", installed)
	}

	request := validCreateRequest()
	request.SuiteIDs = []string{"imported.routing"}
	request.TrackIDs = []TrackID{"routing"}
	request.TargetID = "benchmark-source"
	request.SampleLimit = 1
	run, err := service.CreateRun(context.Background(), request)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	manifest, _, err := service.readDurableManifest(run.ID)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if manifest.SuiteRevisions["imported.routing"] != revision ||
		manifest.SuiteExecutors["imported.routing"] != normalizedSuiteExecutorID {
		t.Fatalf("manifest did not freeze installed suite: %+v", manifest)
	}

	liveRequest := validCreateRequest()
	liveRequest.ClientRequestID = newTestClientRequestID()
	liveRequest.Name = "imported routing target execution"
	liveRequest.SuiteIDs = []string{"imported.routing"}
	liveRequest.TrackIDs = []TrackID{"routing"}
	liveRequest.Mode = ModeLive
	liveRequest.TargetID = mixtureTargetID("default")
	liveRequest.ChangeProfile = "recipe"
	liveRequest.SampleLimit = 1
	liveRun, err := service.CreateRun(context.Background(), liveRequest)
	if err != nil {
		t.Fatalf("CreateRun live installed suite: %v", err)
	}
	liveManifest, _, err := service.readDurableManifest(liveRun.ID)
	if err != nil {
		t.Fatalf("read live manifest: %v", err)
	}
	if liveManifest.SuiteRevisions["imported.routing"] != revision ||
		liveManifest.SuiteExecutors["imported.routing"] != normalizedSuiteLiveExecutorID ||
		liveManifest.Target.ID != mixtureTargetID("default") || liveManifest.Mode != ModeLive {
		t.Fatalf("live manifest did not bind the workload to its target executor: %+v", liveManifest)
	}
	if liveManifest.CodeRevision != testSourceRevision || liveManifest.Target.Mixture == nil {
		t.Fatalf("live manifest lost evaluation source or Mixture identity: %+v", liveManifest)
	}
	for _, arm := range liveManifest.Target.Mixture.ModelArms {
		if arm.RuntimeRevision != nil {
			t.Fatalf("evaluation source revision leaked into model arm %q: %q", arm.ID, *arm.RuntimeRevision)
		}
	}

	wrongLiveTarget := liveRequest
	wrongLiveTarget.ClientRequestID = newTestClientRequestID()
	wrongLiveTarget.TargetID = "benchmark-source"
	if _, err := service.CreateRun(context.Background(), wrongLiveTarget); err == nil {
		t.Fatal("normalized target execution accepted the historical source target")
	}
	wrongReplayTarget := request
	wrongReplayTarget.ClientRequestID = newTestClientRequestID()
	wrongReplayTarget.TargetID = mixtureTargetID("default")
	if _, err := service.CreateRun(context.Background(), wrongReplayTarget); err == nil {
		t.Fatal("normalized historical replay accepted the runtime target")
	}

	mixed := validCreateRequest()
	mixed.ClientRequestID = "17d3828d-cfc0-4416-8e67-f639c1ab11b0"
	mixed.SuiteIDs = []string{"evaluation-smoke", "imported.routing"}
	if _, err := service.CreateRun(context.Background(), mixed); err == nil {
		t.Fatal("builtin and installed executor suites were mixed")
	}
}

func TestInstalledSuiteCatalogRejectsImportProvenanceTamper(t *testing.T) {
	service, _ := newTestService(t, &controlledProcess{}, 1)
	writeImportedSuiteFixture(t, service.suiteStorePath, "tampered-routing")
	indexPath := filepath.Join(service.suiteStorePath, "index", "tampered-routing.json")
	indexBytes, indexReadErr := os.ReadFile(indexPath)
	if indexReadErr != nil {
		t.Fatal(indexReadErr)
	}
	var index suiteIndexRecord
	if unmarshalErr := json.Unmarshal(indexBytes, &index); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	manifestPath := filepath.Join(service.suiteStorePath, "manifests", "sha256", index.ManifestDigest[len("sha256:"):])
	manifestBytes, manifestReadErr := os.ReadFile(manifestPath)
	if manifestReadErr != nil {
		t.Fatal(manifestReadErr)
	}
	manifestBytes = bytes.Replace(manifestBytes, []byte(normalizedSuiteExecutorDigest), []byte("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"), 1)
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Catalog(); err == nil {
		t.Fatal("tampered qualification receipt was accepted")
	}
}
