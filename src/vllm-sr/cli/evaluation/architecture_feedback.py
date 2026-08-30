"""Turn qualified metric/gate findings into scoped architecture actions."""

from __future__ import annotations

from dataclasses import dataclass

from cli.evaluation.reporting import EvaluationGate, EvaluationMetric

_MIN_ROUTING_COVERAGE = 0.95
_MAX_FALLBACK_RATE = 0.10
_POOL_ORACLE_GAIN_FLOOR = 0.02
_MIN_SELECTION_ARM_COVERAGE = 0.50
_MAX_NORMALIZED_REGRET = 0.20
_MIN_AGENT_SUCCESS = 0.90
_MIN_ORACLE_CAPTURE = 0.90
_MIN_EFFECTIVE_SAMPLE_RATIO = 0.50
_MAX_FAILURE_OVERLAP = 0.50


@dataclass(frozen=True)
class ArchitectureFinding:
    id: str
    owner: str
    surface: str
    evidence: str
    action: str

    def render(self) -> str:
        return (
            f"[{self.id}] Owner={self.owner}; surface={self.surface}; "
            f"evidence={self.evidence}; action={self.action}"
        )


def _values(metrics: list[EvaluationMetric]) -> dict[str, float | None]:
    return {metric.id: metric.value for metric in metrics}


def _routing_findings(values: dict[str, float | None]) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    coverage = values.get("routing.coverage")
    if coverage is not None and coverage < _MIN_ROUTING_COVERAGE:
        findings.append(
            ArchitectureFinding(
                "AF-ROUTING-COVERAGE",
                "Router recipe owner",
                "signals / projections / decisions / fallback",
                f"routing.coverage={coverage:.3f}",
                "inspect unmatched decision traces and slice coverage before changing the model pool",
            )
        )
    fallback = values.get("routing.fallback_rate")
    if fallback is not None and fallback > _MAX_FALLBACK_RATE:
        findings.append(
            ArchitectureFinding(
                "AF-FALLBACK",
                "Router recipe owner",
                "decision eligibility and fallback boundary",
                f"routing.fallback_rate={fallback:.3f}",
                "separate intended abstention from missing capability and verify fallback does not cross policy or trust boundaries",
            )
        )
    return findings


def _pool_value_findings(
    values: dict[str, float | None],
) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    oracle_gain = values.get("model_pool.oracle_gain")
    if oracle_gain is not None and oracle_gain <= _POOL_ORACLE_GAIN_FLOOR:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-REDUNDANCY",
                "Model-pool owner",
                "PoolDefinition / ModelArm admission",
                f"model_pool.oracle_gain={oracle_gain:.3f}",
                "remove redundant arms or admit an arm that closes a measured capability, cost, or failure-domain gap",
            )
        )
    selection_coverage = values.get("model_pool.selection_arm_coverage")
    if (
        selection_coverage is not None
        and selection_coverage < _MIN_SELECTION_ARM_COVERAGE
    ):
        findings.append(
            ArchitectureFinding(
                "AF-POOL-COLLAPSE",
                "Selector and model-pool owners",
                "eligibility, calibration, and arm utilization",
                f"model_pool.selection_arm_coverage={selection_coverage:.3f}",
                "compare arm quality and marginal contribution before deciding whether low utilization is correct dominance or selector collapse",
            )
        )
    regret = values.get("joint.normalized_regret")
    if regret is not None and regret > _MAX_NORMALIZED_REGRET:
        findings.append(
            ArchitectureFinding(
                "AF-UNREALIZED-POOL-VALUE",
                "Router recipe and selector owners",
                "PolicyBinding / features / selector algorithm",
                f"joint.normalized_regret={regret:.3f}",
                "hold the pool fixed, inspect per-case oracle misses and decision traces, then improve feasibility recall or utility calibration",
            )
        )
    return findings


def _pool_health_findings(
    values: dict[str, float | None],
) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    dominated_arms = values.get("model_pool.quality_dominated_arm_count")
    if dominated_arms is not None and dominated_arms > 0:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-DOMINANCE",
                "Model-pool owner",
                "PoolDefinition / ModelArm lifecycle",
                f"model_pool.quality_dominated_arm_count={dominated_arms:.0f}",
                "verify the common-case dominance slice, then remove or quarantine arms that add no quality, cost, policy, modality, or failure-domain value",
            )
        )
    pareto_dominated = values.get("model_pool.pareto_dominated_arm_count")
    if pareto_dominated is not None and pareto_dominated > 0:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-PARETO-DOMINANCE",
                "Model-pool owner",
                "PoolDefinition quality-cost frontier",
                f"model_pool.pareto_dominated_arm_count={pareto_dominated:.0f}",
                "remove or quarantine arms dominated on the complete common-case quality-cost frontier unless they provide an explicit policy, modality, or failure-domain benefit",
            )
        )
    failure_overlap = values.get("model_pool.mean_pairwise_failure_jaccard")
    if failure_overlap is not None and failure_overlap > _MAX_FAILURE_OVERLAP:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-CORRELATED-FAILURE",
                "Model-pool owner",
                "provider and capability failure diversity",
                f"model_pool.mean_pairwise_failure_jaccard={failure_overlap:.3f}",
                "admit an arm with a distinct failure domain or tighten admission for cases where the current arms fail together",
            )
        )
    worst_arm_reliability = values.get("model_pool.worst_arm_reliability")
    if worst_arm_reliability is not None and worst_arm_reliability < 1:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-WEAK-ARM",
                "Model-pool owner",
                "PoolDefinition arm admission and health",
                f"model_pool.worst_arm_reliability={worst_arm_reliability:.3f}",
                "inspect per-arm failure rates and slices, then repair or quarantine the least reliable arm before pool availability masks its degradation",
            )
        )
    all_arm_failure = values.get("model_pool.all_arm_failure_rate")
    if all_arm_failure is not None and all_arm_failure > 0:
        findings.append(
            ArchitectureFinding(
                "AF-POOL-CAPABILITY-GAP",
                "Model-pool owner",
                "PoolDefinition capability coverage",
                f"model_pool.all_arm_failure_rate={all_arm_failure:.3f}",
                "cluster cases where every arm fails and admit a qualified capability or reject those requests at a typed admission boundary",
            )
        )
    oracle_capture = values.get("joint.oracle_capture_ratio")
    if oracle_capture is not None and oracle_capture < _MIN_ORACLE_CAPTURE:
        findings.append(
            ArchitectureFinding(
                "AF-ORACLE-CAPTURE",
                "Router recipe and selector owners",
                "features / projections / selector calibration",
                f"joint.oracle_capture_ratio={oracle_capture:.3f}",
                "hold the pool and utility contract fixed, then recover missed oracle value by slice before adding selector complexity",
            )
        )
    return findings


def _pool_findings(values: dict[str, float | None]) -> list[ArchitectureFinding]:
    return _pool_value_findings(values) + _pool_health_findings(values)


def _agent_safety_findings(
    values: dict[str, float | None],
) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    agent_success = values.get("agentic.success_rate")
    if agent_success is not None and agent_success < _MIN_AGENT_SUCCESS:
        findings.append(
            ArchitectureFinding(
                "AF-TRAJECTORY",
                "Agent and Router session owners",
                "session continuity / tool-loop protection / recovery",
                f"agentic.success_rate={agent_success:.3f}",
                "evaluate step and terminal failures separately, preserve tool ownership, and test state portability under exact-step faults",
            )
        )
    modality_support = values.get("multimodal.support_rate")
    if modality_support is not None and modality_support < 1.0:
        findings.append(
            ArchitectureFinding(
                "AF-MODALITY-CAPABILITY",
                "Router, model-pool, and serving owners",
                "typed modality admission and ModelArm capability mask",
                f"multimodal.support_rate={modality_support:.3f}",
                "separate admission, logical routing, payload transport, backend generation, and privacy failures by modality",
            )
        )
    violations = values.get("safety.violation_rate")
    if violations is not None and violations > 0:
        findings.append(
            ArchitectureFinding(
                "AF-HARD-POLICY",
                "Security and recipe owners",
                "static enforcement and fallback policy boundary",
                f"safety.violation_rate={violations:.3f}",
                "block promotion, identify the violating slice and enforcement path, and add a non-waivable regression case",
            )
        )
    false_negatives = values.get("safety.false_negative_rate")
    if false_negatives is not None and false_negatives > 0:
        findings.append(
            ArchitectureFinding(
                "AF-SAFETY-FALSE-NEGATIVE",
                "Security and recipe owners",
                "unsafe-request detection and non-waivable enforcement",
                f"safety.false_negative_rate={false_negatives:.3f}",
                "block promotion, inspect unsafe cases that reached a backend, and move the invariant to static enforcement where possible",
            )
        )
    privacy_exposures = values.get("agentic.privacy_exposures_per_trajectory")
    if privacy_exposures is not None and privacy_exposures > 0:
        findings.append(
            ArchitectureFinding(
                "AF-AGENT-PRIVACY",
                "Agent security and Router session owners",
                "tool arguments / session state / cross-model handoff",
                f"agentic.privacy_exposures_per_trajectory={privacy_exposures:.3f}",
                "block promotion and trace each exposure to its exact step, tool boundary, and model handoff before changing routing quality policy",
            )
        )
    return findings


def _capacity_preference_findings(
    values: dict[str, float | None],
) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    saturation = values.get("capacity.saturation_concurrency")
    if saturation is not None:
        findings.append(
            ArchitectureFinding(
                "AF-CAPACITY-SATURATION",
                "Serving and placement owner",
                "queueing / batching / replica and GPU placement",
                f"capacity.saturation_concurrency={saturation:.0f}",
                "locate the SLO crossing, retry amplification, and per-arm bottleneck before changing logical routing policy",
            )
        )
    propensity = values.get("preference.propensity_coverage")
    if propensity is not None and propensity < 1.0:
        findings.append(
            ArchitectureFinding(
                "AF-ONLINE-ASSIGNMENT",
                "Online experimentation owner",
                "assignment / exposure / propensity ledger",
                f"preference.propensity_coverage={propensity:.3f}",
                "do not train or claim causal preference lift until every eligible exposure records its behavior propensity and executed action",
            )
        )
    effective_sample_ratio = values.get("preference.effective_sample_ratio")
    if (
        effective_sample_ratio is not None
        and effective_sample_ratio < _MIN_EFFECTIVE_SAMPLE_RATIO
    ):
        findings.append(
            ArchitectureFinding(
                "AF-PREFERENCE-SUPPORT",
                "Online experimentation owner",
                "assignment support and propensity policy",
                f"preference.effective_sample_ratio={effective_sample_ratio:.3f}",
                "treat the apparent lift as weakly supported, cap extreme weights, and redesign assignment coverage before updating the router online",
            )
        )
    return findings


def _modality_slice_findings(
    values: dict[str, float | None],
) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    for metric_id, support in sorted(values.items()):
        if (
            metric_id.startswith("multimodal.")
            and metric_id.endswith(".support_rate")
            and support is not None
            and support < 1.0
        ):
            modality = metric_id.removeprefix("multimodal.").removesuffix(
                ".support_rate"
            )
            findings.append(
                ArchitectureFinding(
                    f"AF-MODALITY-{modality.upper().replace('_', '-')}",
                    "Router, model-pool, and serving owners",
                    "typed modality admission and ModelArm capability mask",
                    f"{metric_id}={support:.3f}",
                    f"separate {modality} admission, routing, transport, generation, and privacy failures before changing the shared multimodal policy",
                )
            )
    return findings


def _workload_findings(values: dict[str, float | None]) -> list[ArchitectureFinding]:
    return (
        _agent_safety_findings(values)
        + _capacity_preference_findings(values)
        + _modality_slice_findings(values)
    )


def _metric_findings(values: dict[str, float | None]) -> list[ArchitectureFinding]:
    return (
        _routing_findings(values) + _pool_findings(values) + _workload_findings(values)
    )


def _gate_findings(gates: list[EvaluationGate]) -> list[ArchitectureFinding]:
    findings: list[ArchitectureFinding] = []
    by_id = {gate.id: gate for gate in gates}
    if by_id.get("G5") and by_id["G5"].verdict == "unavailable":
        findings.append(
            ArchitectureFinding(
                "AF-LIVE-FIDELITY-EVIDENCE",
                "Evaluation owner",
                "qualified reference-to-fresh-live Campaign slot",
                "G5=unavailable",
                "bind an unchanged candidate to a qualified reference and a fresh live run over the exact frozen cases and grading contract, retaining every failure in the paired denominator",
            )
        )
    if by_id.get("G7") and by_id["G7"].verdict == "unavailable":
        findings.append(
            ArchitectureFinding(
                "AF-CAPACITY-CONTRACT",
                "Serving and product SLO owners",
                "versioned load profile and SLO contract",
                "G7=unavailable",
                "declare traffic shape, cold/warm state, latency/error thresholds, saturation rule, and capacity headroom before promotion",
            )
        )
    if by_id.get("G8") and by_id["G8"].verdict == "unavailable":
        findings.append(
            ArchitectureFinding(
                "AF-SHADOW-CANARY-EVIDENCE",
                "Online experimentation owner",
                "shadow/canary control contract",
                "G8=unavailable",
                "add assignment and exposure counts, sample-ratio checks, hard guardrails, stop criteria, and a signed rollback recommendation",
            )
        )
    if by_id.get("G9") and by_id["G9"].verdict == "unavailable":
        findings.append(
            ArchitectureFinding(
                "AF-PREFERENCE-EVIDENCE",
                "Online preference owner",
                "consent / exposure / propensity / segment evidence",
                "G9=unavailable",
                "retain participation, propensity, effective sample size, confidence intervals, and key segments before enabling online adaptation",
            )
        )
    return findings


def architecture_recommendations(
    metrics: list[EvaluationMetric], gates: list[EvaluationGate]
) -> tuple[str, ...]:
    """Return deterministic, de-duplicated owner/action recommendations."""

    findings = _metric_findings(_values(metrics)) + _gate_findings(gates)
    unique: dict[str, ArchitectureFinding] = {}
    for finding in findings:
        unique.setdefault(finding.id, finding)
    return tuple(unique[key].render() for key in sorted(unique))
