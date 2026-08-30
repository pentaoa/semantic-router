"""Dispatch normalized evidence to narrow track-specific metric reducers."""

from __future__ import annotations

from cli.evaluation.capacity_profile import CapacityProfile
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.metric_capacity import _capacity
from cli.evaluation.metric_core import coverage, percentile
from cli.evaluation.metric_joint import joint_metrics
from cli.evaluation.metric_methods import method_metrics
from cli.evaluation.metric_model_pool import model_pool_metrics
from cli.evaluation.metric_routing import routing_metrics
from cli.evaluation.metric_tracks import _agentic, _multimodal, _preference, _safety
from cli.evaluation.reporting import EvaluationMetric

__all__ = ["compute_metrics", "coverage", "percentile"]


def compute_metrics(
    records: list[ExecutionRecord],
    *,
    capacity_profile: CapacityProfile | None,
) -> list[EvaluationMetric]:
    by_track = {
        track: [
            row
            for row in records
            if row.track_id == track and row.status != "unavailable"
        ]
        for track in (
            "routing",
            "model_pool",
            "joint",
            "agentic",
            "multimodal",
            "preference",
            "safety",
            "capacity",
        )
    }
    metrics: list[EvaluationMetric] = []
    metrics.extend(routing_metrics(by_track["routing"]))
    metrics.extend(model_pool_metrics(by_track["model_pool"], by_track["joint"]))
    metrics.extend(joint_metrics(by_track["joint"], by_track["model_pool"]))
    metrics.extend(_agentic(by_track["agentic"]))
    metrics.extend(_multimodal(by_track["multimodal"]))
    metrics.extend(_preference(by_track["preference"]))
    metrics.extend(_safety(by_track["safety"]))
    metrics.extend(_capacity(by_track["capacity"], capacity_profile))
    metrics.extend(
        method_metrics([row for row in records if row.status != "unavailable"])
    )
    return metrics
