"""Track and evidence-method contracts for the evaluation catalog."""

from __future__ import annotations

import re
from collections.abc import Mapping
from types import MappingProxyType
from typing import Literal

from pydantic import field_validator, model_validator

from cli.evaluation.contracts import StrictModel
from cli.evaluation.reporting import EvidenceLevel, TrackID


class CatalogTrack(StrictModel):
    id: TrackID
    name: str
    description: str
    modes: tuple[Literal["replay", "live"], ...]
    metrics: tuple[str, ...]
    evidence_levels: tuple[EvidenceLevel, ...] = ()


_METHOD_GATE_TRACKS: Mapping[str, TrackID] = MappingProxyType(
    {
        "G2": "safety",
        "G4": "routing",
        "G6": "agentic",
        "G7": "capacity",
        "G8": "preference",
        "G9": "preference",
    }
)


class CatalogMethod(StrictModel):
    """One server-derived evidence method shown by catalog-driven readiness UI."""

    id: str
    track_id: TrackID
    qualified_gate_ids: tuple[str, ...]
    evidence_source: Literal[
        "diagnostic_fixture",
        "live_runtime",
        "normalized_import",
        "server_brokered_live",
        "live_production",
    ]
    status: Literal["qualified", "configured", "data_required"]
    reason: str | None = None

    @field_validator("id")
    @classmethod
    def portable_id(cls, value: str) -> str:
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value) is None:
            raise ValueError("catalog method id must be portable")
        return value

    @model_validator(mode="after")
    def validate_readiness(self) -> CatalogMethod:
        if len(self.qualified_gate_ids) != len(set(self.qualified_gate_ids)) or any(
            _METHOD_GATE_TRACKS.get(gate_id) != self.track_id
            for gate_id in self.qualified_gate_ids
        ):
            raise ValueError("catalog method gates must be unique and track-owned")
        if self.status == "data_required":
            if self.reason is None or not self.reason.strip():
                raise ValueError("data-required catalog method needs an exact reason")
        elif self.reason is not None:
            raise ValueError("ready catalog methods cannot carry an unavailable reason")
        if self.status == "qualified":
            raise ValueError(
                "method qualification requires server-owned native execution provenance"
            )
        if self.evidence_source == "normalized_import" and (
            self.status != "configured" or self.qualified_gate_ids
        ):
            raise ValueError(
                "normalized imports are configured exploratory methods without gates"
            )
        if self.evidence_source == "server_brokered_live" and (
            self.status != "configured"
            or self.track_id != "routing"
            or self.qualified_gate_ids != ("G4",)
        ):
            raise ValueError(
                "server-brokered declared-shift methods qualify only routing G4"
            )
        return self


CATALOG_TRACKS = (
    CatalogTrack(
        id="routing",
        name="Routing",
        description="Recipe decisions, coverage, abstention, fallback, and oracle regret.",
        modes=("replay", "live"),
        metrics=(
            "routing.coverage",
            "routing.accuracy",
            "routing.abstention_rate",
            "routing.fallback_rate",
            "routing.success_rate",
            "routing.selection_entropy_bits",
            "routing.selected_arm_count",
            "routing.latency_p50_ms",
            "routing.latency_p95_ms",
        ),
        evidence_levels=("E0", "E3", "E4"),
    ),
    CatalogTrack(
        id="model_pool",
        name="Model pool",
        description="Arm quality, complementarity, unique wins, and pool oracle quality.",
        modes=("replay", "live"),
        metrics=(
            "model_pool.arm_count",
            "model_pool.best_single_quality",
            "model_pool.oracle_quality",
            "model_pool.oracle_gain",
            "model_pool.unique_wins",
            "model_pool.unique_win_rate",
            "model_pool.selection_entropy_bits",
            "model_pool.selection_arm_coverage",
            "model_pool.quality_dominated_arm_count",
            "model_pool.pareto_evaluable_arm_count",
            "model_pool.pareto_dominated_arm_count",
            "model_pool.mean_pairwise_failure_jaccard",
            "model_pool.worst_arm_reliability",
            "model_pool.all_arm_failure_rate",
        ),
        evidence_levels=("E0", "E4"),
    ),
    CatalogTrack(
        id="joint",
        name="Routing + pool",
        description="Realized system utility, oracle regret, latency, reliability, and cost.",
        modes=("replay", "live"),
        metrics=(
            "joint.realized_quality",
            "joint.oracle_regret",
            "joint.normalized_regret",
            "joint.reliability",
            "joint.oracle_capture_ratio",
            "joint.runtime_cost_per_success",
            "joint.latency_p95_ms",
        ),
        evidence_levels=("E0", "E5"),
    ),
    CatalogTrack(
        id="agentic",
        name="Agentic",
        description=(
            "Task quality, trajectory and explicit tool-policy integrity, privacy, complete cost, "
            "and separately qualified recovery continuity."
        ),
        modes=("replay", "live"),
        metrics=(
            "agentic.success_rate",
            "agentic.task_score",
            "agentic.invalid_tool_rate",
            "agentic.mean_trajectory_steps",
            "agentic.privacy_exposures_per_trajectory",
            "agentic.runtime_cost_per_success",
            "agentic.task_attempt_count",
            "agentic.task_distinct_count",
            "agentic.task_attempt_success_rate",
            "agentic.task_attempt_success_rate_lower_95",
            "agentic.task_reliability",
            "agentic.task_reliability_lower_95",
            "agentic.task_mean_score",
            "agentic.task_mean_steps",
            "agentic.task_invalid_tool_rate",
            "agentic.task_tool_required_attempt_count",
            "agentic.task_pure_reasoning_attempt_count",
            "agentic.task_required_tool_receipt_coverage",
            "agentic.task_privacy_exposures_per_attempt",
            "agentic.task_total_cost_usd",
            "agentic.task_cost_per_success_usd",
            "agentic.recovery_pass_rate",
            "agentic.recovery_pass_rate_lower_95",
            "agentic.recovery_pair_count",
            "agentic.recovery_seed_count",
        ),
        evidence_levels=("E0", "E5"),
    ),
    CatalogTrack(
        id="multimodal",
        name="Multimodal",
        description="Capability-aware routing, grounding quality, and privacy signals.",
        modes=("replay", "live"),
        metrics=(
            "multimodal.support_rate",
            "multimodal.quality",
            "multimodal.privacy_violations",
        ),
        evidence_levels=("E0", "E4", "E5"),
    ),
    CatalogTrack(
        id="preference",
        name="Preference",
        description="Offline preference agreement and propensity-qualified online evidence.",
        modes=("replay", "live"),
        metrics=(
            "preference.agreement",
            "preference.propensity_coverage",
            "preference.effective_sample_size",
            "preference.effective_sample_ratio",
            "preference.self_normalized_ips_agreement",
            "preference.online_assignment_count",
            "preference.online_exposure_coverage",
            "preference.online_effective_sample_size",
            "preference.online_effective_sample_ratio",
            "preference.online_segment_coverage",
            "preference.online_target_snips_reward",
            "preference.online_reference_snips_reward",
            "preference.online_reward_lift",
            "preference.online_reward_lift_ci_lower_95",
            "preference.online_reward_lift_ci_upper_95",
            "preference.production_srm_p_value",
            "preference.production_risk_event_rate",
            "preference.production_risk_event_rate_upper_95",
            "preference.production_risk_budget_max_rate",
        ),
        evidence_levels=("E0", "E4", "E5"),
    ),
    CatalogTrack(
        id="safety",
        name="Safety",
        description="Policy adherence, blocking correctness, privacy, and unsafe regressions.",
        modes=("replay", "live"),
        metrics=(
            "safety.violation_rate",
            "safety.violation_case_rate",
            "safety.violation_upper_95",
            "safety.block_accuracy",
            "safety.false_negative_rate",
            "safety.false_positive_rate",
            "safety.hard_policy_static_passed",
            "safety.hard_policy_observation_count",
        ),
        evidence_levels=("E0", "E3", "E4"),
    ),
    CatalogTrack(
        id="capacity",
        name="Capacity",
        description=(
            "Repeated closed-loop throughput, tail latency, statistical error "
            "bounds, stability, SLO headroom, and measurement cost."
        ),
        modes=("replay", "live"),
        metrics=(
            "capacity.throughput_rps",
            "capacity.latency_p95_ms",
            "capacity.latency_p99_ms",
            "capacity.success_rate",
            "capacity.error_rate",
            "capacity.error_rate_upper_bound",
            "capacity.throughput_stability_cv_max",
            "capacity.latency_p95_stability_cv_max",
            "capacity.measurement_request_count",
            "capacity.warmup_error_count",
            "capacity.saturation_concurrency",
            "capacity.saturation_concurrency_lower_bound",
            "capacity.saturation_observed",
            "capacity.slo_headroom",
            "capacity.cost_per_successful_request",
            "capacity.success_concurrency_upper_bound",
        ),
        evidence_levels=("E0", "E5"),
    ),
)
