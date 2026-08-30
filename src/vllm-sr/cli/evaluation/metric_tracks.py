"""Agentic, multimodal, preference, safety, and capacity metrics."""

from __future__ import annotations

from collections import defaultdict

from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.metric_core import (
    _mean,
    _metric,
    _sum_complete,
    _wilson,
)
from cli.evaluation.reporting import EvaluationMetric


def _agentic(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    # G6 fault-recovery rows measure continuity under injected faults. They are
    # intentionally excluded from general task/trajectory quality reduction.
    records = [row for row in records if row.recovery is None]
    success, success_count = _mean(
        float(bool(row.success)) for row in records if row.success is not None
    )
    quality, quality_count = _mean(
        row.quality for row in records if row.quality is not None
    )
    tool_calls = sum(row.tool_calls or 0 for row in records)
    invalid_calls = sum(row.invalid_tool_calls or 0 for row in records)
    steps = [
        row.trajectory_steps for row in records if row.trajectory_steps is not None
    ]
    privacy = [
        row.privacy_violations for row in records if row.privacy_violations is not None
    ]
    successful = sum(row.success is True for row in records)
    runtime_cost = _sum_complete(row.runtime_cost for row in records)
    return [
        _metric(
            "agentic.success_rate",
            "Trajectory success rate",
            "agentic",
            success,
            "fraction",
            "higher_is_better",
            success_count,
        ),
        _metric(
            "agentic.task_score",
            "Trajectory task score",
            "agentic",
            quality,
            "score",
            "higher_is_better",
            quality_count,
        ),
        _metric(
            "agentic.invalid_tool_rate",
            "Invalid tool-call rate",
            "agentic",
            invalid_calls / tool_calls if tool_calls else None,
            "fraction",
            "lower_is_better",
            tool_calls,
        ),
        _metric(
            "agentic.mean_trajectory_steps",
            "Mean trajectory steps",
            "agentic",
            sum(steps) / len(steps) if steps else None,
            "steps",
            "target",
            len(steps),
        ),
        _metric(
            "agentic.privacy_exposures_per_trajectory",
            "Privacy exposures per trajectory",
            "agentic",
            sum(privacy) / len(privacy) if privacy else None,
            "exposures/trajectory",
            "lower_is_better",
            len(privacy),
        ),
        _metric(
            "agentic.runtime_cost_per_success",
            "Runtime cost per successful trajectory",
            "agentic",
            (
                runtime_cost / successful
                if runtime_cost is not None and successful
                else None
            ),
            "USD/success",
            "lower_is_better",
            successful,
        ),
    ]


def _multimodal(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    support, support_count = _mean(
        float(bool(row.success)) for row in records if row.success is not None
    )
    quality, quality_count = _mean(
        row.quality for row in records if row.quality is not None
    )
    privacy_values = [
        row.privacy_violations for row in records if row.privacy_violations is not None
    ]
    metrics = [
        _metric(
            "multimodal.support_rate",
            "Multimodal support rate",
            "multimodal",
            support,
            "fraction",
            "higher_is_better",
            support_count,
        ),
        _metric(
            "multimodal.quality",
            "Multimodal quality",
            "multimodal",
            quality,
            "score",
            "higher_is_better",
            quality_count,
        ),
        _metric(
            "multimodal.privacy_violations",
            "Multimodal privacy violations",
            "multimodal",
            float(sum(privacy_values)) if privacy_values else None,
            "count",
            "lower_is_better",
            len(privacy_values),
        ),
    ]
    by_modality: dict[str, list[ExecutionRecord]] = defaultdict(list)
    for record in records:
        if record.modality:
            by_modality[record.modality].append(record)
    for modality, rows in sorted(by_modality.items()):
        modality_support, modality_support_count = _mean(
            float(row.success) for row in rows if row.success is not None
        )
        modality_quality, modality_quality_count = _mean(
            row.quality for row in rows if row.quality is not None
        )
        metrics.extend(
            (
                _metric(
                    f"multimodal.{modality}.support_rate",
                    f"{modality.title()} support rate",
                    "multimodal",
                    modality_support,
                    "fraction",
                    "higher_is_better",
                    modality_support_count,
                ),
                _metric(
                    f"multimodal.{modality}.quality",
                    f"{modality.title()} quality",
                    "multimodal",
                    modality_quality,
                    "score",
                    "higher_is_better",
                    modality_quality_count,
                ),
            )
        )
    return metrics


def _preference(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    matches, match_count = _mean(
        float(bool(row.preference_match))
        for row in records
        if row.preference_match is not None
    )
    propensity_count = sum(row.behavior_propensity is not None for row in records)
    propensity_rows = [
        row
        for row in records
        if row.behavior_propensity is not None and row.preference_match is not None
    ]
    inverse_weights = [1.0 / row.behavior_propensity for row in propensity_rows]
    weight_sum = sum(inverse_weights)
    effective_sample_size = (
        weight_sum * weight_sum / sum(weight * weight for weight in inverse_weights)
        if inverse_weights
        else None
    )
    weighted_agreement = (
        sum(
            weight * float(bool(row.preference_match))
            for row, weight in zip(propensity_rows, inverse_weights, strict=True)
        )
        / weight_sum
        if weight_sum
        else None
    )
    return [
        _metric(
            "preference.agreement",
            "Offline preference agreement",
            "preference",
            matches,
            "fraction",
            "higher_is_better",
            match_count,
        ),
        _metric(
            "preference.propensity_coverage",
            "Behavior propensity coverage",
            "preference",
            propensity_count / len(records) if records else None,
            "fraction",
            "higher_is_better",
            len(records),
        ),
        _metric(
            "preference.effective_sample_size",
            "Inverse-propensity effective sample size",
            "preference",
            effective_sample_size,
            "effective samples",
            "higher_is_better",
            len(propensity_rows),
        ),
        _metric(
            "preference.effective_sample_ratio",
            "Effective-sample ratio",
            "preference",
            (
                effective_sample_size / len(propensity_rows)
                if effective_sample_size is not None and propensity_rows
                else None
            ),
            "fraction",
            "higher_is_better",
            len(propensity_rows),
        ),
        _metric(
            "preference.self_normalized_ips_agreement",
            "Self-normalized IPS agreement",
            "preference",
            weighted_agreement,
            "fraction",
            "higher_is_better",
            len(propensity_rows),
        ),
    ]


def _safety(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    violations = sum(row.safety_violations or 0 for row in records)
    block_rows = [
        row
        for row in records
        if row.should_block is not None and row.blocked is not None
    ]
    block_accuracy = (
        sum(row.should_block == row.blocked for row in block_rows) / len(block_rows)
        if block_rows
        else None
    )
    violation_cases = sum((row.safety_violations or 0) > 0 for row in records)
    violation_fraction = violation_cases / len(records) if records else None
    upper_bound = _wilson(violation_cases, len(records))[1] if records else None
    positive_rows = [row for row in block_rows if row.should_block is True]
    negative_rows = [row for row in block_rows if row.should_block is False]
    false_negative_rate = (
        sum(row.blocked is False for row in positive_rows) / len(positive_rows)
        if positive_rows
        else None
    )
    false_positive_rate = (
        sum(row.blocked is True for row in negative_rows) / len(negative_rows)
        if negative_rows
        else None
    )
    return [
        _metric(
            "safety.violation_rate",
            "Safety violation rate",
            "safety",
            violations / len(records) if records else None,
            "violations/case",
            "lower_is_better",
            len(records),
        ),
        _metric(
            "safety.violation_case_rate",
            "Cases with a safety violation",
            "safety",
            violation_fraction,
            "fraction",
            "lower_is_better",
            len(records),
        ),
        _metric(
            "safety.violation_upper_95",
            "Safety violation-rate 95% upper bound",
            "safety",
            upper_bound,
            "fraction",
            "lower_is_better",
            len(records),
        ),
        _metric(
            "safety.block_accuracy",
            "Blocking decision accuracy",
            "safety",
            block_accuracy,
            "fraction",
            "higher_is_better",
            len(block_rows),
        ),
        _metric(
            "safety.false_negative_rate",
            "Unsafe cases not blocked",
            "safety",
            false_negative_rate,
            "fraction",
            "lower_is_better",
            len(positive_rows),
        ),
        _metric(
            "safety.false_positive_rate",
            "Safe cases incorrectly blocked",
            "safety",
            false_positive_rate,
            "fraction",
            "lower_is_better",
            len(negative_rows),
        ),
    ]
