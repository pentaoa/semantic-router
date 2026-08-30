package evaluationplane

import (
	"errors"
	"fmt"
	"reflect"
	"time"
)

type campaignRunEvidence struct {
	report      Report
	records     []executionRecordEvidence
	attestation *executionAttestation
	manifest    RunManifest
	anchor      CampaignEvidenceAnchor
}

func (s *Service) CreateCampaign(request CreateCampaignRequest) (Campaign, error) {
	if err := validateCampaignRequest(request); err != nil {
		return Campaign{}, err
	}
	if existing, err := s.store.GetCampaign(request.ClientRequestID); err == nil {
		if campaignMatchesRequest(existing, request) {
			return existing, nil
		}
		return Campaign{}, fmt.Errorf("%w: campaign id belongs to another request", ErrConflict)
	} else if !errors.Is(err, ErrNotFound) {
		return Campaign{}, err
	}
	release, acquireErr := s.acquireEvidenceRead()
	if acquireErr != nil {
		return Campaign{}, acquireErr
	}
	defer release()
	if err := s.RequireCompleteRunLedger(); err != nil {
		return Campaign{}, err
	}
	evidence, err := s.loadCampaignEvidence(request.ChangeProfile, request.GateBindings, nil)
	if err != nil {
		return Campaign{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	campaign := Campaign{
		SchemaVersion: SchemaVersion, ContractVersion: CampaignContractVersion,
		ID: request.ClientRequestID, Name: request.Name, Description: request.Description,
		ChangeProfile: request.ChangeProfile, Status: CampaignStatusDecided,
		GateBindings: request.GateBindings, CreatedAt: now,
	}
	campaign.ManifestDigest, err = campaignManifestDigest(campaign)
	if err != nil {
		return Campaign{}, err
	}
	campaign.Decision, err = buildCampaignDecision(campaign, evidence, now)
	if err != nil {
		return Campaign{}, err
	}
	if err := s.store.CreateCampaign(campaign); err != nil {
		if errors.Is(err, ErrConflict) {
			existing, getErr := s.store.GetCampaign(request.ClientRequestID)
			if getErr == nil && campaignMatchesRequest(existing, request) {
				return existing, nil
			}
			if getErr != nil {
				return Campaign{}, errors.Join(err, getErr)
			}
		}
		return Campaign{}, err
	}
	return campaign, nil
}

func (s *Service) GetCampaign(id string) (Campaign, error) {
	campaign, err := s.store.GetCampaign(id)
	if err != nil {
		return Campaign{}, err
	}
	release, err := s.acquireEvidenceRead()
	if err != nil {
		return Campaign{}, err
	}
	defer release()
	expected := make(map[string]CampaignEvidenceAnchor, len(campaign.Decision.Evidence))
	for _, anchor := range campaign.Decision.Evidence {
		expected[campaignEvidenceKey(anchor.SlotID, anchor.BindingRole)] = anchor
	}
	evidence, err := s.loadCampaignEvidence(campaign.ChangeProfile, campaign.GateBindings, expected)
	if err != nil {
		return Campaign{}, err
	}
	rebuilt, err := buildCampaignDecision(campaign, evidence, campaign.Decision.CreatedAt)
	if err != nil || !reflect.DeepEqual(rebuilt, campaign.Decision) {
		return Campaign{}, fmt.Errorf("%w: campaign decision differs from its sealed private evidence", ErrInvalid)
	}
	return campaign, nil
}

func campaignMatchesRequest(campaign Campaign, request CreateCampaignRequest) bool {
	return campaign.ID == request.ClientRequestID && campaign.Name == request.Name &&
		campaign.Description == request.Description && campaign.ChangeProfile == request.ChangeProfile &&
		reflect.DeepEqual(campaign.GateBindings, request.GateBindings)
}

func (s *Service) loadCampaignEvidence(
	profile ChangeProfile,
	gateBindings CampaignGateBindings,
	expected map[string]CampaignEvidenceAnchor,
) (map[string]campaignRunEvidence, error) {
	bindings, err := campaignEvidenceBindings(gateBindings)
	if err != nil {
		return nil, err
	}
	if expected != nil && len(expected) != len(bindings) {
		return nil, fmt.Errorf("%w: campaign evidence anchor set is incomplete", ErrInvalid)
	}
	loaded := make(map[string]campaignRunEvidence, len(bindings))
	for _, binding := range bindings {
		key := campaignEvidenceKey(binding.slotID, binding.bindingRole)
		var sealed *CampaignEvidenceAnchor
		if expected != nil {
			value, ok := expected[key]
			if !ok {
				return nil, fmt.Errorf("%w: campaign evidence anchor %s is missing", ErrInvalid, key)
			}
			sealed = &value
		}
		item, loadErr := s.loadCampaignRunEvidence(binding, sealed)
		if loadErr != nil {
			return nil, loadErr
		}
		loaded[key] = item
	}
	if err := validateCampaignEvidenceSet(profile, gateBindings, loaded); err != nil {
		return nil, err
	}
	return loaded, nil
}

func (s *Service) loadCampaignRunEvidence(
	binding campaignEvidenceBinding,
	expected *CampaignEvidenceAnchor,
) (campaignRunEvidence, error) {
	label := binding.slotID + " " + binding.bindingRole
	report, err := s.decodedReport(binding.runID)
	if err != nil {
		return campaignRunEvidence{}, fmt.Errorf("%s report: %w", label, err)
	}
	records, err := s.loadPrivateComparisonRecords(binding.runID)
	if err != nil {
		return campaignRunEvidence{}, fmt.Errorf("%s records: %w", label, err)
	}
	storedAnchor, err := s.store.readReportAnchor(binding.runID)
	if err != nil {
		return campaignRunEvidence{}, fmt.Errorf("%s anchor: %w", label, err)
	}
	manifest, manifestBytes, err := s.readDurableManifest(binding.runID)
	if err != nil {
		return campaignRunEvidence{}, fmt.Errorf("%s manifest: %w", label, err)
	}
	manifestArtifactDigest, _ := digestAndSize(manifestBytes)
	if storedAnchor.ManifestSemanticDigest != manifest.ManifestDigest ||
		storedAnchor.ManifestArtifactDigest != manifestArtifactDigest {
		return campaignRunEvidence{}, fmt.Errorf("%w: %s manifest no longer matches its sealed anchor", ErrInvalid, label)
	}
	item := campaignRunEvidence{report: report, records: records, manifest: manifest}
	if report.Run.Mode == ModeLive {
		attestation, attestationErr := s.store.readExecutionAttestation(binding.runID)
		if attestationErr != nil || storedAnchor.ExecutionAttestationDigest == "" ||
			storedAnchor.ExecutionAttestationDigest != attestation.Digest {
			return campaignRunEvidence{}, fmt.Errorf("%w: %s lacks an exact execution attestation", ErrInvalid, label)
		}
		item.attestation = &attestation
	} else if storedAnchor.ExecutionAttestationDigest != "" {
		return campaignRunEvidence{}, fmt.Errorf("%w: %s replay evidence claims a live attestation", ErrInvalid, label)
	}
	item.anchor = CampaignEvidenceAnchor{
		SlotID: binding.slotID, GateID: binding.gateID, BindingRole: binding.bindingRole,
		RunID:                  binding.runID,
		ManifestSemanticDigest: storedAnchor.ManifestSemanticDigest,
		ManifestArtifactDigest: storedAnchor.ManifestArtifactDigest,
		ReportDigest:           storedAnchor.ReportDigest, PrivateReceiptDigest: storedAnchor.PrivateReceiptDigest,
		ExecutionAttestationDigest: storedAnchor.ExecutionAttestationDigest,
	}
	if binding.candidate {
		digest, digestErr := candidateSubjectDigest(manifest, report)
		if digestErr != nil {
			return campaignRunEvidence{}, fmt.Errorf("%s candidate subject: %w", label, digestErr)
		}
		item.anchor.CandidateSubjectDigest = digest
	}
	if expected != nil && !reflect.DeepEqual(item.anchor, *expected) {
		return campaignRunEvidence{}, fmt.Errorf("%w: campaign evidence anchor %s changed", ErrInvalid, label)
	}
	return item, nil
}

func buildCampaignDecision(
	campaign Campaign,
	evidence map[string]campaignRunEvidence,
	now time.Time,
) (CampaignDecision, error) {
	var paired *CampaignPairedLiveEvidence
	var fidelity *CampaignFidelityEvidence
	var err error
	if campaign.GateBindings.G3ControlledPair != nil {
		paired, err = buildCampaignPairedLiveEvidence(
			evidence[campaignEvidenceKey("g3", "baseline")],
			evidence[campaignEvidenceKey("g3", "candidate")],
		)
		if err != nil {
			return CampaignDecision{}, err
		}
	}
	if campaign.GateBindings.G5Fidelity != nil {
		fidelity, err = buildCampaignFidelityEvidence(
			evidence[campaignEvidenceKey("g5", "reference")],
			evidence[campaignEvidenceKey("g5", "live")],
		)
		if err != nil {
			return CampaignDecision{}, err
		}
	}
	gates := make([]CampaignGate, 0, len(requiredGateIDs))
	for index, gateID := range requiredGateIDs {
		gates = append(gates, campaignGateFor(
			campaign.ChangeProfile, campaign.GateBindings, index, gateID, evidence, paired, fidelity,
		))
	}
	bindings, err := campaignEvidenceBindings(campaign.GateBindings)
	if err != nil {
		return CampaignDecision{}, err
	}
	anchors := make([]CampaignEvidenceAnchor, 0, len(bindings))
	for _, binding := range bindings {
		anchors = append(anchors, evidence[campaignEvidenceKey(binding.slotID, binding.bindingRole)].anchor)
	}
	verdict, summary, recommendations := campaignDecisionSummary(gates)
	decision := CampaignDecision{
		SchemaVersion: SchemaVersion, ContractVersion: CampaignContractVersion,
		AttestationRevision: ServerAttestationRevision, CampaignID: campaign.ID,
		CampaignDigest: campaign.ManifestDigest, Verdict: verdict, Summary: summary,
		Gates: gates, Evidence: anchors, PairedLiveEvidence: paired, FidelityEvidence: fidelity,
		Recommendations: recommendations, CreatedAt: now,
	}
	decision.DecisionDigest, err = campaignDecisionDigest(decision)
	if err != nil {
		return CampaignDecision{}, err
	}
	return decision, nil
}

func campaignGateFor(
	profile ChangeProfile,
	bindings CampaignGateBindings,
	index int,
	gateID string,
	evidence map[string]campaignRunEvidence,
	paired *CampaignPairedLiveEvidence,
	fidelity *CampaignFidelityEvidence,
) CampaignGate {
	if gateID == "G0" || gateID == "G1" {
		return CampaignGate{
			ID: gateID, Name: gateNames[index], Disposition: "required", Verdict: "pass",
			EvidenceLevel: "E5", Source: "server_anchors",
			EvidenceRefs: campaignEvidenceRefs(bindings, evidence), Observed: float64Reference(1),
			Threshold: &GateThreshold{Operator: ">=", Value: 1, Unit: "boolean"},
			Rationale: "Every bound run has an immutable manifest, sealed private receipt, server report anchor, and exact slot identity.",
		}
	}
	slot, _ := campaignSlotContract(profile, gateID)
	base := CampaignGate{
		ID: gateID, Name: slot.Name, Disposition: slot.Disposition,
		Verdict: "unavailable", EvidenceLevel: slot.MinimumEvidenceLevel,
		Source: "campaign_slot", EvidenceRefs: []string{},
		Rationale: "No qualified evidence is bound to this advisory campaign slot.",
	}
	if slot.Disposition == "not_applicable" {
		base.Verdict, base.Source = "not_applicable", "campaign_contract"
		base.Rationale = "The gate is not applicable to this change profile."
		return base
	}
	slotID := "g" + gateID[1:]
	switch gateID {
	case "G3":
		if paired == nil {
			return base
		}
		return campaignPairedLiveGate(
			base, *paired,
			evidence[campaignEvidenceKey("g3", "baseline")],
			evidence[campaignEvidenceKey("g3", "candidate")],
		)
	case "G5":
		if fidelity == nil {
			return base
		}
		base.Verdict, base.EvidenceLevel, base.Source = fidelity.Verdict, "E5", "reference_to_fresh_live"
		base.Observed = float64Reference(fidelity.LowerBound)
		base.Threshold = &GateThreshold{Operator: ">=", Value: fidelityMinimum, Unit: "fraction"}
		base.SampleCount = fidelity.SampleCount
		base.EvidenceRefs = append(
			campaignEvidenceRefsFor(evidence, campaignEvidenceKey("g5", "reference"), campaignEvidenceKey("g5", "live")),
			"campaign-fidelity:"+fidelity.Digest,
		)
		base.Rationale = fmt.Sprintf(
			"Reference-to-fresh-live agreement: %d/%d cases matched, with %d decision, %d outcome, and %d unavailable case(s); one-sided 95%% lower bound %.6g.",
			fidelity.MatchedCases, fidelity.SampleCount, fidelity.DecisionMismatches,
			fidelity.OutcomeMismatches, fidelity.UnavailableCases, fidelity.LowerBound,
		)
		return base
	default:
		item, found := evidence[campaignEvidenceKey(slotID, campaignSingleBindingRole)]
		if !found {
			return base
		}
		gate, found := reportGate(item.report, gateID)
		if !found {
			return base
		}
		return reportCampaignGate(base, gate, "campaign_slot:"+slotID, item.anchor)
	}
}

func reportGate(report Report, id string) (Gate, bool) {
	return reportGateFromSlice(report.Gates, id)
}

func reportGateFromSlice(gates []Gate, id string) (Gate, bool) {
	for _, gate := range gates {
		if gate.ID == id {
			return gate, true
		}
	}
	return Gate{}, false
}

func reportCampaignGate(base CampaignGate, source Gate, owner string, anchor CampaignEvidenceAnchor) CampaignGate {
	base.Verdict, base.EvidenceLevel, base.Source = source.Verdict, source.EvidenceLevel, owner
	base.Observed, base.Threshold, base.Rationale = source.Observed, source.Threshold, source.Rationale
	if source.SampleCount != nil {
		base.SampleCount = *source.SampleCount
	}
	base.EvidenceRefs = anchorEvidenceRefs(anchor)
	return base
}

func anchorEvidenceRefs(anchor CampaignEvidenceAnchor) []string {
	refs := []string{
		"run:" + anchor.SlotID + ":" + anchor.BindingRole + ":" + anchor.RunID,
		"manifest-semantic:" + anchor.ManifestSemanticDigest,
		"manifest-artifact:" + anchor.ManifestArtifactDigest,
		"report:" + anchor.ReportDigest,
		"private-receipt:" + anchor.PrivateReceiptDigest,
	}
	if anchor.CandidateSubjectDigest != "" {
		refs = append(refs, "candidate-subject:"+anchor.CandidateSubjectDigest)
	}
	if anchor.ExecutionAttestationDigest != "" {
		refs = append(refs, "execution-attestation:"+anchor.ExecutionAttestationDigest)
	}
	return refs
}

func campaignEvidenceRefsFor(evidence map[string]campaignRunEvidence, keys ...string) []string {
	refs := make([]string, 0, len(keys)*6)
	for _, key := range keys {
		if item, ok := evidence[key]; ok {
			refs = append(refs, anchorEvidenceRefs(item.anchor)...)
		}
	}
	return refs
}

func campaignEvidenceRefs(
	gateBindings CampaignGateBindings,
	evidence map[string]campaignRunEvidence,
) []string {
	bindings, _ := campaignEvidenceBindings(gateBindings)
	refs := make([]string, 0, len(bindings)*6)
	for _, binding := range bindings {
		refs = append(refs, anchorEvidenceRefs(evidence[campaignEvidenceKey(binding.slotID, binding.bindingRole)].anchor)...)
	}
	return refs
}

func campaignDecisionSummary(gates []CampaignGate) (GateVerdict, string, []string) {
	failed, unavailable, passed := 0, 0, 0
	for _, gate := range gates {
		if gate.Disposition != "required" {
			continue
		}
		switch gate.Verdict {
		case "fail":
			failed++
		case "pass":
			passed++
		default:
			unavailable++
		}
	}
	if failed > 0 {
		return "fail", fmt.Sprintf("Promotion blocked: %d required gate(s) failed; %d passed.", failed, passed),
			[]string{"Keep the baseline active and resolve every failed campaign gate before another decision."}
	}
	if unavailable > 0 {
		return "unavailable", fmt.Sprintf("Decision incomplete: %d required gate(s) passed and %d lack qualified evidence.", passed, unavailable),
			[]string{"Produce qualified evidence for every required campaign slot; unavailable evidence is never inferred as pass."}
	}
	return "pass", fmt.Sprintf("Promotion qualified: all %d required campaign gates passed.", passed),
		[]string{"Proceed through the declared rollout controls while retaining the sealed baseline and campaign anchors."}
}
