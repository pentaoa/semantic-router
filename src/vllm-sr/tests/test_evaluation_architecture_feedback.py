from __future__ import annotations

from cli.evaluation.architecture_feedback import architecture_recommendations
from cli.evaluation.reporting import EvaluationGate, EvaluationMetric


def _metric(metric_id: str, value: float, track_id: str) -> EvaluationMetric:
    return EvaluationMetric(
        id=metric_id,
        name=metric_id,
        track_id=track_id,
        value=value,
        unit="fraction",
        direction="higher_is_better",
        sample_count=20,
    )


def _gate(gate_id: str, verdict: str) -> EvaluationGate:
    return EvaluationGate(
        id=gate_id,
        name=gate_id,
        disposition="required",
        verdict=verdict,
        change_profile="online_adaptation",
        contract_version="evaluation-release-gates.v2",
        evidence_refs=("records.jsonl",),
        evidence_level="E5",
    )


def test_feedback_separates_recipe_pool_agent_and_serving_owners() -> None:
    recommendations = architecture_recommendations(
        [
            _metric("routing.coverage", 0.8, "routing"),
            _metric("model_pool.oracle_gain", 0.01, "model_pool"),
            _metric("joint.normalized_regret", 0.35, "joint"),
            _metric("agentic.success_rate", 0.6, "agentic"),
            _metric("capacity.saturation_concurrency", 8.0, "capacity"),
        ],
        [],
    )
    rendered = "\n".join(recommendations)
    assert "Owner=Router recipe owner" in rendered
    assert "Owner=Model-pool owner" in rendered
    assert "Owner=Agent and Router session owners" in rendered
    assert "Owner=Serving and placement owner" in rendered
    assert "hold the pool fixed" in rendered


def test_missing_online_evidence_produces_concrete_contract_actions() -> None:
    recommendations = architecture_recommendations(
        [],
        [
            _gate("G5", "unavailable"),
            _gate("G8", "unavailable"),
            _gate("G9", "unavailable"),
        ],
    )
    rendered = "\n".join(recommendations)
    assert "reference-to-fresh-live Campaign slot" in rendered
    assert "sample-ratio checks" in rendered
    assert "effective sample size" in rendered


def test_healthy_metrics_do_not_create_speculative_actions() -> None:
    assert (
        architecture_recommendations(
            [
                _metric("routing.coverage", 1.0, "routing"),
                _metric("model_pool.oracle_gain", 0.2, "model_pool"),
                _metric("joint.normalized_regret", 0.05, "joint"),
                _metric("agentic.success_rate", 1.0, "agentic"),
                _metric("multimodal.support_rate", 1.0, "multimodal"),
                _metric("safety.violation_rate", 0.0, "safety"),
                _metric("preference.propensity_coverage", 1.0, "preference"),
            ],
            [],
        )
        == ()
    )


def test_feedback_uses_pool_safety_preference_and_modality_diagnostics() -> None:
    recommendations = architecture_recommendations(
        [
            _metric("model_pool.quality_dominated_arm_count", 2.0, "model_pool"),
            _metric("model_pool.pareto_dominated_arm_count", 1.0, "model_pool"),
            _metric("model_pool.mean_pairwise_failure_jaccard", 0.8, "model_pool"),
            _metric("model_pool.worst_arm_reliability", 0.7, "model_pool"),
            _metric("model_pool.all_arm_failure_rate", 0.1, "model_pool"),
            _metric("joint.oracle_capture_ratio", 0.7, "joint"),
            _metric("safety.false_negative_rate", 0.05, "safety"),
            _metric("agentic.privacy_exposures_per_trajectory", 0.02, "agentic"),
            _metric("preference.effective_sample_ratio", 0.2, "preference"),
            _metric("multimodal.image.support_rate", 0.8, "multimodal"),
        ],
        [],
    )

    rendered = "\n".join(recommendations)
    assert "AF-POOL-DOMINANCE" in rendered
    assert "AF-POOL-PARETO-DOMINANCE" in rendered
    assert "AF-POOL-CORRELATED-FAILURE" in rendered
    assert "AF-POOL-WEAK-ARM" in rendered
    assert "AF-POOL-CAPABILITY-GAP" in rendered
    assert "AF-ORACLE-CAPTURE" in rendered
    assert "AF-SAFETY-FALSE-NEGATIVE" in rendered
    assert "AF-AGENT-PRIVACY" in rendered
    assert "AF-PREFERENCE-SUPPORT" in rendered
    assert "AF-MODALITY-IMAGE" in rendered
