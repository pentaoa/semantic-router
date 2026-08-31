package evaluationplane

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Options struct {
	DataDir                    string
	PythonPath                 string
	RouterAPIURL               string
	EnvoyURL                   string
	ConfigPath                 string
	DeploymentsDir             string
	CodeRevision               string
	RouterAPIKeyEnv            string
	EnvoyAPIKeyEnv             string
	AgentTaskLedger            *ServiceEndpoint
	FaultRecoveryLedger        *ServiceEndpoint
	HardPolicyLedger           *ServiceEndpoint
	ProductionExperimentLedger *ServiceEndpoint
	MaxConcurrent              int
	WorkerTimeout              time.Duration
	Process                    Process
	CredentialProvider         CredentialProvider
	LifecycleLimits            LifecycleLimits
}

const defaultWorkerTimeout = 6 * time.Hour

const maxWorkerEventsPerRun = 4096

const (
	maxSubscribersPerRun       = 16
	maxSubscribersGlobal       = 256
	maxConcurrentEvidenceReads = 8
)

var sourceRevisionPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$`)

type Service struct {
	store                      *Store
	suiteStorePath             string
	process                    Process
	configPath                 string
	deploymentsDir             string
	codeRevision               string
	routerAPIURL               string
	envoyURL                   string
	routerAPIKeyEnv            string
	envoyAPIKeyEnv             string
	agentTaskLedger            *ServiceEndpoint
	faultRecoveryLedger        *ServiceEndpoint
	hardPolicyLedger           *ServiceEndpoint
	productionExperimentLedger *ServiceEndpoint
	routerAuthRequired         bool
	semaphore                  chan struct{}
	evidenceReads              chan struct{}
	workerTimeout              time.Duration
	mu                         sync.Mutex
	active                     map[string]context.CancelFunc
	workerEvents               map[string]int
	subscribers                map[string]map[chan Event]struct{}
	subscriberCount            int
	workers                    sync.WaitGroup
	closeOnce                  sync.Once
	shutdown                   chan struct{}
	lifecycleErr               error
	closed                     bool
}

func NewService(options Options) (*Service, error) {
	store, err := newStoreWithLifecycleLimits(options.DataDir, options.LifecycleLimits)
	if err != nil {
		return nil, err
	}
	codeRevision := strings.TrimSpace(options.CodeRevision)
	if !sourceRevisionPattern.MatchString(codeRevision) {
		return nil, fmt.Errorf(
			"%w: evaluation source revision must be an immutable git commit or source-tree digest",
			ErrInvalid,
		)
	}
	if options.EnvoyAPIKeyEnv != "" && !secretEnvPattern.MatchString(options.EnvoyAPIKeyEnv) {
		return nil, fmt.Errorf("evaluation Envoy credential reference must be an uppercase environment variable name")
	}
	routerAuthRequired, err := resolveRouterAuthentication(options.RouterAPIKeyEnv, options.CredentialProvider)
	if err != nil {
		return nil, err
	}
	// CodeRevision identifies the evaluation implementation, not the model
	// servers behind a Mixture.  Do not publish it as every arm's runtime
	// revision: that would make a source-only change silently mutate the pool
	// treatment and make schema-adapter comparisons impossible.
	snapshot, err := LoadModelArmSnapshot(options.ConfigPath, "")
	if err != nil {
		return nil, err
	}
	installedSuites, err := loadInstalledCatalogSuites(store.SuiteRoot())
	if err != nil {
		return nil, err
	}
	deploymentTargets, err := LoadEvaluationDeploymentRegistry(options.DeploymentsDir, "")
	if err != nil {
		return nil, err
	}
	mixtures := snapshot.Mixtures
	if len(deploymentTargets) > 0 {
		mixtures = nil
	}
	_, err = NewRegistry(options.RouterAPIURL, options.EnvoyURL, RegistryOptions{
		RouterAPIKey: configuredRuntimeSecretRef(
			options.RouterAPIURL, deploymentTargets, options.RouterAPIKeyEnv, true,
		),
		EnvoyAPIKey: configuredRuntimeSecretRef(
			options.EnvoyURL, deploymentTargets, options.EnvoyAPIKeyEnv, false,
		),
		AgentTaskLedger:            copyServiceEndpoint(options.AgentTaskLedger),
		FaultRecoveryLedger:        copyServiceEndpoint(options.FaultRecoveryLedger),
		HardPolicyLedger:           copyServiceEndpoint(options.HardPolicyLedger),
		ProductionExperimentLedger: copyServiceEndpoint(options.ProductionExperimentLedger),
		Mixtures:                   mixtures,
		DeploymentTargets:          deploymentTargets,
		DefaultConfigDigest:        snapshot.ConfigDigest,
		RouterAuthRequired:         routerAuthRequired,
		InstalledSuites:            installedSuites,
	})
	if err != nil {
		return nil, err
	}
	process, err := configureServiceProcess(&options, store)
	if err != nil {
		return nil, err
	}
	service := &Service{
		store:                      store,
		suiteStorePath:             store.SuiteRoot(),
		process:                    process,
		configPath:                 options.ConfigPath,
		deploymentsDir:             strings.TrimSpace(options.DeploymentsDir),
		codeRevision:               codeRevision,
		routerAPIURL:               options.RouterAPIURL,
		envoyURL:                   options.EnvoyURL,
		routerAPIKeyEnv:            strings.TrimSpace(options.RouterAPIKeyEnv),
		envoyAPIKeyEnv:             strings.TrimSpace(options.EnvoyAPIKeyEnv),
		agentTaskLedger:            copyServiceEndpoint(options.AgentTaskLedger),
		faultRecoveryLedger:        copyServiceEndpoint(options.FaultRecoveryLedger),
		hardPolicyLedger:           copyServiceEndpoint(options.HardPolicyLedger),
		productionExperimentLedger: copyServiceEndpoint(options.ProductionExperimentLedger),
		routerAuthRequired:         routerAuthRequired,
		semaphore:                  make(chan struct{}, options.MaxConcurrent),
		evidenceReads:              make(chan struct{}, maxConcurrentEvidenceReads),
		workerTimeout:              options.WorkerTimeout,
		active:                     make(map[string]context.CancelFunc),
		workerEvents:               make(map[string]int),
		subscribers:                make(map[string]map[chan Event]struct{}),
		shutdown:                   make(chan struct{}),
	}
	if err := service.RecoverInterruptedRuns(); err != nil {
		return nil, err
	}
	return service, nil
}

func configureServiceProcess(options *Options, store *Store) (Process, error) {
	if options.MaxConcurrent <= 0 {
		options.MaxConcurrent = 2
	}
	if options.WorkerTimeout < 0 {
		return nil, fmt.Errorf("evaluation worker timeout cannot be negative")
	}
	if options.WorkerTimeout == 0 {
		options.WorkerTimeout = defaultWorkerTimeout
	}
	process := options.Process
	if process == nil {
		commandProcess := NewCommandProcess(options.PythonPath)
		commandProcess.routerAPIKeyEnv = strings.TrimSpace(options.RouterAPIKeyEnv)
		commandProcess.envoyAPIKeyEnv = strings.TrimSpace(options.EnvoyAPIKeyEnv)
		commandProcess.cpuSeconds = workerCPULimit(options.WorkerTimeout)
		commandProcess.publishEvidence = store.importWorkerEvidence
		process = commandProcess
	}
	return process, nil
}

func (s *Service) Catalog() (Catalog, error) {
	registry, _, err := s.registrySnapshot()
	if err != nil {
		return Catalog{}, err
	}
	return registry.Catalog(), nil
}

func (s *Service) CreateRun(ctx context.Context, request CreateRunRequest) (Run, error) {
	return s.CreateRunAs(ctx, SystemActor(), request)
}

func (s *Service) CreateRunAs(ctx context.Context, actor Actor, request CreateRunRequest) (Run, error) {
	if err := validateActor(actor); err != nil {
		return Run{}, err
	}
	registry, snapshot, registryErr := s.registrySnapshot()
	if registryErr != nil {
		return Run{}, registryErr
	}
	validated, target, requestErr := s.validateCreateRequest(registry, request)
	if requestErr != nil {
		return Run{}, requestErr
	}
	evidenceLevel, evidenceErr := selectedSuiteEvidenceLevel(registry, validated.SuiteIDs, validated.Mode)
	if evidenceErr != nil {
		return Run{}, evidenceErr
	}
	if qualificationErr := requireQualifiedCodeRevision(evidenceLevel, s.codeRevision); qualificationErr != nil {
		return Run{}, qualificationErr
	}
	if validated.BaselineRunID != "" {
		if ledgerErr := s.RequireCompleteRunLedger(); ledgerErr != nil {
			return Run{}, ledgerErr
		}
	}
	if existing, getErr := s.store.GetRun(validated.ClientRequestID); getErr == nil {
		if err := s.store.auditExistingCreate(actor, existing); err != nil {
			return Run{}, err
		}
		return s.resolveExistingCreate(validated, existing)
	} else if !errors.Is(getErr, ErrNotFound) {
		return Run{}, getErr
	}
	if baselineErr := s.validateCreateBaseline(validated, target, snapshot); baselineErr != nil {
		return Run{}, baselineErr
	}
	run, manifest, err := s.newPendingRunManifest(
		registry,
		validated,
		target,
		snapshot,
		evidenceLevel,
	)
	if err != nil {
		return Run{}, err
	}
	return s.persistPendingRunAs(actor, validated, run, manifest)
}

func requireQualifiedCodeRevision(_ EvidenceLevel, revision string) error {
	if !sourceRevisionPattern.MatchString(strings.TrimSpace(revision)) {
		return fmt.Errorf("%w: evaluation requires a full Git commit or sha256 source-tree revision", ErrInvalid)
	}
	return nil
}

func validateComparableRunRequest(candidate CreateRunRequest, baseline Run) error {
	if candidate.Mode != baseline.Mode || candidate.TargetID != baseline.TargetID ||
		candidate.ChangeProfile != baseline.ChangeProfile ||
		candidate.SampleLimit != baseline.SampleLimit || candidate.Concurrency != baseline.Concurrency || candidate.Seed != baseline.Seed ||
		!reflect.DeepEqual(candidate.CapacitySLO, baseline.CapacitySLO) ||
		!reflect.DeepEqual(candidate.CapacityLoadProtocol, baseline.CapacityLoadProtocol) ||
		!reflect.DeepEqual(candidate.SuiteIDs, baseline.SuiteIDs) || !reflect.DeepEqual(candidate.TrackIDs, baseline.TrackIDs) {
		return fmt.Errorf("%w: candidate change_profile, mode, target, suites, tracks, sample_limit, concurrency, capacity_slo, and seed must match the baseline", ErrInvalid)
	}
	return nil
}

func (s *Service) validateComparableTargetSnapshot(
	profile ChangeProfile,
	target targetDefinition,
	snapshot ModelArmSnapshot,
	baselineRunID string,
) error {
	baseline, _, err := s.readDurableManifest(baselineRunID)
	if err != nil {
		return fmt.Errorf("%w: baseline manifest is unavailable", ErrInvalid)
	}
	if baseline.ChangeProfile != profile {
		return fmt.Errorf("%w: baseline manifest change_profile does not match", ErrInvalid)
	}
	allowed := comparisonTreatment(profile)
	if !allowed.supported {
		return fmt.Errorf(
			"%w: change_profile %q has no independent server-owned treatment factor and cannot be paired",
			ErrInvalid, profile,
		)
	}
	codeChanged := baseline.CodeRevision != s.codeRevision
	if codeChanged && !allowed.code {
		return fmt.Errorf("%w: source code revision must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	poolChanged := !sameMixturePool(baseline.Target.Mixture, target.Mixture)
	if poolChanged && !allowed.pool {
		return fmt.Errorf("%w: model pool snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	bindingChanged := !sameMixtureBinding(baseline.Target.Mixture, target.Mixture)
	if bindingChanged && !allowed.binding {
		return fmt.Errorf("%w: candidate binding snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	selectorChanged, selectorAvailable := changedMixtureDigest(
		baseline.Target.Mixture, target.Mixture, func(mixture *ManifestMixture) string { return mixture.SelectorDigest },
	)
	if selectorChanged && !allowed.selector {
		return fmt.Errorf("%w: selector snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	adaptationChanged, adaptationAvailable := changedMixtureDigest(
		baseline.Target.Mixture, target.Mixture, func(mixture *ManifestMixture) string { return mixture.AdaptationDigest },
	)
	if adaptationChanged && !allowed.adaptation {
		return fmt.Errorf("%w: online adaptation snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	productionEnvironmentChanged := baseline.Target.RouterAPIURL != target.RouterAPIURL ||
		baseline.Target.EnvoyURL != target.EnvoyURL ||
		!reflect.DeepEqual(baseline.Target.RouterAPIKey, target.RouterAPIKey) ||
		!reflect.DeepEqual(baseline.Target.EnvoyAPIKey, target.EnvoyAPIKey) ||
		!reflect.DeepEqual(baseline.Target.AgentTaskLedger, target.AgentTaskLedger) ||
		!reflect.DeepEqual(baseline.Target.FaultRecoveryLedger, target.FaultRecoveryLedger) ||
		!reflect.DeepEqual(baseline.Target.HardPolicyLedger, target.HardPolicyLedger) ||
		!reflect.DeepEqual(baseline.Target.ProductionExperimentLedger, target.ProductionExperimentLedger)
	if profile == "model_pool" && productionEnvironmentChanged {
		return fmt.Errorf("%w: model_pool treatment must freeze runtime origins, credentials, and production ledgers", ErrInvalid)
	}
	environmentChanged := baseline.Target.BackendTopologyDigest != target.BackendTopologyDigest || productionEnvironmentChanged
	if !allowed.environment && environmentChanged {
		return fmt.Errorf("%w: runtime environment snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	candidatePolicyDigest := manifestPolicySnapshotDigest(target, snapshot, baseline.SuiteRevisions)
	if !digestPattern.MatchString(baseline.PolicySnapshotDigest) || !digestPattern.MatchString(candidatePolicyDigest) {
		return fmt.Errorf("%w: policy snapshot identity is unavailable", ErrInvalid)
	}
	policyChanged := baseline.PolicySnapshotDigest != candidatePolicyDigest
	if policyChanged && !allowed.policy {
		return fmt.Errorf("%w: policy snapshot must remain frozen for change_profile %q", ErrInvalid, profile)
	}
	primaryChanged := map[string]bool{
		"code": codeChanged, "policy": policyChanged, "selector": selectorChanged,
		"adaptation": adaptationChanged, "binding": bindingChanged,
		"pool": poolChanged, "environment": environmentChanged,
	}[allowed.primary]
	// Recorded targets do not expose a server-owned live Mixture factor graph at
	// create time. Preserve cohort/freeze checks here and require the exact
	// treatment from the sealed report factors before any comparison can exist.
	if baseline.Target.Mixture == nil && target.Mixture == nil && allowed.primary != "code" {
		return nil
	}
	if (allowed.primary == "selector" && !selectorAvailable) ||
		(allowed.primary == "adaptation" && !adaptationAvailable) {
		return fmt.Errorf(
			"%w: change_profile %q requires a server-owned %s snapshot",
			ErrInvalid, profile, allowed.primary,
		)
	}
	if !primaryChanged {
		return fmt.Errorf(
			"%w: change_profile %q requires the %s treatment factor to change",
			ErrInvalid, profile, allowed.primary,
		)
	}
	return nil
}

func sameMixtureBinding(left, right *ManifestMixture) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.ID == right.ID && left.BindingDigest == right.BindingDigest
}

func changedMixtureDigest(
	left, right *ManifestMixture,
	value func(*ManifestMixture) string,
) (bool, bool) {
	if left == nil || right == nil {
		return left != right, false
	}
	return value(left) != value(right), true
}

func manifestPolicySnapshotDigest(target targetDefinition, snapshot ModelArmSnapshot, suiteRevisions map[string]string) string {
	return policySnapshotDigestForTarget(target, suiteRevisions)
}

func (s *Service) ListRuns() ([]Run, error) { return s.store.ListRuns() }

func (s *Service) GetRun(id string) (Run, error) { return s.store.GetRun(id) }

func (s *Service) StartRun(_ context.Context, id string) (Run, error) {
	return s.StartRunAs(context.Background(), SystemActor(), id)
}

func (s *Service) StartRunAs(ctx context.Context, actor Actor, id string) (Run, error) {
	s.store.lifecycle.mu.Lock()
	defer s.store.lifecycle.mu.Unlock()
	if err := s.store.authorizeRunActionUnlocked(actor, id, "start"); err != nil {
		return Run{}, err
	}
	return s.startRunInternal(ctx, id)
}

func (s *Service) startRunInternal(_ context.Context, id string) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.store.GetRun(id)
	if err != nil {
		return Run{}, err
	}
	if run.Status == StatusRunning || run.Status == StatusSealing || terminalStatus(run.Status) {
		return run, nil
	}
	if s.closed {
		return Run{}, fmt.Errorf("%w: evaluation service is closed", ErrConflict)
	}
	if run.Status != StatusPending {
		return Run{}, fmt.Errorf("%w: run cannot be started from %s", ErrConflict, run.Status)
	}
	if validationErr := s.validateRunStart(run); validationErr != nil {
		return Run{}, validationErr
	}
	manifestPath, err := s.store.ManifestPath(id)
	if err != nil {
		return Run{}, err
	}
	select {
	case s.semaphore <- struct{}{}:
	default:
		return Run{}, fmt.Errorf("%w: evaluation worker capacity is full; run remains pending", ErrConflict)
	}
	releaseSlot := func() { <-s.semaphore }
	workerContext, cancel := context.WithTimeout(context.Background(), s.workerTimeout)
	now := time.Now().UTC()
	pendingRun := run
	run.Status = StatusRunning
	run.StartedAt = &now
	run.Error = ""
	run.Progress.Message = "Evaluation worker starting"
	if err := s.store.UpdateRun(run); err != nil {
		cancel()
		releaseSlot()
		return Run{}, err
	}
	if _, err := s.appendEventLocked(Event{RunID: id, Type: "progress", Timestamp: now, Message: run.Progress.Message, Progress: &run.Progress}); err != nil {
		cancel()
		releaseSlot()
		if rollbackErr := s.store.UpdateRun(pendingRun); rollbackErr != nil {
			return Run{}, errors.Join(err, fmt.Errorf("restore pending evaluation run: %w", rollbackErr))
		}
		return Run{}, err
	}
	s.active[id] = cancel
	s.workerEvents[id] = 0
	s.workers.Add(1)
	go s.execute(workerContext, id, manifestPath, nil)
	return run, nil
}

func (s *Service) validateRunStart(run Run) error {
	manifest, _, err := s.readDurableManifest(run.ID)
	if err != nil {
		return err
	}
	if manifest.CodeRevision != s.codeRevision {
		return fmt.Errorf("%w: pending run source revision does not match the active evaluation worker", ErrConflict)
	}
	registry, _, err := s.registrySnapshot()
	if err != nil {
		return err
	}
	executorID, singleExecutor := manifestExecutorIdentity(manifest)
	executor, registered := registry.executor(executorID)
	if !singleExecutor || !registered || executor.Mode != manifest.Mode {
		return fmt.Errorf("%w: pending run executor is not registered for its frozen mode", ErrInvalid)
	}
	if manifest.GateContractVersion != GateContractVersion ||
		!reflect.DeepEqual(manifest.SuiteRevisions, suiteRevisionSnapshot(registry, manifest.SuiteIDs)) ||
		!reflect.DeepEqual(manifest.SuiteExecutors, suiteExecutorSnapshot(registry, manifest.SuiteIDs, manifest.Mode)) {
		return fmt.Errorf("%w: pending run suite or change-profile contract revision does not match the active evaluation worker", ErrConflict)
	}
	_, currentTarget, err := s.validateCreateRequest(registry, CreateRunRequest{
		ClientRequestID: run.ClientRequestID,
		Name:            run.Name, Description: run.Description,
		SuiteIDs: run.SuiteIDs, TrackIDs: run.TrackIDs,
		Mode: run.Mode, TargetID: run.TargetID, ChangeProfile: run.ChangeProfile,
		SampleLimit: run.SampleLimit, Concurrency: run.Concurrency, Seed: run.Seed,
		CapacitySLO:          copyCapacitySLO(run.CapacitySLO),
		CapacityLoadProtocol: copyCapacityLoadProtocol(run.CapacityLoadProtocol),
		BaselineRunID:        run.BaselineRunID,
	})
	if err != nil {
		return fmt.Errorf("%w: run target is no longer supported", ErrConflict)
	}
	mixtureDrift := manifest.Mode == ModeLive && (currentTarget.Mixture == nil ||
		manifest.PolicySnapshotDigest != currentTarget.Mixture.RecipeDigest)
	if !manifestMatchesTargetDefinition(manifest.Target, currentTarget) || mixtureDrift {
		return fmt.Errorf("%w: pending run mixture no longer matches the active recipe, pool, or binding", ErrConflict)
	}
	if manifest.ConfigDigest != currentTarget.ConfigDigest {
		return fmt.Errorf("%w: pending run config digest no longer matches the active target", ErrConflict)
	}
	return nil
}

func suiteRevisionSnapshot(registry *Registry, suiteIDs []string) map[string]string {
	revisions := make(map[string]string, len(suiteIDs))
	for _, suiteID := range suiteIDs {
		if suite, ok := registry.suite(suiteID); ok {
			revisions[suiteID] = suite.Revision
		}
	}
	return revisions
}

func suiteExecutorSnapshot(registry *Registry, suiteIDs []string, mode Mode) map[string]string {
	executors := make(map[string]string, len(suiteIDs))
	for _, suiteID := range suiteIDs {
		if suite, ok := registry.suite(suiteID); ok {
			if executor, executable := suiteExecutorForMode(suite, mode); executable {
				executors[suiteID] = executor
			}
		}
	}
	return executors
}

// Close prevents new workers from starting, cancels every active worker, and
// waits until each worker has released its process and concurrency slot.
func (s *Service) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		close(s.shutdown)
		cancellations := make([]context.CancelFunc, 0, len(s.active))
		for _, cancel := range s.active {
			cancellations = append(cancellations, cancel)
		}
		s.mu.Unlock()

		for _, cancel := range cancellations {
			cancel()
		}
		s.workers.Wait()

		s.mu.Lock()
		for runID, subscribers := range s.subscribers {
			for subscriber := range subscribers {
				close(subscriber)
			}
			delete(s.subscribers, runID)
		}
		s.subscriberCount = 0
		s.mu.Unlock()
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lifecycleErr
}

func (s *Service) CancelRun(id string) (Run, error) {
	return s.CancelRunAs(SystemActor(), id)
}

func (s *Service) CancelRunAs(actor Actor, id string) (Run, error) {
	s.store.lifecycle.mu.Lock()
	defer s.store.lifecycle.mu.Unlock()
	if err := s.store.authorizeRunActionUnlocked(actor, id, "cancel"); err != nil {
		return Run{}, err
	}
	return s.cancelRunInternal(id)
}

func (s *Service) cancelRunInternal(id string) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.store.GetRun(id)
	if err != nil {
		return Run{}, err
	}
	if terminalStatus(run.Status) {
		terminalEvent, eventErr := s.store.commitTerminalRun(run)
		if eventErr != nil {
			return Run{}, eventErr
		}
		if run.Status == StatusCancelled {
			if cancel, ok := s.active[id]; ok {
				cancel()
			}
		}
		s.broadcastEventLocked(terminalEvent)
		return run, nil
	}
	if run.Status != StatusRunning {
		return Run{}, fmt.Errorf("%w: run cannot be cancelled from %s", ErrConflict, run.Status)
	}
	now := time.Now().UTC()
	run.Status = StatusCancelled
	run.CompletedAt = &now
	run.Progress.Message = "Run cancelled"
	terminalEvent, err := s.store.commitTerminalRun(run)
	if err != nil {
		return Run{}, err
	}
	durable, err := s.store.GetRun(id)
	if err != nil {
		return Run{}, err
	}
	if durable.Status == StatusCancelled {
		if cancel, ok := s.active[id]; ok {
			cancel()
		}
	}
	s.broadcastEventLocked(terminalEvent)
	return durable, nil
}

func (s *Service) DeleteRun(id string) error {
	return s.DeleteRunAs(SystemActor(), id)
}

func (s *Service) DeleteRunAs(actor Actor, id string) error {
	s.store.lifecycle.mu.Lock()
	defer s.store.lifecycle.mu.Unlock()
	if err := s.store.authorizeRunActionUnlocked(actor, id, "delete"); err != nil {
		return err
	}
	return s.deleteRunInternal(actor, id)
}

func (s *Service) deleteRunInternal(actor Actor, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.store.GetRun(id)
	if err != nil {
		return err
	}
	if _, active := s.active[id]; active {
		return fmt.Errorf("%w: evaluation worker is still exiting", ErrConflict)
	}
	if run.Status == StatusRunning || run.Status == StatusSealing {
		return fmt.Errorf("%w: evaluation execution is still active", ErrConflict)
	}
	if err := s.store.deleteRunAuthorizedUnlocked(actor, id); err != nil {
		return err
	}
	for subscriber := range s.subscribers[id] {
		close(subscriber)
		s.subscriberCount--
	}
	delete(s.subscribers, id)
	return nil
}

func (s *Service) registrySnapshot() (*Registry, ModelArmSnapshot, error) {
	// The model runtime revision is not available from the Router config. Keep it
	// unset instead of conflating it with the evaluation source revision.
	snapshot, err := LoadModelArmSnapshot(s.configPath, "")
	if err != nil {
		return nil, ModelArmSnapshot{}, err
	}
	installedSuites, err := loadInstalledCatalogSuites(s.suiteStorePath)
	if err != nil {
		return nil, ModelArmSnapshot{}, err
	}
	deploymentTargets, err := LoadEvaluationDeploymentRegistry(s.deploymentsDir, "")
	if err != nil {
		return nil, ModelArmSnapshot{}, err
	}
	mixtures := snapshot.Mixtures
	if len(deploymentTargets) > 0 {
		mixtures = nil
	}
	registry, err := NewRegistry(s.routerAPIURL, s.envoyURL, RegistryOptions{
		RouterAPIKey: configuredRuntimeSecretRef(
			s.routerAPIURL, deploymentTargets, s.routerAPIKeyEnv, true,
		),
		EnvoyAPIKey: configuredRuntimeSecretRef(
			s.envoyURL, deploymentTargets, s.envoyAPIKeyEnv, false,
		),
		AgentTaskLedger:            copyServiceEndpoint(s.agentTaskLedger),
		FaultRecoveryLedger:        copyServiceEndpoint(s.faultRecoveryLedger),
		HardPolicyLedger:           copyServiceEndpoint(s.hardPolicyLedger),
		ProductionExperimentLedger: copyServiceEndpoint(s.productionExperimentLedger),
		Mixtures:                   mixtures,
		DeploymentTargets:          deploymentTargets,
		DefaultConfigDigest:        snapshot.ConfigDigest,
		RouterAuthRequired:         s.routerAuthRequired,
		InstalledSuites:            installedSuites,
	})
	if err != nil {
		return nil, ModelArmSnapshot{}, err
	}
	return registry, snapshot, nil
}

func configuredSecretRef(endpointURL, envName string) *SecretRef {
	if strings.TrimSpace(endpointURL) == "" || strings.TrimSpace(envName) == "" {
		return nil
	}
	return &SecretRef{SchemaVersion: SchemaVersion, Env: strings.TrimSpace(envName)}
}

func configuredRuntimeSecretRef(
	defaultOrigin string,
	deployments []DeploymentTargetSnapshot,
	envName string,
	router bool,
) *SecretRef {
	if strings.TrimSpace(envName) == "" {
		return nil
	}
	if strings.TrimSpace(defaultOrigin) != "" {
		return configuredSecretRef(defaultOrigin, envName)
	}
	for _, deployment := range deployments {
		origin := deployment.EnvoyURL
		if router {
			origin = deployment.RouterAPIURL
		}
		if origin != "" {
			return &SecretRef{SchemaVersion: SchemaVersion, Env: strings.TrimSpace(envName)}
		}
	}
	return nil
}

func terminalStatus(status RunStatus) bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusCancelled
}
