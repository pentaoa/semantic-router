from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

import pytest
from cli.evaluation.contracts import (
    EvaluationTargetArm,
    ManifestMixture,
    MixtureDecisionBinding,
)
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.fault_recovery_ledger import (
    FAULT_RECOVERY_LEDGER_VERSION,
    FaultRecoveryLedger,
    execute_fault_recovery_ledger,
)
from cli.evaluation.gates import GateEvidenceContext, compute_gates
from cli.evaluation.hard_policy_ledger import (
    HARD_POLICY_LEDGER_VERSION,
    HardPolicyLedger,
    execute_hard_policy_ledger,
)
from cli.evaluation.http_client import HTTPResult
from cli.evaluation.manifest_identity import (
    mixture_target_id,
    model_pool_snapshot_digest,
    selector_snapshot_digest,
)
from cli.evaluation.method_evidence import (
    ExperimentPolicyArm,
    HardPolicyEnforcementBinding,
    HardPolicyMethodEvidence,
    HardPolicyStaticProof,
    OnlinePreferenceOutcome,
    ProductionExperimentMethodEvidence,
    RecoveryMethodEvidence,
    RobustnessMethodEvidence,
)
from cli.evaluation.method_ledger_identity import method_mixture_binding
from cli.evaluation.metric_hard_policy import reduce_hard_policy
from cli.evaluation.metric_production_experiment import (
    production_experiment_metrics,
    reduce_production_experiment,
)
from cli.evaluation.metric_recovery import reduce_recovery
from cli.evaluation.metric_robustness import reduce_robustness
from cli.evaluation.production_experiment_ledger import (
    PRODUCTION_EXPERIMENT_LEDGER_VERSION,
    ProductionExperimentLedger,
    execute_production_experiment_ledger,
)


def _digest(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode()).hexdigest()


_START = datetime(2026, 8, 30, 1, tzinfo=UTC)
_POLICY = _digest("1")
_CONFIG = _digest("2")
_BROKER_RECEIPT = _digest("3")
_TOPOLOGY = _digest("method-topology")


class _LedgerClient:
    def __init__(
        self, payload: dict[str, object], *, fetched_at: datetime | None = None
    ):
        self.payload = payload
        self.fetched_at = fetched_at or _START + timedelta(hours=1)
        self.calls: list[dict[str, object]] = []

    def get(self, endpoint: str, **kwargs: object) -> HTTPResult:
        self.calls.append({"endpoint": endpoint, **kwargs})
        return HTTPResult(
            success=True,
            status_code=200,
            payload=self.payload,
            latency_ms=1.0,
            headers={},
            broker_receipt=_BROKER_RECEIPT,
            fetched_at=self.fetched_at,
        )


def _policy_arms() -> tuple[ExperimentPolicyArm, ...]:
    return (
        ExperimentPolicyArm(
            id="policy-a",
            config_digest=_digest("4"),
            assignment_probability=0.5,
            target_policy_probability=0.0,
            reference_policy_probability=1.0,
        ),
        ExperimentPolicyArm(
            id="policy-b",
            config_digest=_digest("5"),
            assignment_probability=0.5,
            target_policy_probability=1.0,
            reference_policy_probability=0.0,
        ),
    )


def _production_assignment(
    index: int,
    *,
    assignment_count: int,
    total_outcomes: int,
    risk_event: bool = False,
    stop_triggered: bool = False,
) -> ProductionExperimentMethodEvidence:
    arm = "policy-a" if index % 2 else "policy-b"
    return ProductionExperimentMethodEvidence(
        contract_version="evaluation-production-experiment.v1",
        experiment_id="experiment-1",
        ledger_id="ledger-1",
        ledger_total_assignment_count=assignment_count,
        ledger_total_outcome_count=total_outcomes,
        source_id="production-router",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture_snapshot_digest=method_mixture_binding(_mixture()).snapshot_digest,
        environment="production",
        assignment_scheme="randomized",
        assignment_id=f"assignment-{index}",
        exposure_id=f"exposure-{index}",
        participant_digest=_digest(str(index + 5)),
        segment_id="segment-a",
        policy_arms=_policy_arms(),
        assigned_policy_arm_id=arm,
        selected_model_id=f"model-{arm[-1]}",
        assignment_probability=0.5,
        exposure_probability=1.0,
        behavior_propensity=0.5,
        target_policy_probability=0.0 if arm == "policy-a" else 1.0,
        minimum_effective_sample_size=10,
        minimum_effective_sample_ratio=0.5,
        minimum_segment_sample_size=20,
        minimum_assignment_count=20,
        minimum_reward_lift=0.1,
        confidence_level=0.95,
        risk_event=risk_event,
        risk_budget_max_rate=0.2,
        stop_rule_id="stop-rule-1",
        stop_rule_evaluated_at=_START + timedelta(minutes=10),
        stop_triggered=stop_triggered,
        rollback_receipt_id="rollback-receipt-1",
        rollback_validated_at=_START + timedelta(minutes=12),
        rollback_ready=True,
        rollback_executed_at=(
            _START + timedelta(minutes=11) if stop_triggered else None
        ),
        rollback_succeeded=True if stop_triggered else None,
        assigned_at=_START + timedelta(seconds=index),
        exposed_at=_START + timedelta(seconds=index + 30),
        ledger_sealed_at=_START + timedelta(minutes=13),
    )


def _production_ledger(
    *,
    assignment_count: int = 20,
    outcome_count: int | None = None,
    risk_event_count: int = 0,
    target_reward: float = 1.0,
    reference_reward: float = 0.5,
    stop_triggered: bool = False,
) -> ProductionExperimentLedger:
    if outcome_count is None:
        outcome_count = assignment_count
    assignments = tuple(
        _production_assignment(
            index,
            assignment_count=assignment_count,
            total_outcomes=outcome_count,
            risk_event=index <= risk_event_count,
            stop_triggered=stop_triggered,
        )
        for index in range(1, assignment_count + 1)
    )
    outcomes = tuple(
        OnlinePreferenceOutcome(
            contract_version="evaluation-online-preference-ledger.v1",
            outcome_id=f"outcome-{index}",
            assignment_id=assignments[index - 1].assignment_id,
            exposure_id=assignments[index - 1].exposure_id,
            participant_digest=assignments[index - 1].participant_digest,
            segment_id=assignments[index - 1].segment_id,
            reward=(
                reference_reward
                if assignments[index - 1].assigned_policy_arm_id == "policy-a"
                else target_reward
            ),
            observed_at=_START + timedelta(minutes=5, seconds=index),
        )
        for index in range(1, outcome_count + 1)
    )
    return ProductionExperimentLedger(
        contract_version=PRODUCTION_EXPERIMENT_LEDGER_VERSION,
        experiment_id="experiment-1",
        ledger_id="ledger-1",
        source_id="production-router",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=method_mixture_binding(_mixture()),
        environment="production",
        assignment_scheme="randomized",
        risk_budget_max_rate=0.2,
        stop_rule_id="stop-rule-1",
        stop_rule_evaluated_at=_START + timedelta(minutes=10),
        stop_triggered=stop_triggered,
        rollback_receipt_id="rollback-receipt-1",
        rollback_validated_at=_START + timedelta(minutes=12),
        rollback_ready=True,
        rollback_executed_at=(
            _START + timedelta(minutes=11) if stop_triggered else None
        ),
        rollback_succeeded=True if stop_triggered else None,
        minimum_effective_sample_size=10,
        minimum_effective_sample_ratio=0.5,
        minimum_segment_sample_size=20,
        minimum_assignment_count=20,
        minimum_reward_lift=0.1,
        confidence_level=0.95,
        window_started_at=_START,
        window_ended_at=_START + timedelta(minutes=10),
        sealed_at=_START + timedelta(minutes=13),
        assignments=assignments,
        preference_outcomes=outcomes,
    )


def _model_arms() -> tuple[EvaluationTargetArm, ...]:
    return tuple(
        EvaluationTargetArm(
            id=f"model-{suffix}",
            model=f"provider/model-{suffix}",
            provider_model_id_digest=_digest(digit),
            input_cost_per_million_tokens_usd=0,
            output_cost_per_million_tokens_usd=0,
        )
        for suffix, digit in (("a", "8"), ("b", "9"))
    )


def _mixture() -> ManifestMixture:
    arms = _model_arms()
    recipe_name = "method-ledger-recipe"
    selector_policy = _digest("method-selector-policy")
    return ManifestMixture(
        id=mixture_target_id(recipe_name),
        entrypoint_model="method-entrypoint",
        aliases=("method-entrypoint",),
        recipe_name=recipe_name,
        recipe_description="Frozen method-ledger evaluation subject",
        recipe_digest=_digest("method-recipe"),
        pool_digest=model_pool_snapshot_digest(arms),
        selector_policy_digest=selector_policy,
        selector_digest=selector_snapshot_digest(selector_policy, ()),
        adaptation_digest=_digest("method-adaptation"),
        binding_digest=_digest("method-binding"),
        model_arms=arms,
        support_models=(),
        fallback_arm_id=arms[0].id,
        decisions=(
            MixtureDecisionBinding(
                name="default",
                algorithm="single",
                arm_ids=tuple(sorted(arm.id for arm in arms)),
            ),
        ),
    )


def _execute_production(
    ledger: ProductionExperimentLedger, *, sample_limit: int | None = None
):
    client = _LedgerClient(ledger.model_dump(mode="json"))
    execution = execute_production_experiment_ledger(
        client,  # type: ignore[arg-type]
        "https://ledger.example.test/window",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=_mixture(),
        model_arms=_model_arms(),
        sample_limit=sample_limit or len(ledger.assignments),
        seed=7,
    )
    assert client.calls[0]["broker_operation"] == "production.experiment-ledger"
    return execution


def test_production_ledger_yields_g8_controls_and_g9_causal_estimates() -> None:
    execution = _execute_production(_production_ledger())
    reduced = reduce_production_experiment(execution.records)

    assert reduced.candidate_safe is True
    assert reduced.causal_eligible is True
    assert reduced.assignment_support == 1.0
    assert reduced.outcome_coverage == 1.0
    assert reduced.effective_sample_size == pytest.approx(10.0)
    assert reduced.snips_reward == pytest.approx(1.0)
    assert reduced.reference_snips_reward == pytest.approx(0.5)
    assert reduced.reward_lift == pytest.approx(0.5)
    assert reduced.preference_passed is True
    assert reduced.snips_confidence_interval is not None
    metric_values = {
        metric.id: metric.value
        for metric in production_experiment_metrics(execution.records)
    }
    assert metric_values["experiment.risk_budget_max_rate"] == 0.2
    assert metric_values["preference.online_snips_reward"] == pytest.approx(1.0)

    context = GateEvidenceContext(
        production_candidate_safe=reduced.candidate_safe,
        online_preference_qualified=reduced.preference_passed,
        production_assignment_support=reduced.assignment_support,
        production_balance_p_value=reduced.assignment_balance_p_value,
        production_risk_event_rate=reduced.risk_event_rate,
        production_risk_event_upper_confidence_bound=(
            reduced.risk_event_upper_confidence_bound
        ),
        production_risk_budget_max_rate=reduced.risk_budget_max_rate,
        online_outcome_coverage=reduced.outcome_coverage,
        online_effective_sample_size=reduced.effective_sample_size,
        online_minimum_effective_sample_size=reduced.minimum_effective_sample_size,
        online_effective_sample_ratio=reduced.effective_sample_ratio,
        online_minimum_effective_sample_ratio=reduced.minimum_effective_sample_ratio,
        online_segment_coverage=reduced.segment_coverage,
        online_snips_reward=reduced.snips_reward,
        online_reference_snips_reward=reduced.reference_snips_reward,
        online_causal_eligible=reduced.causal_eligible,
        online_reward_lift=reduced.reward_lift,
        online_reward_lift_lower_bound=reduced.reward_lift_confidence_interval[0],
        online_minimum_reward_lift=reduced.minimum_reward_lift,
    )
    gates = compute_gates(
        production_experiment_metrics(execution.records),
        has_records=True,
        change_profile="online_adaptation",
        evidence=context,
        records=execution.records,
    )
    g8 = next(gate for gate in gates if gate.id == "G8")
    g9 = next(gate for gate in gates if gate.id == "G9")
    assert g8.verdict == "pass"
    assert g8.observed == pytest.approx(reduced.risk_event_upper_confidence_bound)
    assert g8.threshold.value == 0.2
    assert (g9.verdict, g9.observed, g9.threshold.value) == ("pass", 0.5, 0.1)
    assert "target SNIPS=1.0" in g9.rationale


def test_production_gate_never_qualifies_a_partial_sealed_window() -> None:
    ledger = _production_ledger()
    with pytest.raises(ValueError, match="cover every assignment"):
        _execute_production(ledger, sample_limit=1)

    full = _execute_production(ledger)
    reduced = reduce_production_experiment(full.records[:10])
    assert reduced.candidate_safe is False
    assert reduced.causal_eligible is False
    assert reduced.snips_reward is None


def test_preference_without_full_outcomes_has_no_causal_claim() -> None:
    execution = _execute_production(_production_ledger(outcome_count=19))
    reduced = reduce_production_experiment(execution.records)
    assert reduced.candidate_safe is True
    assert reduced.outcome_coverage == 0.95
    assert reduced.causal_eligible is False
    assert reduced.ips_reward is None
    assert reduced.snips_reward is None
    assert reduced.preference_passed is None


def test_production_risk_budget_failure_is_reported_against_frozen_threshold() -> None:
    execution = _execute_production(_production_ledger(risk_event_count=5))
    reduced = reduce_production_experiment(execution.records)
    assert reduced.risk_event_rate == 0.25
    assert reduced.risk_event_upper_confidence_bound > 0.2
    assert reduced.risk_budget_max_rate == 0.2
    assert reduced.candidate_safe is False


def test_tiny_clean_production_window_cannot_pass_g8() -> None:
    execution = _execute_production(_production_ledger(assignment_count=2))
    reduced = reduce_production_experiment(execution.records)
    assert reduced.risk_event_rate == 0
    assert reduced.risk_event_upper_confidence_bound > 0.2
    assert reduced.candidate_safe is False


def test_causally_eligible_but_regressed_target_policy_fails_g9() -> None:
    execution = _execute_production(
        _production_ledger(target_reward=0.25, reference_reward=0.75)
    )
    reduced = reduce_production_experiment(execution.records)
    assert reduced.causal_eligible is True
    assert reduced.reward_lift == pytest.approx(-0.5)
    assert reduced.reward_lift_confidence_interval is not None
    assert reduced.preference_passed is False


def test_successful_rollback_does_not_turn_a_triggered_stop_into_a_g8_pass() -> None:
    reduced = reduce_production_experiment(
        _execute_production(_production_ledger(stop_triggered=True)).records
    )
    assert reduced.controls_operational is True
    assert reduced.candidate_safe is False


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("minimum_assignment_count", 2),
        ("minimum_effective_sample_size", 1),
        ("minimum_effective_sample_ratio", 0.1),
        ("minimum_segment_sample_size", 1),
        ("minimum_reward_lift", -0.1),
        ("risk_budget_max_rate", 0.5),
    ),
)
def test_production_ledger_cannot_relax_platform_minima(
    field: str, value: object
) -> None:
    payload = _production_assignment(
        1, assignment_count=20, total_outcomes=20
    ).model_dump(mode="json")
    payload[field] = value
    with pytest.raises(ValueError):
        ProductionExperimentMethodEvidence.model_validate(payload)


def _hard_policy_ledger() -> HardPolicyLedger:
    bindings = (
        HardPolicyEnforcementBinding(
            rule_id="jailbreak", enforcement_point="extproc-request"
        ),
        HardPolicyEnforcementBinding(
            rule_id="pii-output", enforcement_point="extproc-response"
        ),
    )
    proof = HardPolicyStaticProof(
        contract_version="evaluation-hard-policy-proof.v1",
        proof_id="proof-1",
        source_id="production-router",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture_snapshot_digest=method_mixture_binding(_mixture()).snapshot_digest,
        runtime_instance_digest=_digest("a"),
        ledger_total_observation_count=2,
        required_bindings=bindings,
        verified_at=_START,
    )
    observations = tuple(
        HardPolicyMethodEvidence(
            contract_version="evaluation-hard-policy-observation.v1",
            proof=proof,
            observation_id=f"observation-{index}",
            attack_id=f"attack-{index}",
            rule_id=binding.rule_id,
            enforcement_point=binding.enforcement_point,
            decision_receipt_id=f"decision-{index}",
            should_block=True,
            blocked=True,
            violations=0,
            observed_at=_START + timedelta(minutes=index),
        )
        for index, binding in enumerate(bindings, start=1)
    )
    return HardPolicyLedger(
        contract_version=HARD_POLICY_LEDGER_VERSION,
        ledger_id="hard-policy-ledger-1",
        source_id="production-router",
        environment="production",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=method_mixture_binding(_mixture()),
        proof=proof,
        window_started_at=_START,
        window_ended_at=_START + timedelta(minutes=3),
        sealed_at=_START + timedelta(minutes=4),
        observations=observations,
    )


def test_hard_policy_requires_exact_binding_pairs_and_full_window() -> None:
    ledger = _hard_policy_ledger()
    client = _LedgerClient(ledger.model_dump(mode="json"))
    execution = execute_hard_policy_ledger(
        client,  # type: ignore[arg-type]
        "https://policy.example.test/window",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=_mixture(),
        sample_limit=2,
        seed=11,
    )
    assert client.calls[0]["broker_operation"] == "hard-policy.ledger"
    assert (
        reduce_hard_policy(
            execution.records,
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
        ).dynamic_passed
        is True
    )
    partial = reduce_hard_policy(
        execution.records[:1],
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
    )
    assert partial.static_proof_passed is False
    assert partial.dynamic_passed is False
    with pytest.raises(ValueError, match="cover every observation"):
        execute_hard_policy_ledger(
            client,  # type: ignore[arg-type]
            "https://policy.example.test/window",
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
            target_id=_mixture().id,
            backend_topology_digest=_TOPOLOGY,
            mixture=_mixture(),
            sample_limit=1,
            seed=11,
        )


def test_g4_and_g6_partial_native_exports_remain_unavailable() -> None:
    source = ExecutionRecord(
        id="routing-source",
        track_id="routing",
        case_id="source",
        attempt_id="source-attempt",
        status="succeeded",
        selected_arm_id="arm-a",
        success=True,
    )
    target = ExecutionRecord(
        id="routing-target",
        track_id="routing",
        case_id="target",
        attempt_id="target-attempt",
        status="succeeded",
        selected_arm_id="arm-a",
        success=True,
        robustness=RobustnessMethodEvidence(
            method_id="routerarena.robustness.v1",
            pair_id="pair-1",
            source_case_id="source",
            target_case_id="target",
            shift_type="paraphrase",
            relation="invariant",
            source_action_id="arm-a",
            slice_ids=("routerarena:paraphrase",),
            native_pair_count=2,
            source_record_digest=_digest("b"),
        ),
    )
    assert reduce_robustness([source, target]).passed is None

    recovery = _recovery_pair(1)
    row = ExecutionRecord(
        id="agentic-row",
        track_id="agentic",
        case_id="agentic-case",
        attempt_id="agentic-attempt",
        status="succeeded",
        success=True,
        recovery=recovery,
    )
    assert reduce_recovery([row]).passed is None


def _recovery_pair(index: int) -> RecoveryMethodEvidence:
    return RecoveryMethodEvidence(
        method_id="live-fault-recovery.v1",
        ledger_id="fault-ledger-1",
        source_id="runtime-router",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture_snapshot_digest=method_mixture_binding(_mixture()).snapshot_digest,
        ledger_total_pair_count=20,
        minimum_pair_count=20,
        minimum_distinct_seed_count=5,
        fault_id=f"fault-{index}",
        cohort_pair_id="pair-1",
        repetition_id=f"repetition-{index}",
        conversation_id="conversation-1",
        cluster_id="cluster-a",
        seed=index % 5,
        concurrency=1,
        treatment_system="treatment",
        fault_kind="timeout",
        fault_sequence=0,
        failure_turn=0,
        fault_plan_digest=_digest(f"fault-plan-{index}"),
        fault_injection_receipt_digest=_digest(f"injection-{index}"),
        baseline_record_digest=_digest(f"baseline-{index}"),
        treatment_record_digest=_digest(f"treatment-{index}"),
        injection_observed=True,
        recovered=True,
        state_preserved=True,
        baseline_terminal_success=False,
        treatment_terminal_success=True,
        baseline_recovery_latency_ms=100,
        treatment_recovery_latency_ms=120,
        baseline_retry_count=1,
        treatment_retry_count=1,
        maximum_recovery_latency_ms=200,
        maximum_retry_amplification=1.5,
        side_effect_scope="none",
        side_effect_count=0,
        duplicate_side_effect_count=0,
        observed_at=_START + timedelta(minutes=index),
    )


def _fault_recovery_ledger() -> FaultRecoveryLedger:
    return FaultRecoveryLedger(
        contract_version=FAULT_RECOVERY_LEDGER_VERSION,
        ledger_id="fault-ledger-1",
        source_id="runtime-router",
        environment="production",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=method_mixture_binding(_mixture()),
        minimum_pair_count=20,
        minimum_distinct_seed_count=5,
        maximum_recovery_latency_ms=200,
        maximum_retry_amplification=1.5,
        window_started_at=_START,
        window_ended_at=_START + timedelta(minutes=21),
        sealed_at=_START + timedelta(minutes=22),
        pairs=tuple(_recovery_pair(index) for index in range(1, 21)),
    )


def test_live_fault_recovery_ledger_is_full_window_and_snapshot_bound() -> None:
    ledger = _fault_recovery_ledger()
    client = _LedgerClient(ledger.model_dump(mode="json"))
    execution = execute_fault_recovery_ledger(
        client,  # type: ignore[arg-type]
        "https://faults.example.test/window",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=_mixture().id,
        backend_topology_digest=_TOPOLOGY,
        mixture=_mixture(),
        sample_limit=20,
        seed=13,
    )
    assert client.calls[0]["broker_operation"] == "fault-recovery.ledger"
    assert (
        reduce_recovery(
            execution.records,
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
        ).passed
        is True
    )
    with pytest.raises(ValueError, match="cover every pair"):
        execute_fault_recovery_ledger(
            client,  # type: ignore[arg-type]
            "https://faults.example.test/window",
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
            target_id=_mixture().id,
            backend_topology_digest=_TOPOLOGY,
            mixture=_mixture(),
            sample_limit=1,
            seed=13,
        )


def _execute_method_kind(
    kind: str,
    *,
    target_id: str | None = None,
    topology_digest: str | None = None,
    mixture: ManifestMixture | None = None,
    fetched_at: datetime | None = None,
) -> None:
    selected_mixture = mixture or _mixture()
    selected_target = target_id or _mixture().id
    selected_topology = topology_digest or _TOPOLOGY
    if kind == "fault-recovery":
        ledger = _fault_recovery_ledger()
        execute_fault_recovery_ledger(
            _LedgerClient(ledger.model_dump(mode="json"), fetched_at=fetched_at),  # type: ignore[arg-type]
            "https://faults.example.test/window",
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
            target_id=selected_target,
            backend_topology_digest=selected_topology,
            mixture=selected_mixture,
            sample_limit=len(ledger.pairs),
            seed=17,
        )
        return
    if kind == "hard-policy":
        ledger = _hard_policy_ledger()
        execute_hard_policy_ledger(
            _LedgerClient(ledger.model_dump(mode="json"), fetched_at=fetched_at),  # type: ignore[arg-type]
            "https://policy.example.test/window",
            policy_snapshot_digest=_POLICY,
            config_digest=_CONFIG,
            target_id=selected_target,
            backend_topology_digest=selected_topology,
            mixture=selected_mixture,
            sample_limit=len(ledger.observations),
            seed=17,
        )
        return
    ledger = _production_ledger()
    execute_production_experiment_ledger(
        _LedgerClient(ledger.model_dump(mode="json"), fetched_at=fetched_at),  # type: ignore[arg-type]
        "https://production.example.test/window",
        policy_snapshot_digest=_POLICY,
        config_digest=_CONFIG,
        target_id=selected_target,
        backend_topology_digest=selected_topology,
        mixture=selected_mixture,
        model_arms=_model_arms(),
        sample_limit=len(ledger.assignments),
        seed=17,
    )


@pytest.mark.parametrize("kind", ("fault-recovery", "hard-policy", "production"))
@pytest.mark.parametrize(
    "substitution",
    ("target", "topology", "mixture"),
)
def test_method_ledgers_reject_runtime_subject_substitution(
    kind: str, substitution: str
) -> None:
    kwargs: dict[str, object] = {}
    if substitution == "target":
        kwargs["target_id"] = "different-target"
    elif substitution == "topology":
        kwargs["topology_digest"] = _digest("different-topology")
    else:
        kwargs["mixture"] = _mixture().model_copy(
            update={"binding_digest": _digest("different-binding")}
        )
    with pytest.raises(ValueError, match="different runtime snapshot"):
        _execute_method_kind(kind, **kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize("kind", ("fault-recovery", "hard-policy", "production"))
@pytest.mark.parametrize(
    ("fetch_delta", "message"),
    (
        (timedelta(seconds=-1), "future"),
        (timedelta(hours=24, seconds=1), "freshness"),
    ),
)
def test_method_ledgers_reject_future_and_stale_seals(
    kind: str, fetch_delta: timedelta, message: str
) -> None:
    sealed_at = {
        "fault-recovery": _fault_recovery_ledger().sealed_at,
        "hard-policy": _hard_policy_ledger().sealed_at,
        "production": _production_ledger().sealed_at,
    }[kind]
    with pytest.raises(ValueError, match=message):
        _execute_method_kind(kind, fetched_at=sealed_at + fetch_delta)
