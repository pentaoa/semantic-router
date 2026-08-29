package evaluationplane

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

func (s *Service) validateCreateBaseline(
	request CreateRunRequest,
	target targetDefinition,
	snapshot ModelArmSnapshot,
) error {
	if request.BaselineRunID == "" {
		return nil
	}
	baseline, err := s.store.GetRun(request.BaselineRunID)
	if err != nil {
		return fmt.Errorf("%w: baseline run is unavailable", ErrInvalid)
	}
	if baseline.Status != StatusCompleted {
		return fmt.Errorf("%w: baseline run must be completed", ErrInvalid)
	}
	if err := validateComparableRunRequest(request, baseline); err != nil {
		return err
	}
	return s.validateComparableTargetSnapshot(
		request.ChangeProfile,
		target,
		snapshot,
		baseline.ID,
	)
}

func (s *Service) newPendingRunManifest(
	registry *Registry,
	request CreateRunRequest,
	target targetDefinition,
	snapshot ModelArmSnapshot,
	evidenceLevel EvidenceLevel,
) (Run, RunManifest, error) {
	// Python datetime serialization is microsecond-precise. Freeze the shared
	// timestamp at that precision so Go/Python evidence compares byte-stably.
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := Run{
		SchemaVersion: SchemaVersion,
		ID:            uuid.NewString(), ClientRequestID: request.ClientRequestID,
		Name: request.Name, Description: request.Description,
		Status: StatusPending, Mode: request.Mode, EvidenceLevel: evidenceLevel,
		TargetID: request.TargetID, ChangeProfile: request.ChangeProfile,
		SuiteIDs: request.SuiteIDs, TrackIDs: request.TrackIDs,
		SampleLimit: request.SampleLimit, Concurrency: request.Concurrency, Seed: request.Seed,
		BaselineRunID: request.BaselineRunID,
		Progress:      RunProgress{Total: len(request.TrackIDs), Message: "Run created"},
		CreatedAt:     now,
	}
	manifest := RunManifest{
		SchemaVersion: SchemaVersion, RunID: run.ID, Mode: run.Mode,
		Target: ManifestTarget{
			SchemaVersion: SchemaVersion, ID: target.Public.ID, Kind: target.Public.Kind,
			RouterAPIURL: target.RouterAPIURL, EnvoyURL: target.EnvoyURL,
			RouterAPIKey: copySecretRef(target.RouterAPIKey), EnvoyAPIKey: copySecretRef(target.EnvoyAPIKey),
			ModelArms:             copyModelArms(target.ModelArms),
			BackendTopologyDigest: target.BackendTopologyDigest,
		},
		ChangeProfile:       run.ChangeProfile,
		GateContractVersion: GateContractVersion,
		SuiteIDs:            run.SuiteIDs, SuiteRevisions: suiteRevisionSnapshot(registry, run.SuiteIDs),
		TrackIDs: run.TrackIDs, SampleLimit: run.SampleLimit,
		Concurrency: run.Concurrency, Seed: run.Seed, BaselineRunID: run.BaselineRunID,
		CreatedAt: now, CodeRevision: s.codeRevision, ConfigDigest: snapshot.ConfigDigest,
		PolicySnapshotDigest: manifestPolicySnapshotDigest(target, snapshot),
		RedactionPolicy:      "evaluation-default-v1",
	}
	manifestDigest, err := manifestSemanticDigest(manifest)
	if err != nil {
		return Run{}, RunManifest{}, fmt.Errorf(
			"%w: compute immutable evaluation manifest identity: %w",
			ErrInvalid,
			err,
		)
	}
	manifest.ManifestDigest = manifestDigest
	return run, manifest, nil
}

func (s *Service) reserveIndexedCreate(
	request CreateRunRequest,
	run Run,
	requestDigest string,
) (*Run, error) {
	if request.ClientRequestID == "" {
		return nil, nil
	}
	indexed, created, err := s.store.ReserveClientRequestIndex(clientRequestIndexEntry{
		SchemaVersion: SchemaVersion, ClientRequestID: request.ClientRequestID,
		RunID: run.ID, RequestDigest: requestDigest,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: client_request_id index could not be reserved", ErrConflict)
	}
	if created {
		return nil, nil
	}
	existing, err := s.resolveIndexedCreate(request, requestDigest, indexed)
	if indexed.RunID != run.ID {
		if cleanupErr := s.store.DeleteRun(run.ID); cleanupErr != nil {
			return nil, fmt.Errorf(
				"%w: client_request_id loser bundle could not be removed: %w",
				ErrConflict,
				cleanupErr,
			)
		}
	}
	if err != nil {
		return nil, err
	}
	return &existing, nil
}

// persistPendingRun publishes recoverable run data before reserving its
// immutable client-request index. A bundle failure can therefore never leave a
// dangling reservation, while a crash or reservation failure after publication
// is repaired by the targeted bundle reconciliation on the next keyed retry.
func (s *Service) persistPendingRun(
	request CreateRunRequest,
	run Run,
	manifest RunManifest,
	requestDigest string,
) (Run, error) {
	if _, err := s.store.CreateBundle(run, manifest); err != nil {
		return Run{}, err
	}
	indexedRun, err := s.reserveIndexedCreate(request, run, requestDigest)
	if err != nil {
		return Run{}, err
	}
	if indexedRun != nil {
		return *indexedRun, nil
	}
	return run, nil
}
