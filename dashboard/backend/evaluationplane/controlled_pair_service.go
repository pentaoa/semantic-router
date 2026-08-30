package evaluationplane

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"
)

type CreateControlledPairRequest struct {
	ClientRequestID      string `json:"client_request_id"`
	BaselineSourceRunID  string `json:"baseline_source_run_id"`
	CandidateSourceRunID string `json:"candidate_source_run_id"`
	BaselineRunID        string `json:"baseline_run_id"`
	CandidateRunID       string `json:"candidate_run_id"`
}

type ControlledPairExecution struct {
	SchemaVersion        string `json:"schema_version"`
	ContractVersion      string `json:"contract_version"`
	ID                   string `json:"id"`
	Protocol             string `json:"protocol"`
	BaselineSourceRunID  string `json:"baseline_source_run_id"`
	CandidateSourceRunID string `json:"candidate_source_run_id"`
	BaselineRun          Run    `json:"baseline_run"`
	CandidateRun         Run    `json:"candidate_run"`
}

type controlledPairSource struct {
	run      Run
	manifest RunManifest
	report   Report
}

// CreateControlledPairExecution clones two completed server-owned live target
// snapshots into fresh workers and starts them behind one AB/BA coordinator.
// The request contains only durable run identities; endpoint origins and
// credentials always come from the sealed source manifests.
func (s *Service) CreateControlledPairExecution(
	ctx context.Context,
	request CreateControlledPairRequest,
) (ControlledPairExecution, error) {
	return s.CreateControlledPairExecutionAs(ctx, SystemActor(), request)
}

func (s *Service) CreateControlledPairExecutionAs(
	_ context.Context,
	actor Actor,
	request CreateControlledPairRequest,
) (ControlledPairExecution, error) {
	if err := validateActor(actor); err != nil {
		return ControlledPairExecution{}, err
	}
	if err := validateControlledPairRequest(request); err != nil {
		return ControlledPairExecution{}, err
	}
	release, acquireErr := s.acquireEvidenceRead()
	if acquireErr != nil {
		return ControlledPairExecution{}, acquireErr
	}
	defer release()
	if ledgerErr := s.RequireCompleteRunLedger(); ledgerErr != nil {
		return ControlledPairExecution{}, ledgerErr
	}
	baseline, baselineSourceErr := s.loadControlledPairSource(request.BaselineSourceRunID)
	if baselineSourceErr != nil {
		return ControlledPairExecution{}, fmt.Errorf("baseline controlled-pair source: %w", baselineSourceErr)
	}
	candidate, candidateSourceErr := s.loadControlledPairSource(request.CandidateSourceRunID)
	if candidateSourceErr != nil {
		return ControlledPairExecution{}, fmt.Errorf("candidate controlled-pair source: %w", candidateSourceErr)
	}
	if err := s.validateControlledPairSources(baseline, candidate); err != nil {
		return ControlledPairExecution{}, err
	}
	freezer, ok := s.process.(controlledPairCredentialFreezer)
	if !ok {
		return ControlledPairExecution{}, fmt.Errorf(
			"%w: controlled pairing is unavailable because the process backend cannot freeze two target credentials",
			ErrConflict,
		)
	}
	baselineCredentials, baselineCredentialErr := freezer.freezeControlledPairCredentials(baseline.manifest)
	if baselineCredentialErr != nil {
		return ControlledPairExecution{}, fmt.Errorf("%w: baseline target capability is unavailable: %w", ErrConflict, baselineCredentialErr)
	}
	candidateCredentials, candidateCredentialErr := freezer.freezeControlledPairCredentials(candidate.manifest)
	if candidateCredentialErr != nil {
		return ControlledPairExecution{}, fmt.Errorf("%w: candidate target capability is unavailable: %w", ErrConflict, candidateCredentialErr)
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	baselineRun, baselineManifest, err := cloneControlledPairRun(
		baseline, request.BaselineRunID, "", controlledPairRoleBaseline, now,
	)
	if err != nil {
		return ControlledPairExecution{}, err
	}
	candidateRun, candidateManifest, err := cloneControlledPairRun(
		candidate, request.CandidateRunID, request.BaselineRunID, controlledPairRoleCandidate, now,
	)
	if err != nil {
		return ControlledPairExecution{}, err
	}
	if persistErr := s.persistControlledPairRunsAs(
		actor,
		baselineRun, baselineManifest, candidateRun, candidateManifest,
	); persistErr != nil {
		return ControlledPairExecution{}, persistErr
	}

	coordinator := newControlledPairCoordinator(
		request.ClientRequestID, candidateManifest.Seed, baselineManifest, candidateManifest,
	)
	baselineContext := &controlledPairRunContext{
		role: controlledPairRoleBaseline, coordinator: coordinator, credentials: baselineCredentials,
	}
	candidateContext := &controlledPairRunContext{
		role: controlledPairRoleCandidate, coordinator: coordinator, credentials: candidateCredentials,
	}
	baselineRun, candidateRun, err = s.startControlledPairRunsAs(
		actor,
		baselineRun.ID, candidateRun.ID, baselineContext, candidateContext,
	)
	if err != nil {
		coordinator.abort(err)
		return ControlledPairExecution{}, err
	}
	return ControlledPairExecution{
		SchemaVersion: SchemaVersion, ContractVersion: controlledPairProtocolVersion,
		ID: request.ClientRequestID, Protocol: controlledPairInterleaveABBA,
		BaselineSourceRunID:  request.BaselineSourceRunID,
		CandidateSourceRunID: request.CandidateSourceRunID,
		BaselineRun:          baselineRun, CandidateRun: candidateRun,
	}, nil
}

func validateControlledPairRequest(request CreateControlledPairRequest) error {
	ids := []string{
		request.ClientRequestID, request.BaselineSourceRunID, request.CandidateSourceRunID,
		request.BaselineRunID, request.CandidateRunID,
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !validClientRequestID(id) {
			return fmt.Errorf("%w: controlled pair identities must be canonical UUIDs", ErrInvalid)
		}
		if seen[id] {
			return fmt.Errorf("%w: controlled pair identities must be distinct", ErrInvalid)
		}
		seen[id] = true
	}
	return nil
}

func (s *Service) loadControlledPairSource(id string) (controlledPairSource, error) {
	run, err := s.store.GetRun(id)
	if err != nil {
		return controlledPairSource{}, err
	}
	if run.Status != StatusCompleted || run.Mode != ModeLive {
		return controlledPairSource{}, fmt.Errorf("%w: source must be a completed live run", ErrInvalid)
	}
	manifest, manifestBytes, err := s.readDurableManifest(id)
	if err != nil {
		return controlledPairSource{}, err
	}
	report, err := s.decodedReport(id)
	if err != nil {
		return controlledPairSource{}, err
	}
	anchor, err := s.store.readReportAnchor(id)
	manifestArtifactDigest, _ := digestAndSize(manifestBytes)
	if err != nil || anchor.ManifestSemanticDigest != manifest.ManifestDigest ||
		anchor.ManifestArtifactDigest != manifestArtifactDigest ||
		anchor.ExecutionAttestationDigest == "" {
		return controlledPairSource{}, fmt.Errorf("%w: source lacks sealed server-owned live provenance", ErrInvalid)
	}
	attestation, err := s.store.readExecutionAttestation(id)
	if err != nil || attestation.Digest != anchor.ExecutionAttestationDigest ||
		attestation.ManifestDigest != manifest.ManifestDigest {
		return controlledPairSource{}, fmt.Errorf("%w: source execution attestation is unavailable", ErrInvalid)
	}
	return controlledPairSource{run: run, manifest: manifest, report: report}, nil
}

func (s *Service) validateControlledPairSources(
	baseline controlledPairSource,
	candidate controlledPairSource,
) error {
	left, right := baseline.manifest, candidate.manifest
	if left.CodeRevision != s.codeRevision || right.CodeRevision != s.codeRevision {
		return fmt.Errorf("%w: both controlled pair sources must match the active evaluation worker revision", ErrConflict)
	}
	registry, _, err := s.registrySnapshot()
	if err != nil {
		return err
	}
	if err := validateControlledPairRegistryTargets(registry, left, right); err != nil {
		return err
	}
	if len(left.SuiteIDs) != 1 || len(right.SuiteIDs) != 1 || left.SuiteIDs[0] != right.SuiteIDs[0] {
		return fmt.Errorf("%w: controlled pair requires one exact shared campaign suite", ErrInvalid)
	}
	suite, exists := registry.suite(left.SuiteIDs[0])
	if !exists || !suite.CampaignEligible || suite.CampaignMinimumCases < 59 ||
		left.SampleLimit < suite.CampaignMinimumCases || right.SampleLimit < suite.CampaignMinimumCases {
		return fmt.Errorf("%w: controlled pair suite is not campaign eligible at the required cohort size", ErrInvalid)
	}
	if !reflect.DeepEqual(left.SuiteRevisions, right.SuiteRevisions) ||
		!reflect.DeepEqual(left.SuiteRevisions, suiteRevisionSnapshot(registry, left.SuiteIDs)) ||
		!reflect.DeepEqual(left.SuiteExecutors, right.SuiteExecutors) ||
		!reflect.DeepEqual(left.SuiteExecutors, suiteExecutorSnapshot(registry, left.SuiteIDs, ModeLive)) ||
		!reflect.DeepEqual(left.TrackIDs, right.TrackIDs) || !reflect.DeepEqual(left.TrackIDs, suite.TrackIDs) ||
		left.SampleLimit != right.SampleLimit || left.Concurrency != right.Concurrency || left.Seed != right.Seed ||
		left.ChangeProfile != right.ChangeProfile ||
		!reflect.DeepEqual(left.CapacitySLO, right.CapacitySLO) ||
		!reflect.DeepEqual(left.CapacityLoadProtocol, right.CapacityLoadProtocol) ||
		baseline.report.Provenance.WorkloadSnapshotDigest == "" ||
		baseline.report.Provenance.WorkloadSnapshotDigest != candidate.report.Provenance.WorkloadSnapshotDigest ||
		!reflect.DeepEqual(
			baseline.report.Provenance.BenchmarkRevisions,
			candidate.report.Provenance.BenchmarkRevisions,
		) {
		return fmt.Errorf("%w: controlled pair sources do not share one immutable suite revision and workload", ErrInvalid)
	}
	if left.Target.ID == right.Target.ID {
		return fmt.Errorf("%w: controlled pair requires two distinct deployment-scoped targets", ErrConflict)
	}
	if left.Target.Mixture == nil || right.Target.Mixture == nil ||
		left.Target.Mixture.ID != right.Target.Mixture.ID ||
		left.Target.Mixture.RecipeName != right.Target.Mixture.RecipeName {
		return fmt.Errorf("%w: controlled pair sources do not identify one Mixture-of-Models subject", ErrInvalid)
	}
	if err := validateControlledPairAddressability(left, right); err != nil {
		return err
	}
	return validateControlledPairTreatment(baseline.report, candidate.report, left, right)
}

func validateControlledPairAddressability(baseline, candidate RunManifest) error {
	for _, trackID := range baseline.TrackIDs {
		if !campaignTrackHasExecutionContract(trackID) {
			return fmt.Errorf("%w: controlled pair track %q has no paired broker protocol", ErrInvalid, trackID)
		}
	}
	if containsTrack(baseline.TrackIDs, "routing") &&
		(baseline.Target.RouterAPIURL == "" || candidate.Target.RouterAPIURL == "" ||
			baseline.Target.RouterAPIURL == candidate.Target.RouterAPIURL) {
		return fmt.Errorf(
			"%w: routing variants are not simultaneously addressable at distinct server-owned Router origins",
			ErrConflict,
		)
	}
	for _, trackID := range baseline.TrackIDs {
		if trackID == "model_pool" || trackID == "joint" || trackID == "multimodal" || trackID == "capacity" {
			if baseline.Target.EnvoyURL == "" || candidate.Target.EnvoyURL == "" ||
				baseline.Target.EnvoyURL == candidate.Target.EnvoyURL {
				return fmt.Errorf(
					"%w: live variants are not simultaneously addressable at distinct server-owned Envoy origins",
					ErrConflict,
				)
			}
			break
		}
	}
	return nil
}

func validateControlledPairTreatment(
	baseline Report,
	candidate Report,
	baselineManifest RunManifest,
	candidateManifest RunManifest,
) error {
	if baseline.Run.ChangeProfile == "schema_adapter" {
		return fmt.Errorf(
			"%w: schema_adapter pairing requires two simultaneously installed worker revisions and is unavailable",
			ErrConflict,
		)
	}
	// Distinct origins are capability locators required to address both versions
	// at once, not a treatment. Normalize only that derived report factor; exact
	// topology and every policy/pool/binding factor remain independently checked.
	if baseline.Run.ChangeProfile != "runtime_capacity" && baseline.Run.ChangeProfile != "model_pool" {
		candidate.Provenance.EnvironmentSnapshotDigest = baseline.Provenance.EnvironmentSnapshotDigest
	}
	if err := validateTreatmentFactors(baseline, candidate); err != nil {
		return fmt.Errorf("%w: controlled pair treatment: %w", ErrInvalid, err)
	}
	allowed := comparisonTreatment(baseline.Run.ChangeProfile)
	if !allowed.environment && baselineManifest.Target.BackendTopologyDigest != candidateManifest.Target.BackendTopologyDigest {
		return fmt.Errorf("%w: controlled pair backend topology changed outside the declared treatment", ErrInvalid)
	}
	if baseline.Run.ChangeProfile == "runtime_capacity" &&
		baselineManifest.Target.BackendTopologyDigest == candidateManifest.Target.BackendTopologyDigest {
		return fmt.Errorf("%w: runtime_capacity requires the server-owned topology factor to change", ErrInvalid)
	}
	return nil
}

func cloneControlledPairRun(
	source controlledPairSource,
	runID, baselineRunID, role string,
	createdAt time.Time,
) (Run, RunManifest, error) {
	run := source.run
	run.ID, run.ClientRequestID = runID, runID
	run.Name = "Controlled pair " + role
	run.Description = "Server-owned " + controlledPairInterleaveABBA + " execution"
	run.Status, run.BaselineRunID = StatusPending, baselineRunID
	run.Progress = RunProgress{Total: len(run.TrackIDs), Message: "Run created"}
	run.CreatedAt, run.StartedAt, run.CompletedAt, run.Error = createdAt, nil, nil, ""

	manifest := source.manifest
	manifest.RunID, manifest.Name, manifest.Description = runID, run.Name, run.Description
	manifest.BaselineRunID, manifest.CreatedAt = baselineRunID, createdAt
	manifest.ManifestDigest = ""
	digest, err := manifestSemanticDigest(manifest)
	if err != nil {
		return Run{}, RunManifest{}, fmt.Errorf("%w: seal controlled pair manifest: %w", ErrInvalid, err)
	}
	manifest.ManifestDigest = digest
	return run, manifest, nil
}

func (s *Service) persistControlledPairRunsAs(
	actor Actor,
	baselineRun Run,
	baselineManifest RunManifest,
	candidateRun Run,
	candidateManifest RunManifest,
) error {
	if _, err := s.store.GetRun(baselineRun.ID); err == nil {
		return fmt.Errorf("%w: controlled pair baseline run already exists", ErrConflict)
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	if _, err := s.store.GetRun(candidateRun.ID); err == nil {
		return fmt.Errorf("%w: controlled pair candidate run already exists", ErrConflict)
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	if _, err := s.store.CreateBundleAs(actor, baselineRun, baselineManifest); err != nil {
		return err
	}
	if _, err := s.store.CreateBundleAs(actor, candidateRun, candidateManifest); err != nil {
		if rollbackErr := s.store.DeleteRunAs(actor, baselineRun.ID); rollbackErr != nil {
			return errors.Join(err, fmt.Errorf("roll back controlled pair baseline: %w", rollbackErr))
		}
		return err
	}
	return nil
}

func (s *Service) startControlledPairRunsAs(
	actor Actor,
	baselineID, candidateID string,
	baselineContext, candidateContext *controlledPairRunContext,
) (Run, Run, error) {
	s.store.lifecycle.mu.Lock()
	defer s.store.lifecycle.mu.Unlock()
	if err := s.store.authorizeRunActionUnlocked(actor, baselineID, "start"); err != nil {
		return Run{}, Run{}, err
	}
	if err := s.store.authorizeRunActionUnlocked(actor, candidateID, "start"); err != nil {
		return Run{}, Run{}, err
	}
	return s.startControlledPairRunsInternal(
		baselineID, candidateID, baselineContext, candidateContext,
	)
}

func (s *Service) startControlledPairRunsInternal(
	baselineID, candidateID string,
	baselineContext, candidateContext *controlledPairRunContext,
) (Run, Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Run{}, Run{}, fmt.Errorf("%w: evaluation service is closed", ErrConflict)
	}
	baseline, baselineErr := s.store.GetRun(baselineID)
	if baselineErr != nil {
		return Run{}, Run{}, baselineErr
	}
	candidate, candidateErr := s.store.GetRun(candidateID)
	if candidateErr != nil {
		return Run{}, Run{}, candidateErr
	}
	if baseline.Status != StatusPending || candidate.Status != StatusPending || candidate.BaselineRunID != baseline.ID {
		return Run{}, Run{}, fmt.Errorf("%w: controlled pair runs are not one fresh pending pair", ErrConflict)
	}
	baselineManifest, _, baselineManifestErr := s.readDurableManifest(baseline.ID)
	if baselineManifestErr != nil {
		return Run{}, Run{}, baselineManifestErr
	}
	candidateManifest, _, candidateManifestErr := s.readDurableManifest(candidate.ID)
	if candidateManifestErr != nil {
		return Run{}, Run{}, candidateManifestErr
	}
	registry, _, registryErr := s.registrySnapshot()
	if registryErr != nil {
		return Run{}, Run{}, registryErr
	}
	if err := validateControlledPairRegistryTargets(registry, baselineManifest, candidateManifest); err != nil {
		return Run{}, Run{}, err
	}
	baselinePath, err := s.store.ManifestPath(baseline.ID)
	if err != nil {
		return Run{}, Run{}, err
	}
	candidatePath, err := s.store.ManifestPath(candidate.ID)
	if err != nil {
		return Run{}, Run{}, err
	}
	select {
	case s.semaphore <- struct{}{}:
	default:
		return Run{}, Run{}, fmt.Errorf("%w: two evaluation worker slots are required for controlled pairing", ErrConflict)
	}
	select {
	case s.semaphore <- struct{}{}:
	default:
		<-s.semaphore
		return Run{}, Run{}, fmt.Errorf("%w: two evaluation worker slots are required for controlled pairing", ErrConflict)
	}

	now := time.Now().UTC()
	pendingBaseline, pendingCandidate := baseline, candidate
	baseline.Status, candidate.Status = StatusRunning, StatusRunning
	baseline.StartedAt, candidate.StartedAt = &now, &now
	baseline.Progress.Message, candidate.Progress.Message = "Controlled pair worker starting", "Controlled pair worker starting"
	if err := s.store.UpdateRun(baseline); err != nil {
		<-s.semaphore
		<-s.semaphore
		return Run{}, Run{}, err
	}
	if err := s.store.UpdateRun(candidate); err != nil {
		<-s.semaphore
		<-s.semaphore
		if rollbackErr := s.store.UpdateRun(pendingBaseline); rollbackErr != nil {
			return Run{}, Run{}, errors.Join(err, fmt.Errorf("restore controlled pair baseline: %w", rollbackErr))
		}
		return Run{}, Run{}, err
	}
	for _, run := range []Run{baseline, candidate} {
		if _, err := s.appendEventLocked(Event{
			RunID: run.ID, Type: "progress", Timestamp: now,
			Message: run.Progress.Message, Progress: &run.Progress,
		}); err != nil {
			<-s.semaphore
			<-s.semaphore
			rollbackErr := errors.Join(
				s.store.UpdateRun(pendingBaseline),
				s.store.UpdateRun(pendingCandidate),
			)
			if rollbackErr != nil {
				return Run{}, Run{}, errors.Join(err, fmt.Errorf("restore controlled pair runs: %w", rollbackErr))
			}
			return Run{}, Run{}, err
		}
	}
	baselineWorkerContext, baselineCancel := context.WithTimeout(context.Background(), s.workerTimeout)
	candidateWorkerContext, candidateCancel := context.WithTimeout(context.Background(), s.workerTimeout)
	s.active[baseline.ID], s.active[candidate.ID] = baselineCancel, candidateCancel
	s.workerEvents[baseline.ID], s.workerEvents[candidate.ID] = 0, 0
	s.workers.Add(2)
	go s.execute(baselineWorkerContext, baseline.ID, baselinePath, baselineContext)
	go s.execute(candidateWorkerContext, candidate.ID, candidatePath, candidateContext)
	return baseline, candidate, nil
}
