package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
)

func (s *Service) validatePublicArtifacts(
	runID string,
	manifest RunManifest,
	report Report,
	privateChecksums map[string]string,
	records recordAttestation,
) error {
	runDir, err := s.store.checkedRunDir(runID)
	if err != nil {
		return err
	}
	artifacts := reportArtifacts(report)
	if len(artifacts) == 0 {
		return fmt.Errorf("%w: report has no public evidence artifacts", ErrInvalid)
	}
	seenIDs := make(map[string]bool, len(artifacts))
	seenNames := make(map[string]bool, len(artifacts))
	for _, artifact := range artifacts {
		contract, known := publicArtifactContracts[artifact.Name]
		if strings.TrimSpace(artifact.ID) == "" || seenIDs[artifact.ID] || seenNames[artifact.Name] ||
			artifact.Name != artifact.URI || filepath.Base(artifact.Name) != artifact.Name ||
			!known || artifact.Kind != contract.Kind || artifact.MediaType != contract.MediaType ||
			!digestPattern.MatchString(artifact.Digest) || artifact.SizeBytes < 0 {
			return fmt.Errorf("%w: report contains invalid or duplicate public artifact metadata", ErrInvalid)
		}
		seenIDs[artifact.ID], seenNames[artifact.Name] = true, true
		if privateChecksums[artifact.Name] != strings.TrimPrefix(artifact.Digest, "sha256:") {
			return fmt.Errorf("%w: public artifact is not anchored by the private receipt", ErrInvalid)
		}
		opened, err := s.store.OpenArtifact(runID, artifact.Name)
		if err != nil {
			return err
		}
		verifyErr := verifyOpenedArtifact(opened, artifact)
		if verifyErr == nil {
			verifyErr = s.rejectConfiguredSecretArtifact(opened.File, contract.MediaType)
		}
		closeErr := opened.File.Close()
		if verifyErr != nil {
			return verifyErr
		}
		if closeErr != nil {
			return fmt.Errorf("close verified public artifact: %w", closeErr)
		}
	}
	if _, present := seenNames["routing-traces.jsonl"]; present {
		if manifest.Mode != ModeLive || !containsTrack(manifest.TrackIDs, "routing") {
			return fmt.Errorf("%w: routing traces are valid only for a live routing run", ErrInvalid)
		}
		if err := validateRoutingTraceArtifact(runDir, records.CaseIDs); err != nil {
			return err
		}
	}
	receipt, ok := findArtifactByName(report, publicChecksumArtifactName)
	if !ok {
		return fmt.Errorf("%w: public artifact checksum receipt is unavailable", ErrInvalid)
	}
	return s.verifyPublicChecksum(runID, report, receipt)
}

func validateReportProvenance(
	runDir string,
	manifest RunManifest,
	report Report,
	checksums map[string]string,
	executionContract resolvedExecutionContract,
) error {
	var persisted Provenance
	if err := decodeStrictEvidence(filepath.Join(runDir, "provenance.json"), &persisted); err != nil {
		return err
	}
	if !reflect.DeepEqual(persisted, report.Provenance) {
		return fmt.Errorf("%w: report provenance does not match provenance.json", ErrInvalid)
	}
	lineageBytes, err := readEvidenceBytes(filepath.Join(runDir, "lineage.json"), maxStructuredArtifactBytes)
	if err != nil {
		return fmt.Errorf("read lineage evidence: %w", err)
	}
	document, err := decodeLineageDocument(lineageBytes)
	if err != nil {
		return err
	}
	resolved := document.Resolved
	if bindingErr := validateLineageBindings(runDir, manifest, document, checksums, executionContract); bindingErr != nil {
		return bindingErr
	}
	for _, field := range []string{"workload", "policy", "binding", "pool", "arms", "environment"} {
		if len(resolved[field]) == 0 {
			return fmt.Errorf("%w: lineage omits %s snapshot", ErrInvalid, field)
		}
	}
	for _, item := range []struct {
		field    string
		expected string
	}{
		{field: "workload", expected: report.Provenance.WorkloadSnapshotDigest},
		{field: "environment", expected: report.Provenance.EnvironmentSnapshotDigest},
	} {
		field, expected := item.field, item.expected
		digest, digestErr := canonicalJSONDigest(resolved[field])
		if digestErr != nil || digest != expected {
			return fmt.Errorf("%w: %s provenance digest does not match lineage", ErrInvalid, field)
		}
	}
	if executionContract.Executor.LineageProfile == lineageRuntime {
		mixture := manifest.Target.Mixture
		if mixture == nil || report.Provenance.PolicySnapshotDigest != mixture.RecipeDigest ||
			report.Provenance.BindingSnapshotDigest != mixture.BindingDigest ||
			report.Provenance.PoolSnapshotDigest != mixture.PoolDigest {
			return fmt.Errorf("%w: provenance does not match the server-frozen Mixture factors", ErrInvalid)
		}
	} else {
		for _, item := range []struct {
			field    string
			expected string
		}{
			{field: "policy", expected: report.Provenance.PolicySnapshotDigest},
			{field: "binding", expected: report.Provenance.BindingSnapshotDigest},
		} {
			digest, digestErr := canonicalJSONDigest(resolved[item.field])
			if digestErr != nil || digest != item.expected {
				return fmt.Errorf("%w: %s provenance digest does not match lineage", ErrInvalid, item.field)
			}
		}
		pool, err := decodeJSONValue(resolved["pool"])
		if err != nil {
			return err
		}
		arms, err := decodeJSONValue(resolved["arms"])
		if err != nil {
			return err
		}
		poolDigest, err := canonicalValueDigest(map[string]any{"pool": pool, "arms": arms})
		if err != nil || poolDigest != report.Provenance.PoolSnapshotDigest {
			return fmt.Errorf("%w: pool provenance digest does not match lineage", ErrInvalid)
		}
	}
	var policy struct {
		SchemaVersion string `json:"schema_version"`
		RecipeDigest  string `json:"recipe_digest"`
	}
	if err := json.Unmarshal(resolved["policy"], &policy); err != nil ||
		policy.SchemaVersion != SchemaVersion || policy.RecipeDigest != manifest.PolicySnapshotDigest {
		return fmt.Errorf("%w: lineage policy does not match the manifest policy snapshot", ErrInvalid)
	}
	var environment struct {
		SchemaVersion         string `json:"schema_version"`
		TargetID              string `json:"target_id"`
		BackendTopologyDigest string `json:"backend_topology_digest"`
	}
	if err := json.Unmarshal(resolved["environment"], &environment); err != nil ||
		environment.SchemaVersion != SchemaVersion || environment.TargetID != manifest.Target.ID ||
		(manifest.Mode == ModeLive && environment.BackendTopologyDigest != manifest.Target.BackendTopologyDigest) {
		return fmt.Errorf("%w: lineage environment does not match the manifest target", ErrInvalid)
	}
	return nil
}

type lineageDocument struct {
	Resolved                  map[string]json.RawMessage
	NormalizedSuiteIdentities json.RawMessage
}

func decodeLineageDocument(data []byte) (lineageDocument, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var root map[string]json.RawMessage
	if err := decoder.Decode(&root); err != nil {
		return lineageDocument{}, fmt.Errorf("decode lineage evidence: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return lineageDocument{}, err
	}
	document := lineageDocument{}
	if wrapped := root["resolved_snapshot"]; len(wrapped) > 0 {
		allowed := map[string]bool{"resolved_snapshot": true, "normalized_suite_identities": true}
		for key := range root {
			if !allowed[key] {
				return lineageDocument{}, fmt.Errorf("%w: lineage wrapper contains unknown field %s", ErrInvalid, key)
			}
		}
		document.NormalizedSuiteIdentities = root["normalized_suite_identities"]
		var resolved map[string]json.RawMessage
		if err := json.Unmarshal(wrapped, &resolved); err != nil {
			return lineageDocument{}, fmt.Errorf("decode resolved lineage snapshot: %w", err)
		}
		root = resolved
	}
	allowed := map[string]bool{
		"schema_version": true, "manifest_digest": true, "workload": true, "policy": true,
		"binding": true, "pool": true, "arms": true, "environment": true, "fixture_ref": true,
		"discovered_entrypoints": true, "executors": true,
	}
	for key := range root {
		if !allowed[key] {
			return lineageDocument{}, fmt.Errorf("%w: resolved lineage contains unknown field %s", ErrInvalid, key)
		}
	}
	var schemaVersion, manifestDigest string
	if err := json.Unmarshal(root["schema_version"], &schemaVersion); err != nil || schemaVersion != SchemaVersion ||
		json.Unmarshal(root["manifest_digest"], &manifestDigest) != nil || !digestPattern.MatchString(manifestDigest) {
		return lineageDocument{}, fmt.Errorf("%w: resolved lineage identity is invalid", ErrInvalid)
	}
	document.Resolved = root
	return document, nil
}

func (s *Service) verifyReportAnchor(runID string, report []byte, attestationRevision string) error {
	anchor, err := s.store.readReportAnchor(runID)
	if err != nil {
		return err
	}
	reportDigest, reportSize := digestAndSize(report)
	manifest, manifestBytes, err := s.readDurableManifest(runID)
	if err != nil {
		return err
	}
	manifestArtifactDigest, _ := digestAndSize(manifestBytes)
	privateReceipt, err := readEvidenceBytes(filepath.Join(s.store.runsRoot, runID, privateChecksumArtifactName), maxStructuredArtifactBytes)
	if err != nil {
		return err
	}
	privateReceiptDigest, _ := digestAndSize(privateReceipt)
	if anchor.ReportDigest != reportDigest || anchor.ReportSize != reportSize ||
		anchor.ManifestSemanticDigest != manifest.ManifestDigest ||
		anchor.ManifestArtifactDigest != manifestArtifactDigest ||
		anchor.PrivateReceiptDigest != privateReceiptDigest {
		return fmt.Errorf("%w: evaluation report no longer matches its server-owned anchor", ErrInvalid)
	}
	if manifest.Mode == ModeLive {
		attestation, attestationErr := s.store.readExecutionAttestation(runID)
		if attestationErr != nil || anchor.ExecutionAttestationDigest != attestation.Digest {
			return fmt.Errorf("%w: live execution attestation no longer matches its report anchor", ErrInvalid)
		}
	} else if anchor.ExecutionAttestationDigest != "" {
		return fmt.Errorf("%w: replay report cannot claim a live execution attestation", ErrInvalid)
	}
	if anchor.AttestationRevision != attestationRevision {
		return fmt.Errorf("%w: evaluation report attestation revision does not match its server-owned anchor", ErrInvalid)
	}
	return s.verifySealedEvidenceSnapshot(runID, anchor.EvidenceFiles, privateReceipt)
}
