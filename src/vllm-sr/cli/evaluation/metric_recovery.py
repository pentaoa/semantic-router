"""Server-portable live exact-step fault-recovery reduction."""

from __future__ import annotations

from dataclasses import dataclass

from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.method_evidence import RecoveryMethodEvidence
from cli.evaluation.metric_core import _metric
from cli.evaluation.reporting import EvaluationMetric

MINIMUM_RECOVERY_PASS_RATE_LOWER_BOUND = 0.8
_ONE_SIDED_95_Z = 1.6448536269514722


def _one_sided_wilson_lower(successes: int, total: int) -> float | None:
    if total <= 0:
        return None
    proportion = successes / total
    z_squared = _ONE_SIDED_95_Z * _ONE_SIDED_95_Z
    denominator = 1 + z_squared / total
    center = proportion + z_squared / (2 * total)
    margin = _ONE_SIDED_95_Z * (
        (proportion * (1 - proportion) / total + z_squared / (4 * total * total)) ** 0.5
    )
    return max(0.0, (center - margin) / denominator)


@dataclass(frozen=True)
class RecoveryReduction:
    pair_count: int
    pass_rate: float | None
    pass_rate_lower_confidence_bound: float | None
    treatment_success_rate: float | None
    baseline_success_rate: float | None
    success_delta: float | None
    mean_latency_delta_ms: float | None
    maximum_retry_amplification: float | None
    maximum_recovery_latency_ms: float | None
    maximum_retry_amplification_threshold: float | None
    distinct_seed_count: int
    minimum_distinct_seed_count: int | None
    minimum_pair_count: int | None
    passed: bool | None
    target_id: str | None
    backend_topology_digest: str | None
    mixture_snapshot_digest: str | None


def _validate_recovery_contract(
    method: RecoveryMethodEvidence,
    first: RecoveryMethodEvidence | None,
    policy_snapshot_digest: str | None,
    config_digest: str | None,
) -> None:
    if method.method_id != "live-fault-recovery.v1":
        raise ValueError("recovery evidence uses an unsupported method")
    if first is None:
        if (
            policy_snapshot_digest is not None
            and method.policy_snapshot_digest != policy_snapshot_digest
        ) or (config_digest is not None and method.config_digest != config_digest):
            raise ValueError("fault-recovery ledger belongs to another snapshot")
        return
    if any(
        (
            method.ledger_id != first.ledger_id,
            method.source_id != first.source_id,
            method.policy_snapshot_digest != first.policy_snapshot_digest,
            method.config_digest != first.config_digest,
            method.target_id != first.target_id,
            method.backend_topology_digest != first.backend_topology_digest,
            method.mixture_snapshot_digest != first.mixture_snapshot_digest,
            method.ledger_total_pair_count != first.ledger_total_pair_count,
            method.minimum_pair_count != first.minimum_pair_count,
            method.minimum_distinct_seed_count != first.minimum_distinct_seed_count,
            method.maximum_recovery_latency_ms != first.maximum_recovery_latency_ms,
            method.maximum_retry_amplification != first.maximum_retry_amplification,
        )
    ):
        raise ValueError("recovery records mix sealed ledger contracts")


def _recovery_outcome(method: RecoveryMethodEvidence) -> tuple[bool, float]:
    retry_amplification = (method.treatment_retry_count + 1) / (
        method.baseline_retry_count + 1
    )
    passed = (
        method.injection_observed
        and method.recovered
        and method.state_preserved
        and method.treatment_terminal_success
        and method.duplicate_side_effect_count == 0
        and method.treatment_recovery_latency_ms <= method.maximum_recovery_latency_ms
        and retry_amplification <= method.maximum_retry_amplification
    )
    return passed, retry_amplification


def reduce_recovery(
    records: list[ExecutionRecord],
    *,
    policy_snapshot_digest: str | None = None,
    config_digest: str | None = None,
) -> RecoveryReduction:
    fault_ids: set[str] = set()
    pair_ids: set[tuple[str, str]] = set()
    seeds: set[int] = set()
    passes: list[bool] = []
    baseline_successes: list[bool] = []
    treatment_successes: list[bool] = []
    latency_deltas: list[float] = []
    retry_amplifications: list[float] = []
    first = None
    for row in records:
        method = row.recovery
        if row.track_id != "agentic" or method is None:
            continue
        _validate_recovery_contract(
            method,
            first,
            policy_snapshot_digest,
            config_digest,
        )
        if first is None:
            first = method
        pair_id = (method.cohort_pair_id, method.repetition_id)
        if method.fault_id in fault_ids or pair_id in pair_ids:
            raise ValueError("recovery reduction received a duplicate live pair")
        fault_ids.add(method.fault_id)
        pair_ids.add(pair_id)
        seeds.add(method.seed)
        passed, retry_amplification = _recovery_outcome(method)
        if row.success is not passed:
            raise ValueError("agentic result does not bind its recovery evidence")
        passes.append(passed)
        baseline_successes.append(method.baseline_terminal_success)
        treatment_successes.append(method.treatment_terminal_success)
        latency_deltas.append(
            method.treatment_recovery_latency_ms - method.baseline_recovery_latency_ms
        )
        retry_amplifications.append(retry_amplification)
    count = len(passes)
    pass_rate = sum(passes) / count if count else None
    pass_rate_lower_bound = _one_sided_wilson_lower(sum(passes), count)
    baseline_rate = sum(baseline_successes) / count if count else None
    treatment_rate = sum(treatment_successes) / count if count else None
    complete = (
        first is not None
        and count == first.ledger_total_pair_count
        and count >= first.minimum_pair_count
        and len(seeds) >= first.minimum_distinct_seed_count
    )
    return RecoveryReduction(
        pair_count=count,
        pass_rate=pass_rate,
        pass_rate_lower_confidence_bound=pass_rate_lower_bound,
        treatment_success_rate=treatment_rate,
        baseline_success_rate=baseline_rate,
        success_delta=(treatment_rate - baseline_rate if count else None),
        mean_latency_delta_ms=(sum(latency_deltas) / count if count else None),
        maximum_retry_amplification=(max(retry_amplifications) if count else None),
        maximum_recovery_latency_ms=(
            first.maximum_recovery_latency_ms if first is not None else None
        ),
        maximum_retry_amplification_threshold=(
            first.maximum_retry_amplification if first is not None else None
        ),
        distinct_seed_count=len(seeds),
        minimum_distinct_seed_count=(
            first.minimum_distinct_seed_count if first is not None else None
        ),
        minimum_pair_count=(first.minimum_pair_count if first is not None else None),
        passed=(
            pass_rate_lower_bound >= MINIMUM_RECOVERY_PASS_RATE_LOWER_BOUND
            if complete and pass_rate_lower_bound is not None
            else None
        ),
        target_id=first.target_id if first is not None else None,
        backend_topology_digest=(
            first.backend_topology_digest if first is not None else None
        ),
        mixture_snapshot_digest=(
            first.mixture_snapshot_digest if first is not None else None
        ),
    )


def _recovery_metric_specs(
    reduced: RecoveryReduction,
) -> tuple[tuple[str, str, float | None, str, str], ...]:
    return (
        (
            "agentic.recovery_pair_count",
            "Live fault-recovery pair count",
            float(reduced.pair_count) if reduced.pair_count else None,
            "pairs",
            "higher_is_better",
        ),
        (
            "agentic.recovery_pass_rate",
            "Injected-failover recovery pass rate",
            reduced.pass_rate,
            "fraction",
            "higher_is_better",
        ),
        (
            "agentic.recovery_pass_rate_lower_95",
            "One-sided 95% recovery pass-rate lower bound",
            reduced.pass_rate_lower_confidence_bound,
            "fraction",
            "higher_is_better",
        ),
        (
            "agentic.recovery_treatment_success_rate",
            "Treatment continuity success rate",
            reduced.treatment_success_rate,
            "fraction",
            "higher_is_better",
        ),
        (
            "agentic.recovery_baseline_success_rate",
            "Paired baseline continuity success rate",
            reduced.baseline_success_rate,
            "fraction",
            "higher_is_better",
        ),
        (
            "agentic.recovery_success_delta",
            "Treatment minus baseline continuity success",
            reduced.success_delta,
            "fraction",
            "higher_is_better",
        ),
        (
            "agentic.recovery_mean_latency_delta_ms",
            "Treatment minus baseline recovery latency",
            reduced.mean_latency_delta_ms,
            "ms",
            "lower_is_better",
        ),
        (
            "agentic.recovery_max_retry_amplification",
            "Maximum paired retry amplification",
            reduced.maximum_retry_amplification,
            "ratio",
            "lower_is_better",
        ),
        (
            "agentic.recovery_maximum_latency_ms",
            "Frozen maximum treatment recovery latency",
            reduced.maximum_recovery_latency_ms,
            "ms",
            "lower_is_better",
        ),
        (
            "agentic.recovery_retry_amplification_threshold",
            "Frozen maximum retry amplification",
            reduced.maximum_retry_amplification_threshold,
            "ratio",
            "lower_is_better",
        ),
        (
            "agentic.recovery_distinct_seed_count",
            "Distinct live fault-recovery seeds",
            float(reduced.distinct_seed_count) if reduced.pair_count else None,
            "seeds",
            "higher_is_better",
        ),
        (
            "agentic.recovery_minimum_distinct_seed_count",
            "Frozen minimum distinct fault-recovery seeds",
            (
                float(reduced.minimum_distinct_seed_count)
                if reduced.minimum_distinct_seed_count is not None
                else None
            ),
            "seeds",
            "higher_is_better",
        ),
    )


def recovery_metrics(records: list[ExecutionRecord]) -> list[EvaluationMetric]:
    reduced = reduce_recovery(records)
    return [
        _metric(
            metric_id,
            name,
            "agentic",
            value,
            unit,
            direction,
            reduced.pair_count,
        )
        for metric_id, name, value, unit, direction in _recovery_metric_specs(reduced)
    ]
