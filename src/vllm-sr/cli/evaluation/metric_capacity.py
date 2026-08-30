"""Metrics for recorded capacity observations and attested closed-loop profiles."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from cli.evaluation.capacity_profile import CapacityProfile, CapacityProfileLevel
from cli.evaluation.capacity_statistics import one_sided_wilson_upper
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.metric_core import _mean, _metric, _sum_complete, percentile
from cli.evaluation.reporting import EvaluationMetric

_RECORDED_SOURCE_SATURATION_THROUGHPUT_RATIO = 0.95
_RECORDED_SOURCE_SATURATION_ERROR_RATE = 0.05


def _measurement_cost(records: list[ExecutionRecord]) -> float | None:
    capacity_tco = _sum_complete(row.capacity_tco for row in records)
    return (
        capacity_tco
        if capacity_tco is not None
        else _sum_complete(row.runtime_cost for row in records)
    )


_CapacityMetricSpec = tuple[str, str, float | None, str, str, int]


def _profile_level_performance_specs(
    level: CapacityProfileLevel,
) -> tuple[_CapacityMetricSpec, ...]:
    success_rate = level.successes / level.measurement_requests
    return (
        (
            "throughput_rps",
            "Mean repeated-window throughput",
            level.throughput_rps,
            "requests/s",
            "higher_is_better",
            len(level.repetitions),
        ),
        (
            "throughput_cv",
            "Throughput coefficient of variation",
            level.throughput_cv,
            "ratio",
            "lower_is_better",
            len(level.repetitions),
        ),
        (
            "latency_p95_ms",
            "Measurement latency p95",
            level.latency_p95_ms,
            "ms",
            "lower_is_better",
            level.measurement_requests,
        ),
        (
            "latency_p99_ms",
            "Measurement latency p99",
            level.latency_p99_ms,
            "ms",
            "lower_is_better",
            level.measurement_requests,
        ),
        (
            "latency_p95_cv",
            "Latency p95 coefficient of variation",
            level.latency_p95_cv,
            "ratio",
            "lower_is_better",
            len(level.repetitions),
        ),
        (
            "success_rate",
            "Measurement success rate",
            success_rate,
            "fraction",
            "higher_is_better",
            level.measurement_requests,
        ),
        (
            "error_rate",
            "Measurement error rate",
            level.error_rate,
            "fraction",
            "lower_is_better",
            level.measurement_requests,
        ),
        (
            "error_rate_upper_bound",
            "One-sided 95% error-rate upper bound",
            level.error_rate_upper_bound,
            "fraction",
            "lower_is_better",
            level.measurement_requests,
        ),
    )


def _profile_level_protocol_specs(
    level: CapacityProfileLevel,
) -> tuple[_CapacityMetricSpec, ...]:
    return (
        (
            "elapsed_seconds",
            "Total measurement wall time",
            level.elapsed_seconds,
            "seconds",
            "lower_is_better",
            len(level.repetitions),
        ),
        (
            "measurement_request_count",
            "Measurement requests",
            float(level.measurement_requests),
            "requests",
            "target",
            level.measurement_requests,
        ),
        (
            "warmup_request_count",
            "Warmup requests",
            float(level.warmup_requests),
            "requests",
            "target",
            level.warmup_requests,
        ),
        (
            "warmup_error_count",
            "Warmup errors",
            float(level.warmup_errors),
            "errors",
            "lower_is_better",
            level.warmup_requests,
        ),
        (
            "runtime_cost_usd",
            "Measurement runtime cost",
            level.runtime_cost_usd,
            "USD",
            "lower_is_better",
            level.measurement_requests,
        ),
        (
            "throughput_scaling_efficiency",
            "Adjacent-level throughput scaling efficiency",
            level.throughput_scaling_efficiency,
            "ratio",
            "higher_is_better",
            (
                len(level.repetitions)
                if level.throughput_scaling_efficiency is not None
                else 0
            ),
        ),
        (
            "qualified",
            "Frozen SLO level qualification",
            1.0 if level.qualified else 0.0,
            "boolean",
            "target",
            level.measurement_requests,
        ),
    )


def _profile_level_metrics(level: CapacityProfileLevel) -> list[EvaluationMetric]:
    prefix = f"capacity.level.{level.concurrency}"
    specifications = (
        *_profile_level_performance_specs(level),
        *_profile_level_protocol_specs(level),
    )
    return [
        _metric(
            f"{prefix}.{suffix}",
            f"Concurrency {level.concurrency} {name}",
            "capacity",
            value,
            unit,
            direction,
            sample_count,
        )
        for suffix, name, value, unit, direction, sample_count in specifications
    ]


@dataclass(frozen=True)
class _ProfileSummaryStats:
    total_requests: int
    successes: int
    errors: int
    cost: float | None
    saturation: int | None
    qualified_error_levels: list[int]


def _profile_summary_stats(
    records: list[ExecutionRecord], profile: CapacityProfile
) -> _ProfileSummaryStats:
    measurement = [row for row in records if row.load_phase == "measurement"]
    total_requests = sum(level.measurement_requests for level in profile.levels)
    successes = sum(level.successes for level in profile.levels)
    cost = _measurement_cost(measurement)
    if cost is None:
        cost = sum(level.runtime_cost_usd for level in profile.levels)
    return _ProfileSummaryStats(
        total_requests=total_requests,
        successes=successes,
        errors=total_requests - successes,
        cost=cost,
        saturation=profile.assessment.saturation_concurrency,
        qualified_error_levels=[
            level.concurrency for level in profile.levels if level.error_slo_passed
        ],
    )


def _profile_summary_performance_specs(
    profile: CapacityProfile, stats: _ProfileSummaryStats
) -> tuple[_CapacityMetricSpec, ...]:
    return (
        (
            "capacity.throughput_rps",
            "Peak repeated-window throughput",
            max(level.throughput_rps for level in profile.levels),
            "requests/s",
            "higher_is_better",
            len(profile.levels),
        ),
        (
            "capacity.latency_p95_ms",
            "Worst measured-level latency p95",
            max(level.latency_p95_ms for level in profile.levels),
            "ms",
            "lower_is_better",
            stats.total_requests,
        ),
        (
            "capacity.latency_p99_ms",
            "Worst measured-level latency p99",
            max(level.latency_p99_ms for level in profile.levels),
            "ms",
            "lower_is_better",
            stats.total_requests,
        ),
        (
            "capacity.success_rate",
            "Measurement success rate",
            stats.successes / stats.total_requests,
            "fraction",
            "higher_is_better",
            stats.total_requests,
        ),
        (
            "capacity.error_rate",
            "Measurement error rate",
            stats.errors / stats.total_requests,
            "fraction",
            "lower_is_better",
            stats.total_requests,
        ),
        (
            "capacity.error_rate_upper_bound",
            "Worst one-sided 95% error-rate upper bound",
            max(level.error_rate_upper_bound for level in profile.levels),
            "fraction",
            "lower_is_better",
            stats.total_requests,
        ),
        (
            "capacity.throughput_stability_cv_max",
            "Worst throughput coefficient of variation",
            max(level.throughput_cv for level in profile.levels),
            "ratio",
            "lower_is_better",
            len(profile.levels),
        ),
        (
            "capacity.latency_p95_stability_cv_max",
            "Worst latency p95 coefficient of variation",
            max(level.latency_p95_cv for level in profile.levels),
            "ratio",
            "lower_is_better",
            len(profile.levels),
        ),
    )


def _profile_summary_envelope_specs(
    profile: CapacityProfile, stats: _ProfileSummaryStats
) -> tuple[_CapacityMetricSpec, ...]:
    return (
        (
            "capacity.measurement_request_count",
            "Frozen measurement requests",
            float(stats.total_requests),
            "requests",
            "target",
            stats.total_requests,
        ),
        (
            "capacity.warmup_error_count",
            "Warmup errors",
            float(sum(level.warmup_errors for level in profile.levels)),
            "errors",
            "lower_is_better",
            sum(level.warmup_requests for level in profile.levels),
        ),
        (
            "capacity.saturation_concurrency",
            "First unqualified concurrency",
            float(stats.saturation) if stats.saturation is not None else None,
            "concurrency",
            "higher_is_better",
            len(profile.levels),
        ),
        (
            "capacity.saturation_concurrency_lower_bound",
            "Measured saturation lower bound",
            float(stats.saturation or profile.levels[-1].concurrency),
            "concurrency",
            "higher_is_better",
            len(profile.levels),
        ),
        (
            "capacity.saturation_observed",
            "Saturation observed in the frozen load ladder",
            1.0 if stats.saturation is not None else 0.0,
            "boolean",
            "target",
            len(profile.levels),
        ),
        (
            "capacity.slo_headroom",
            "Qualified concurrency above the frozen SLO requirement",
            float(profile.assessment.slo_headroom),
            "concurrency",
            "higher_is_better",
            len(profile.levels),
        ),
        (
            "capacity.success_concurrency_upper_bound",
            "Highest concurrency meeting the one-sided error SLO",
            max(stats.qualified_error_levels) if stats.qualified_error_levels else None,
            "concurrency",
            "higher_is_better",
            len(profile.levels),
        ),
        (
            "capacity.cost_per_successful_request",
            "Measurement cost per successful request",
            (
                stats.cost / stats.successes
                if stats.cost is not None and stats.successes
                else None
            ),
            "USD/request",
            "lower_is_better",
            stats.successes,
        ),
    )


def _profile_summary_metrics(
    records: list[ExecutionRecord], profile: CapacityProfile
) -> list[EvaluationMetric]:
    stats = _profile_summary_stats(records, profile)
    specifications = (
        *_profile_summary_performance_specs(profile, stats),
        *_profile_summary_envelope_specs(profile, stats),
    )
    metrics = [
        _metric(metric_id, name, "capacity", value, unit, direction, sample_count)
        for metric_id, name, value, unit, direction, sample_count in specifications
    ]
    for level in profile.levels:
        metrics.extend(_profile_level_metrics(level))
    return metrics


def _recorded_source_saturation(
    by_level: dict[int, list[ExecutionRecord]],
) -> int | None:
    peak = 0.0
    for concurrency, rows in sorted(by_level.items()):
        throughput = max((row.throughput_rps or 0 for row in rows), default=0)
        errors = sum(row.success is False for row in rows) / len(rows) if rows else 0
        if peak and (
            throughput < peak * _RECORDED_SOURCE_SATURATION_THROUGHPUT_RATIO
            or errors > _RECORDED_SOURCE_SATURATION_ERROR_RATE
        ):
            return concurrency
        peak = max(peak, throughput)
    return None


def _recorded_level_metrics(
    concurrency: int, rows: list[ExecutionRecord]
) -> list[EvaluationMetric]:
    prefix = f"capacity.level.{concurrency}"
    latencies = [row.latency_ms for row in rows if row.latency_ms is not None]
    success, count = _mean(
        float(bool(row.success)) for row in rows if row.success is not None
    )
    throughput = max(
        (row.throughput_rps for row in rows if row.throughput_rps is not None),
        default=None,
    )
    elapsed = max(
        (
            row.load_elapsed_seconds
            for row in rows
            if row.load_elapsed_seconds is not None
        ),
        default=None,
    )
    values = (
        (
            "throughput_rps",
            "Recorded throughput",
            throughput,
            "requests/s",
            "higher_is_better",
            len(rows),
        ),
        (
            "latency_p95_ms",
            "Recorded latency p95",
            percentile(latencies, 0.95),
            "ms",
            "lower_is_better",
            len(latencies),
        ),
        (
            "latency_p99_ms",
            "Recorded latency p99",
            percentile(latencies, 0.99),
            "ms",
            "lower_is_better",
            len(latencies),
        ),
        (
            "success_rate",
            "Recorded success rate",
            success,
            "fraction",
            "higher_is_better",
            count,
        ),
        (
            "error_rate",
            "Recorded error rate",
            1 - success if success is not None else None,
            "fraction",
            "lower_is_better",
            count,
        ),
        (
            "elapsed_seconds",
            "Recorded elapsed time",
            elapsed,
            "seconds",
            "lower_is_better",
            len(rows),
        ),
        (
            "measurement_request_count",
            "Recorded observations",
            float(len(rows)),
            "requests",
            "target",
            len(rows),
        ),
        (
            "runtime_cost_usd",
            "Recorded runtime cost",
            _sum_complete(row.runtime_cost for row in rows),
            "USD",
            "lower_is_better",
            len(rows),
        ),
    )
    return [
        _metric(
            f"{prefix}.{suffix}",
            f"Concurrency {concurrency} {name}",
            "capacity",
            value,
            unit,
            direction,
            sample_count,
        )
        for suffix, name, value, unit, direction, sample_count in values
    ]


@dataclass(frozen=True)
class _RecordedSummaryStats:
    by_level: dict[int, list[ExecutionRecord]]
    latencies: list[float]
    throughputs: list[float]
    success: float | None
    count: int
    successes: int
    errors: int
    saturation: int | None
    successful_levels: list[int]
    cost: float | None


def _recorded_summary_stats(records: list[ExecutionRecord]) -> _RecordedSummaryStats:
    by_level: dict[int, list[ExecutionRecord]] = defaultdict(list)
    for row in records:
        if row.concurrency is not None:
            by_level[row.concurrency].append(row)
    success, count = _mean(
        float(bool(row.success)) for row in records if row.success is not None
    )
    successes = sum(row.success is True for row in records)
    return _RecordedSummaryStats(
        by_level=dict(by_level),
        latencies=[row.latency_ms for row in records if row.latency_ms is not None],
        throughputs=[
            row.throughput_rps for row in records if row.throughput_rps is not None
        ],
        success=success,
        count=count,
        successes=successes,
        errors=count - successes,
        saturation=_recorded_source_saturation(dict(by_level)),
        successful_levels=[
            concurrency
            for concurrency, rows in by_level.items()
            if rows
            and sum(row.success is True for row in rows) / len(rows)
            >= 1 - _RECORDED_SOURCE_SATURATION_ERROR_RATE
        ],
        cost=_measurement_cost(records),
    )


def _recorded_performance_specs(
    stats: _RecordedSummaryStats,
) -> tuple[_CapacityMetricSpec, ...]:
    return (
        (
            "capacity.throughput_rps",
            "Peak recorded-source throughput",
            max(stats.throughputs) if stats.throughputs else None,
            "requests/s",
            "higher_is_better",
            len(stats.throughputs),
        ),
        (
            "capacity.latency_p95_ms",
            "Recorded-source latency p95",
            percentile(stats.latencies, 0.95),
            "ms",
            "lower_is_better",
            len(stats.latencies),
        ),
        (
            "capacity.latency_p99_ms",
            "Recorded-source latency p99",
            percentile(stats.latencies, 0.99),
            "ms",
            "lower_is_better",
            len(stats.latencies),
        ),
        (
            "capacity.success_rate",
            "Measurement success rate",
            stats.success,
            "fraction",
            "higher_is_better",
            stats.count,
        ),
        (
            "capacity.error_rate",
            "Measurement error rate",
            1 - stats.success if stats.success is not None else None,
            "fraction",
            "lower_is_better",
            stats.count,
        ),
        (
            "capacity.error_rate_upper_bound",
            "Recorded-source one-sided 95% error-rate upper bound",
            one_sided_wilson_upper(stats.errors, stats.count) if stats.count else None,
            "fraction",
            "lower_is_better",
            stats.count,
        ),
        (
            "capacity.throughput_stability_cv_max",
            "Repeated-window throughput stability unavailable",
            None,
            "ratio",
            "lower_is_better",
            0,
        ),
        (
            "capacity.latency_p95_stability_cv_max",
            "Repeated-window latency stability unavailable",
            None,
            "ratio",
            "lower_is_better",
            0,
        ),
    )


def _recorded_envelope_specs(
    records: list[ExecutionRecord], stats: _RecordedSummaryStats
) -> tuple[_CapacityMetricSpec, ...]:
    return (
        (
            "capacity.measurement_request_count",
            "Recorded capacity observations",
            float(len(records)),
            "requests",
            "target",
            len(records),
        ),
        (
            "capacity.warmup_error_count",
            "Warmup evidence unavailable for recorded source",
            None,
            "errors",
            "lower_is_better",
            0,
        ),
        (
            "capacity.saturation_concurrency",
            "Recorded-source saturation indicator",
            float(stats.saturation) if stats.saturation is not None else None,
            "concurrency",
            "higher_is_better",
            len(stats.by_level),
        ),
        (
            "capacity.saturation_concurrency_lower_bound",
            "Highest tested recorded-source concurrency",
            float(stats.saturation or max(stats.by_level)) if stats.by_level else None,
            "concurrency",
            "higher_is_better",
            len(stats.by_level),
        ),
        (
            "capacity.saturation_observed",
            "Recorded-source saturation observed",
            1.0 if stats.saturation is not None else 0.0,
            "boolean",
            "target",
            len(stats.by_level),
        ),
        (
            "capacity.slo_headroom",
            "Qualified concurrency above the frozen SLO requirement",
            None,
            "concurrency",
            "higher_is_better",
            0,
        ),
        (
            "capacity.success_concurrency_upper_bound",
            "Highest recorded concurrency below the diagnostic error threshold",
            float(max(stats.successful_levels)) if stats.successful_levels else None,
            "concurrency",
            "higher_is_better",
            len(stats.by_level),
        ),
        (
            "capacity.cost_per_successful_request",
            "Recorded cost per successful request",
            (
                stats.cost / stats.successes
                if stats.cost is not None and stats.successes
                else None
            ),
            "USD/request",
            "lower_is_better",
            stats.successes,
        ),
    )


def _recorded_source_metrics(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    stats = _recorded_summary_stats(records)
    specifications = (
        *_recorded_performance_specs(stats),
        *_recorded_envelope_specs(records, stats),
    )
    metrics = [
        _metric(metric_id, name, "capacity", value, unit, direction, sample_count)
        for metric_id, name, value, unit, direction, sample_count in specifications
    ]
    for concurrency, rows in sorted(stats.by_level.items()):
        metrics.extend(_recorded_level_metrics(concurrency, rows))
    return metrics


def _capacity(
    records: list[ExecutionRecord], profile: CapacityProfile | None
) -> list[EvaluationMetric]:
    if profile is not None:
        return _profile_summary_metrics(records, profile)
    return _recorded_source_metrics(records)
