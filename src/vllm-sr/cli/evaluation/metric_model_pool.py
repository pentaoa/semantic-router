"""Model-pool metric reducers."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import combinations
from math import log2

from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.metric_core import (
    _canonical_ordered_float_sum,
    _mean,
    _metric,
)
from cli.evaluation.reporting import EvaluationMetric

_MIN_DENSE_POOL_ARMS = 2


@dataclass(frozen=True)
class _PoolStats:
    by_case: dict[str, list[ExecutionRecord]]
    by_arm: dict[str, list[ExecutionRecord]]
    oracle_values: list[float]
    unique_wins: int
    marginal: dict[str, list[float]]
    best_single: float | None
    oracle_quality: float | None
    selected: list[str]
    selection_counts: dict[str, int]
    selection_entropy: float | None
    dominated_arms: int
    pareto_evaluable_arms: int
    pareto_dominated_arms: int
    mean_failure_jaccard: float | None
    all_arm_failure_cases: int
    worst_arm_reliability: float | None


def outcome_quality(record: ExecutionRecord) -> float | None:
    """Score every attempted outcome without rewarding execution failures.

    A failed request is an observed zero-quality outcome, even when no grader
    output exists. Successful but ungraded requests remain unavailable rather
    than being invented as zero.
    """

    if record.status == "failed" or record.success is False:
        return 0.0
    return record.quality


def _group_pool_records(
    records: list[ExecutionRecord],
) -> tuple[dict[str, list[ExecutionRecord]], dict[str, list[ExecutionRecord]]]:
    by_case: dict[str, list[ExecutionRecord]] = defaultdict(list)
    by_arm: dict[str, list[ExecutionRecord]] = defaultdict(list)
    for record in records:
        by_case[record.case_id].append(record)
        if record.arm_id:
            by_arm[record.arm_id].append(record)
    return dict(by_case), dict(by_arm)


def _oracle_stats(
    by_case: dict[str, list[ExecutionRecord]],
    arm_ids: tuple[str, ...],
) -> tuple[list[float], int, dict[str, list[float]]]:
    oracle_values: list[float] = []
    unique_wins = 0
    marginal: dict[str, list[float]] = defaultdict(list)
    for rows in by_case.values():
        qualified = [
            (row, quality)
            for row in rows
            if (quality := outcome_quality(row)) is not None
        ]
        # Live Mixture execution is dense over case x frozen arm. Preserve that
        # cohort in the reducer: one ungraded successful arm makes this case's
        # oracle unavailable instead of shrinking it to the surviving arms.
        if not qualified or len(qualified) != len(rows):
            continue
        best = max(quality for _, quality in qualified)
        oracle_values.append(best)
        if sum(quality == best for _, quality in qualified) == 1:
            unique_wins += 1
        for arm_id in arm_ids:
            alternatives = [
                quality for row, quality in qualified if row.arm_id != arm_id
            ]
            if alternatives:
                marginal[arm_id].append(best - max(alternatives))
    return oracle_values, unique_wins, dict(marginal)


def _arm_quality_stats(
    by_arm: dict[str, list[ExecutionRecord]],
) -> float | None:
    arm_quality: dict[str, float | None] = {}
    for arm_id, rows in by_arm.items():
        values = [
            quality for row in rows if (quality := outcome_quality(row)) is not None
        ]
        arm_quality[arm_id] = (
            _canonical_ordered_float_sum(values) / len(values)
            if values and len(values) == len(rows)
            else None
        )
    best_single = max(
        (quality for quality in arm_quality.values() if quality is not None),
        default=None,
    )
    return best_single


def _selection_stats(
    joint_records: list[ExecutionRecord], by_arm: dict[str, list[ExecutionRecord]]
) -> tuple[list[str], dict[str, int], float | None]:
    selected = [
        row.selected_arm_id
        for row in joint_records
        if row.selected_arm_id and row.selected_arm_id in by_arm
    ]
    selection_counts = dict(Counter(selected))
    selection_entropy = (
        -sum(
            (count / len(selected)) * log2(count / len(selected))
            for count in selection_counts.values()
        )
        if selected
        else None
    )
    return selected, selection_counts, selection_entropy


def _reliability_stats(
    by_case: dict[str, list[ExecutionRecord]],
    by_arm: dict[str, list[ExecutionRecord]],
) -> tuple[int, float | None]:
    all_arm_failure_cases = sum(
        not any(row.success is True for row in rows) for rows in by_case.values()
    )
    frozen_arm_ids = set(by_arm)
    dense_reliability_cohort = (
        bool(by_case)
        and len(frozen_arm_ids) >= _MIN_DENSE_POOL_ARMS
        and all(
            len(rows) == len(frozen_arm_ids)
            and {row.arm_id for row in rows} == frozen_arm_ids
            and all(row.success is not None for row in rows)
            for rows in by_case.values()
        )
    )
    arm_reliability = (
        [
            _canonical_ordered_float_sum(float(bool(row.success)) for row in rows)
            / len(rows)
            for rows in by_arm.values()
        ]
        if dense_reliability_cohort
        else []
    )
    worst_arm_reliability = (
        min(arm_reliability)
        if arm_reliability and len(arm_reliability) == len(by_arm)
        else None
    )
    return all_arm_failure_cases, worst_arm_reliability


def _pool_stats(
    records: list[ExecutionRecord], joint_records: list[ExecutionRecord]
) -> _PoolStats:
    by_case, by_arm = _group_pool_records(records)
    oracle_values, unique_wins, marginal = _oracle_stats(by_case, tuple(by_arm))
    best_single = _arm_quality_stats(by_arm)
    oracle_quality = sum(oracle_values) / len(oracle_values) if oracle_values else None
    selected, selection_counts, selection_entropy = _selection_stats(
        joint_records, by_arm
    )
    dominated_arms = _quality_dominated_arm_count(by_case, tuple(sorted(by_arm)))
    pareto_evaluable_arms, pareto_dominated_arms = _quality_cost_pareto_counts(
        dict(by_arm)
    )
    mean_failure_jaccard = _mean_pairwise_failure_jaccard(dict(by_arm))
    all_arm_failure_cases, worst_arm_reliability = _reliability_stats(by_case, by_arm)
    return _PoolStats(
        by_case=dict(by_case),
        by_arm=dict(by_arm),
        oracle_values=oracle_values,
        unique_wins=unique_wins,
        marginal=dict(marginal),
        best_single=best_single,
        oracle_quality=oracle_quality,
        selected=selected,
        selection_counts=selection_counts,
        selection_entropy=selection_entropy,
        dominated_arms=dominated_arms,
        pareto_evaluable_arms=pareto_evaluable_arms,
        pareto_dominated_arms=pareto_dominated_arms,
        mean_failure_jaccard=mean_failure_jaccard,
        all_arm_failure_cases=all_arm_failure_cases,
        worst_arm_reliability=worst_arm_reliability,
    )


def _quality_dominated_arm_count(
    by_case: dict[str, list[ExecutionRecord]], arm_ids: tuple[str, ...]
) -> int:
    quality_by_arm: dict[str, dict[str, float]] = {}
    for arm_id in arm_ids:
        values: dict[str, float] = {}
        complete = True
        for rows in by_case.values():
            matched = [row for row in rows if row.arm_id == arm_id]
            if len(matched) != 1 or (quality := outcome_quality(matched[0])) is None:
                complete = False
                break
            values[matched[0].case_id] = quality
        quality_by_arm[arm_id] = values if complete else {}
    dominated = 0
    for arm_id in arm_ids:
        candidate = quality_by_arm[arm_id]
        if not candidate:
            continue
        for competitor_id in arm_ids:
            if competitor_id == arm_id:
                continue
            competitor = quality_by_arm[competitor_id]
            if set(competitor) != set(candidate):
                continue
            if all(
                competitor[case_id] >= value for case_id, value in candidate.items()
            ) and any(
                competitor[case_id] > value for case_id, value in candidate.items()
            ):
                dominated += 1
                break
    return dominated


def _one_row_per_case(
    rows: list[ExecutionRecord],
) -> dict[str, ExecutionRecord] | None:
    by_case: dict[str, ExecutionRecord] = {}
    for row in rows:
        if row.case_id in by_case:
            return None
        by_case[row.case_id] = row
    return by_case or None


def _quality_cost_pareto_counts(
    by_arm: dict[str, list[ExecutionRecord]],
) -> tuple[int, int]:
    summaries: dict[str, tuple[frozenset[str], float, float]] = {}
    for arm_id, rows in by_arm.items():
        case_rows = _one_row_per_case(rows)
        if case_rows is None or any(
            outcome_quality(row) is None or row.runtime_cost is None
            for row in case_rows.values()
        ):
            continue
        summaries[arm_id] = (
            frozenset(case_rows),
            _canonical_ordered_float_sum(
                quality
                for row in case_rows.values()
                if (quality := outcome_quality(row)) is not None
            )
            / len(case_rows),
            _canonical_ordered_float_sum(
                row.runtime_cost
                for row in case_rows.values()
                if row.runtime_cost is not None
            )
            / len(case_rows),
        )
    dominated = 0
    for arm_id, (case_ids, quality, cost) in summaries.items():
        if any(
            competitor_id != arm_id
            and competitor_cases == case_ids
            and competitor_quality >= quality
            and competitor_cost <= cost
            and (competitor_quality > quality or competitor_cost < cost)
            for competitor_id, (
                competitor_cases,
                competitor_quality,
                competitor_cost,
            ) in summaries.items()
        ):
            dominated += 1
    return len(summaries), dominated


def _mean_pairwise_failure_jaccard(
    by_arm: dict[str, list[ExecutionRecord]],
) -> float | None:
    comparable: dict[str, dict[str, bool]] = {}
    for arm_id, rows in by_arm.items():
        case_rows = _one_row_per_case(rows)
        if case_rows is None or any(row.success is None for row in case_rows.values()):
            continue
        comparable[arm_id] = {
            case_id: row.success is False for case_id, row in case_rows.items()
        }
    overlaps: list[float] = []
    for left_id, right_id in combinations(sorted(comparable), 2):
        left, right = comparable[left_id], comparable[right_id]
        if set(left) != set(right):
            continue
        left_failures = {case_id for case_id, failed in left.items() if failed}
        right_failures = {case_id for case_id, failed in right.items() if failed}
        union = left_failures | right_failures
        overlaps.append(
            len(left_failures & right_failures) / len(union) if union else 0.0
        )
    return _canonical_ordered_float_sum(overlaps) / len(overlaps) if overlaps else None


_MetricSpec = tuple[str, str, float | None, str, str, int]


def _pool_quality_metric_specs(stats: _PoolStats) -> tuple[_MetricSpec, ...]:
    return (
        (
            "model_pool.arm_count",
            "Observed model arms",
            float(len(stats.by_arm)) if stats.by_arm else None,
            "arms",
            "target",
            len(stats.by_case),
        ),
        (
            "model_pool.oracle_quality",
            "Pool oracle quality",
            stats.oracle_quality,
            "score",
            "higher_is_better",
            len(stats.oracle_values),
        ),
        (
            "model_pool.unique_wins",
            "Cases with a unique winning arm",
            float(stats.unique_wins) if stats.by_case else None,
            "cases",
            "higher_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.unique_win_rate",
            "Unique-win case rate",
            (
                stats.unique_wins / len(stats.oracle_values)
                if stats.oracle_values
                else None
            ),
            "fraction",
            "higher_is_better",
            len(stats.oracle_values),
        ),
        (
            "model_pool.best_single_quality",
            "Best single-arm quality",
            stats.best_single,
            "score",
            "higher_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.oracle_gain",
            "Oracle gain over best single arm",
            (
                stats.oracle_quality - stats.best_single
                if stats.oracle_quality is not None and stats.best_single is not None
                else None
            ),
            "score",
            "higher_is_better",
            len(stats.oracle_values),
        ),
        (
            "model_pool.selection_entropy_bits",
            "Arm selection entropy",
            stats.selection_entropy,
            "bits",
            "target",
            len(stats.selected),
        ),
        (
            "model_pool.selection_arm_coverage",
            "Selected-arm coverage",
            len(stats.selection_counts) / len(stats.by_arm) if stats.by_arm else None,
            "fraction",
            "higher_is_better",
            len(stats.selected),
        ),
    )


def _pool_diversity_metric_specs(stats: _PoolStats) -> tuple[_MetricSpec, ...]:
    return (
        (
            "model_pool.quality_dominated_arm_count",
            "Quality-dominated arms on complete common cases",
            float(stats.dominated_arms) if stats.by_arm else None,
            "arms",
            "lower_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.pareto_evaluable_arm_count",
            "Arms with complete comparable quality and cost",
            float(stats.pareto_evaluable_arms),
            "arms",
            "higher_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.pareto_dominated_arm_count",
            "Quality-cost Pareto-dominated arms",
            (
                float(stats.pareto_dominated_arms)
                if stats.pareto_evaluable_arms >= _MIN_DENSE_POOL_ARMS
                else None
            ),
            "arms",
            "lower_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.mean_pairwise_failure_jaccard",
            "Mean pairwise arm failure overlap",
            stats.mean_failure_jaccard,
            "fraction",
            "lower_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.worst_arm_reliability",
            "Reliability of the least reliable frozen arm",
            stats.worst_arm_reliability,
            "fraction",
            "higher_is_better",
            len(stats.by_case),
        ),
        (
            "model_pool.all_arm_failure_rate",
            "Cases where every arm failed",
            stats.all_arm_failure_cases / len(stats.by_case) if stats.by_case else None,
            "fraction",
            "lower_is_better",
            len(stats.by_case),
        ),
    )


def _pool_summary_metrics(stats: _PoolStats) -> list[EvaluationMetric]:
    specifications = (
        *_pool_quality_metric_specs(stats),
        *_pool_diversity_metric_specs(stats),
    )
    return [
        _metric(metric_id, name, "model_pool", value, unit, direction, sample_count)
        for metric_id, name, value, unit, direction, sample_count in specifications
    ]


def _pool_arm_metrics(stats: _PoolStats) -> list[EvaluationMetric]:
    metrics: list[EvaluationMetric] = []
    for arm_id in sorted(stats.by_arm):
        rows = stats.by_arm[arm_id]
        quality_values = [
            value for row in rows if (value := outcome_quality(row)) is not None
        ]
        quality = (
            _canonical_ordered_float_sum(quality_values) / len(quality_values)
            if quality_values and len(quality_values) == len(rows)
            else None
        )
        quality_count = len(quality_values) if quality is not None else 0
        success, success_count = _mean(
            float(bool(row.success)) for row in rows if row.success is not None
        )
        metrics.extend(
            [
                _metric(
                    f"model_pool.arm.{arm_id}.quality",
                    f"{arm_id} quality",
                    "model_pool",
                    quality,
                    "score",
                    "higher_is_better",
                    quality_count,
                ),
                _metric(
                    f"model_pool.arm.{arm_id}.success_rate",
                    f"{arm_id} success rate",
                    "model_pool",
                    success,
                    "fraction",
                    "higher_is_better",
                    success_count,
                ),
                _metric(
                    f"model_pool.arm.{arm_id}.marginal_contribution",
                    f"{arm_id} marginal contribution",
                    "model_pool",
                    (
                        sum(stats.marginal.get(arm_id, []))
                        / len(stats.marginal[arm_id])
                        if stats.marginal.get(arm_id)
                        else None
                    ),
                    "score",
                    "higher_is_better",
                    len(stats.marginal.get(arm_id, [])),
                ),
            ]
        )
    return metrics


def model_pool_metrics(
    records: list[ExecutionRecord], joint_records: list[ExecutionRecord]
) -> list[EvaluationMetric]:
    stats = _pool_stats(records, joint_records)
    return _pool_summary_metrics(stats) + _pool_arm_metrics(stats)
