package evaluationplane

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type CollectionRequest struct {
	Apply      bool   `json:"apply"`
	PlanDigest string `json:"plan_digest,omitempty"`
}

type CollectionPlanItem struct {
	RunID          string         `json:"run_id"`
	RetentionClass RetentionClass `json:"retention_class"`
	DeleteAfter    time.Time      `json:"delete_after"`
	EstimatedBytes int64          `json:"estimated_bytes"`
}

type CollectionPlan struct {
	SchemaVersion         string               `json:"schema_version"`
	PolicyRevision        string               `json:"policy_revision"`
	GeneratedAt           time.Time            `json:"generated_at"`
	PlanDigest            string               `json:"plan_digest"`
	Candidates            []CollectionPlanItem `json:"candidates"`
	EstimatedReclaimBytes int64                `json:"estimated_reclaim_bytes"`
	Skipped               map[string]int       `json:"skipped"`
}

type CollectionResult struct {
	SchemaVersion string         `json:"schema_version"`
	Applied       bool           `json:"applied"`
	Plan          CollectionPlan `json:"plan"`
	DeletedRunIDs []string       `json:"deleted_run_ids"`
}

type collectionPlanIdentity struct {
	PolicyRevision string                   `json:"policy_revision"`
	Candidates     []collectionItemIdentity `json:"candidates"`
	Skipped        map[string]int           `json:"skipped"`
}

type collectionItemIdentity struct {
	RunID           string         `json:"run_id"`
	Status          RunStatus      `json:"status"`
	CompletedAt     time.Time      `json:"completed_at"`
	RetentionClass  RetentionClass `json:"retention_class"`
	DeleteAfter     time.Time      `json:"delete_after"`
	LifecycleDigest string         `json:"lifecycle_digest"`
	EvidenceDigest  string         `json:"evidence_digest"`
	EstimatedBytes  int64          `json:"estimated_bytes"`
}

type collectionPlanBuild struct {
	items               []CollectionPlanItem
	identities          []collectionItemIdentity
	candidateReferences map[string]map[string]bool
	remainingReferences map[string]bool
	skipped             map[string]int
}

func (s *Service) CollectLifecycle(actor Actor, request CollectionRequest) (CollectionResult, error) {
	s.store.lifecycle.mu.Lock()
	defer s.store.lifecycle.mu.Unlock()
	reason := "dry_run"
	if request.Apply {
		reason = "apply"
	}
	if err := s.store.authorizeAdministratorActionUnlocked(actor, "gc", reason); err != nil {
		return CollectionResult{}, err
	}
	plan, err := s.store.buildCollectionPlanUnlocked()
	if err != nil {
		return CollectionResult{}, err
	}
	if !request.Apply {
		if request.PlanDigest != "" {
			return CollectionResult{}, fmt.Errorf("%w: dry-run collection cannot supply plan_digest", ErrInvalid)
		}
		return CollectionResult{
			SchemaVersion: lifecyclePolicySchemaVersion, Applied: false, Plan: plan, DeletedRunIDs: []string{},
		}, nil
	}
	if !digestPattern.MatchString(request.PlanDigest) || request.PlanDigest != plan.PlanDigest {
		return CollectionResult{}, fmt.Errorf("%w: collection plan is stale or does not match", ErrConflict)
	}
	s.mu.Lock()
	for _, candidate := range plan.Candidates {
		if _, active := s.active[candidate.RunID]; active {
			s.mu.Unlock()
			return CollectionResult{}, fmt.Errorf("%w: collection candidate is still exiting", ErrConflict)
		}
	}
	s.mu.Unlock()
	deleted := make([]string, 0, len(plan.Candidates))
	for _, candidate := range plan.Candidates {
		if err := s.deleteRunInternal(actor, candidate.RunID); err != nil {
			return CollectionResult{}, err
		}
		deleted = append(deleted, candidate.RunID)
	}
	return CollectionResult{
		SchemaVersion: lifecyclePolicySchemaVersion, Applied: true, Plan: plan, DeletedRunIDs: deleted,
	}, nil
}

func (s *Store) buildCollectionPlanUnlocked() (CollectionPlan, error) {
	runEvidencePublicationMu.Lock()
	defer runEvidencePublicationMu.Unlock()
	s.runIndex.coordinator.Lock()
	defer s.runIndex.coordinator.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	runs, ledgerErr := s.loadCompleteRunReferenceLedgerUnlocked()
	if ledgerErr != nil {
		return CollectionPlan{}, fmt.Errorf("%w: collection requires a complete run ledger: %w", ErrConflict, ledgerErr)
	}
	referenced, referenceErr := s.collectionReferencedRunsUnlocked(runs)
	if referenceErr != nil {
		return CollectionPlan{}, referenceErr
	}
	now := s.lifecycleNow().UTC().Truncate(time.Microsecond)
	build, err := s.collectCollectionPlanCandidates(runs, referenced, now)
	if err != nil {
		return CollectionPlan{}, err
	}
	if evidenceErr := s.addCollectionReclaimableEvidence(&build); evidenceErr != nil {
		return CollectionPlan{}, evidenceErr
	}
	var reclaim int64
	for _, item := range build.items {
		reclaim += item.EstimatedBytes
	}
	identity := collectionPlanIdentity{
		PolicyRevision: lifecyclePolicyRevision, Candidates: build.identities, Skipped: build.skipped,
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return CollectionPlan{}, err
	}
	return CollectionPlan{
		SchemaVersion: lifecyclePolicySchemaVersion, PolicyRevision: lifecyclePolicyRevision,
		GeneratedAt: now, PlanDigest: digestBytes(encoded), Candidates: build.items,
		EstimatedReclaimBytes: reclaim, Skipped: build.skipped,
	}, nil
}

func (s *Store) collectCollectionPlanCandidates(
	runs []Run,
	referenced map[string]bool,
	now time.Time,
) (collectionPlanBuild, error) {
	build := collectionPlanBuild{
		items:               make([]CollectionPlanItem, 0),
		identities:          make([]collectionItemIdentity, 0),
		candidateReferences: make(map[string]map[string]bool),
		remainingReferences: make(map[string]bool),
		skipped: map[string]int{
			"active": 0, "held": 0, "protected": 0, "referenced": 0, "not_expired": 0,
		},
	}
	for _, run := range runs {
		lifecycle, lifecycleErr := s.readRunLifecycle(run)
		if lifecycleErr != nil {
			return collectionPlanBuild{}, fmt.Errorf("%w: collection requires valid lifecycle metadata", ErrConflict)
		}
		reason := collectionRunSkipReason(run, lifecycle, referenced, now)
		references := make(map[string]bool)
		if err := s.markRunCASReferences(run.ID, references); err != nil {
			return collectionPlanBuild{}, fmt.Errorf("%w: collection cannot verify run evidence", ErrConflict)
		}
		if reason != "" {
			build.skipped[reason]++
			for digest := range references {
				build.remainingReferences[digest] = true
			}
			continue
		}
		bundleBytes, sizeErr := s.collectionCandidateBytes(run.ID)
		if sizeErr != nil {
			return collectionPlanBuild{}, sizeErr
		}
		build.items = append(build.items, CollectionPlanItem{
			RunID: run.ID, RetentionClass: lifecycle.RetentionClass,
			DeleteAfter: *lifecycle.DeleteAfter, EstimatedBytes: bundleBytes,
		})
		completedAt := time.Time{}
		if run.CompletedAt != nil {
			completedAt = *run.CompletedAt
		}
		build.identities = append(build.identities, collectionItemIdentity{
			RunID: run.ID, Status: run.Status, CompletedAt: completedAt,
			RetentionClass: lifecycle.RetentionClass, DeleteAfter: *lifecycle.DeleteAfter,
			LifecycleDigest: lifecycle.PolicyDigest, EvidenceDigest: collectionReferenceDigest(references),
		})
		build.candidateReferences[run.ID] = references
	}
	return build, nil
}

func collectionRunSkipReason(run Run, lifecycle RunLifecycle, referenced map[string]bool, now time.Time) string {
	switch {
	case !terminalStatus(run.Status):
		return "active"
	case lifecycle.EvidenceHold:
		return "held"
	case lifecycle.RetentionClass == RetentionProtected:
		return "protected"
	case referenced[run.ID]:
		return "referenced"
	case lifecycle.DeleteAfter == nil || lifecycle.DeleteAfter.After(now):
		return "not_expired"
	default:
		return ""
	}
}

func (s *Store) collectionCandidateBytes(runID string) (int64, error) {
	bundleBytes, err := privateDirectoryBytes(filepath.Join(s.runsRoot, runID), "")
	if err != nil {
		return 0, err
	}
	info, err := os.Lstat(filepath.Join(s.attestationRoot, runID+".json"))
	if os.IsNotExist(err) {
		return bundleBytes, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("%w: collection cannot verify execution attestation", ErrConflict)
	}
	return bundleBytes + info.Size(), nil
}

func (s *Store) addCollectionReclaimableEvidence(build *collectionPlanBuild) error {
	sort.Slice(build.items, func(i, j int) bool { return build.items[i].RunID < build.items[j].RunID })
	itemByID := make(map[string]*CollectionPlanItem, len(build.items))
	for index := range build.items {
		itemByID[build.items[index].RunID] = &build.items[index]
	}
	digestOwners := make(map[string][]string)
	for runID, references := range build.candidateReferences {
		for digest := range references {
			if !build.remainingReferences[digest] {
				digestOwners[digest] = append(digestOwners[digest], runID)
			}
		}
	}
	for digest, runIDs := range digestOwners {
		sort.Strings(runIDs)
		info, statErr := os.Lstat(filepath.Join(s.root, "objects", "sha256", digest))
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: collection cannot verify reclaimable CAS evidence", ErrConflict)
		}
		itemByID[runIDs[0]].EstimatedBytes += info.Size()
	}
	for index := range build.identities {
		build.identities[index].EstimatedBytes = itemByID[build.identities[index].RunID].EstimatedBytes
	}
	sort.Slice(build.identities, func(i, j int) bool {
		return build.identities[i].RunID < build.identities[j].RunID
	})
	return nil
}

func collectionReferenceDigest(references map[string]bool) string {
	digests := make([]string, 0, len(references))
	for digest := range references {
		digests = append(digests, digest)
	}
	sort.Strings(digests)
	encoded, err := json.Marshal(digests)
	if err != nil {
		panic(err)
	}
	return digestBytes(encoded)
}

func (s *Store) collectionReferencedRunsUnlocked(runs []Run) (map[string]bool, error) {
	referenced := make(map[string]bool)
	for _, run := range runs {
		if run.BaselineRunID != "" {
			referenced[run.BaselineRunID] = true
		}
	}
	campaigns, err := s.loadStoredCampaignsUnlocked()
	if err != nil {
		return nil, fmt.Errorf("%w: collection cannot verify campaign references: %w", ErrConflict, err)
	}
	for _, campaign := range campaigns {
		bindings, err := campaignEvidenceBindings(campaign.GateBindings)
		if err != nil {
			return nil, fmt.Errorf("%w: collection cannot verify campaign bindings", ErrConflict)
		}
		for _, binding := range bindings {
			referenced[binding.runID] = true
		}
	}
	return referenced, nil
}
