package evaluationplane

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"
)

type reportSealPreparation struct {
	run                        Run
	report                     Report
	manifest                   RunManifest
	manifestBytes              []byte
	executionContract          resolvedExecutionContract
	executionAttestationDigest string
	checksums                  map[string]string
	sealedLevels               sealedEvidenceLevels
}

func (s *Service) validateAndAnchorReport(runID string) error {
	preparation, err := s.prepareReportSeal(runID)
	if err != nil {
		return err
	}
	return s.publishReportSeal(runID, preparation)
}

func (s *Service) prepareReportSeal(runID string) (reportSealPreparation, error) {
	run, runErr := s.store.GetRun(runID)
	if runErr != nil {
		return reportSealPreparation{}, runErr
	}
	if run.Status != StatusSealing {
		return reportSealPreparation{}, fmt.Errorf("%w: only an evaluation in the sealing phase can seal a report", ErrConflict)
	}
	data, reportReadErr := s.store.ReadReport(runID)
	if reportReadErr != nil {
		return reportSealPreparation{}, reportReadErr
	}
	if err := s.rejectConfiguredSecretBytes(data); err != nil {
		return reportSealPreparation{}, err
	}
	report, decodeErr := decodeWorkerReportStrict(runID, data)
	if decodeErr != nil {
		return reportSealPreparation{}, decodeErr
	}
	if report.Run.Status != StatusCompleted || report.Run.Error != "" {
		return reportSealPreparation{}, fmt.Errorf("%w: worker report must describe a successful completed run", ErrInvalid)
	}
	manifest, manifestBytes, err := s.readDurableManifest(runID)
	if err != nil {
		return reportSealPreparation{}, err
	}
	registry, _, err := s.registrySnapshot()
	if err != nil {
		return reportSealPreparation{}, err
	}
	executionContract, err := registry.executionContracts().resolve(manifest)
	if err != nil {
		return reportSealPreparation{}, err
	}
	if report.Run.Name != manifest.Name || report.Run.Description != manifest.Description {
		return reportSealPreparation{}, fmt.Errorf("%w: worker report metadata does not match the immutable run manifest", ErrInvalid)
	}
	executionAttestation, err := s.validatedExecutionAttestation(runID, manifest)
	if err != nil {
		return reportSealPreparation{}, err
	}
	executionAttestationDigest := ""
	if executionAttestation != nil {
		executionAttestationDigest = executionAttestation.Digest
	}
	checksums, err := s.validatePrivateReceipt(runID)
	if err != nil {
		return reportSealPreparation{}, err
	}
	sealedLevels, err := s.validateReportBundle(
		runID, manifest, report, checksums, executionContract, executionAttestation,
	)
	if err != nil {
		return reportSealPreparation{}, err
	}
	return reportSealPreparation{
		run: run, report: report, manifest: manifest, manifestBytes: manifestBytes,
		executionContract: executionContract, executionAttestationDigest: executionAttestationDigest,
		checksums: checksums, sealedLevels: sealedLevels,
	}, nil
}

func (s *Service) validatedExecutionAttestation(runID string, manifest RunManifest) (*executionAttestation, error) {
	if manifest.Mode != ModeLive {
		return nil, nil
	}
	attestation, err := s.store.readExecutionAttestation(runID)
	if err != nil || attestation.ManifestDigest != manifest.ManifestDigest ||
		attestation.TargetID != manifest.Target.ID || attestation.PolicySnapshotDigest != manifest.PolicySnapshotDigest ||
		attestation.BackendTopologyDigest != manifest.Target.BackendTopologyDigest {
		return nil, fmt.Errorf("%w: live report lacks its exact server execution attestation", ErrInvalid)
	}
	return &attestation, nil
}

func (s *Service) publishReportSeal(runID string, preparation reportSealPreparation) error {
	run := preparation.run
	report := preparation.report
	run.EvidenceLevel = preparation.sealedLevels.Run
	run.TrackEvidenceLevels = copyTrackEvidenceLevels(preparation.sealedLevels.ByTrack)
	completedAt := time.Now().UTC()
	canonicalizeReportRun(run, &report, completedAt)
	run.CompletedAt = &completedAt
	if err := validateReportFrozenFields(run, preparation.manifest, report); err != nil {
		return err
	}
	canonicalData, encodeErr := json.Marshal(report)
	if encodeErr != nil {
		return fmt.Errorf("encode canonical evaluation report: %w", encodeErr)
	}
	if err := s.rejectConfiguredSecretBytes(canonicalData); err != nil {
		return err
	}
	evidenceFiles, evidenceErr := s.buildSealedEvidenceSnapshot(runID, preparation.checksums)
	if evidenceErr != nil {
		return evidenceErr
	}
	manifestArtifactDigest, _ := digestAndSize(preparation.manifestBytes)
	privateReceipt, receiptErr := readEvidenceBytes(
		filepath.Join(s.store.runsRoot, runID, privateChecksumArtifactName),
		maxStructuredArtifactBytes,
	)
	if receiptErr != nil {
		return receiptErr
	}
	privateReceiptDigest, _ := digestAndSize(privateReceipt)
	sealedAt := time.Now().UTC()
	if err := validateReportExecutionTimestamp(run, preparation.manifest, report.Provenance.GeneratedAt, sealedAt); err != nil {
		return err
	}
	if _, err := s.store.commitSealedEvidenceLevels(runID, preparation.sealedLevels); err != nil {
		return err
	}
	// The revision is exclusively server-owned and is published only after all
	// worker bundle and canonical report validators have succeeded.
	report.AttestationRevision = ServerAttestationRevision
	if err := s.store.WriteReport(runID, report); err != nil {
		return err
	}
	data, reportReadErr := s.store.ReadReport(runID)
	if reportReadErr != nil {
		return reportReadErr
	}
	reportDigest, reportSize := digestAndSize(data)
	return s.store.writeReportAnchor(runID, reportAnchor{
		SchemaVersion: SchemaVersion, AttestationRevision: ServerAttestationRevision,
		RunID: runID, ReportDigest: reportDigest,
		ReportSize:                 reportSize,
		ManifestSemanticDigest:     preparation.manifest.ManifestDigest,
		ManifestArtifactDigest:     manifestArtifactDigest,
		PrivateReceiptDigest:       privateReceiptDigest,
		ExecutionAttestationDigest: preparation.executionAttestationDigest,
		EvidenceFiles:              evidenceFiles, CreatedAt: sealedAt,
	})
}
