"""Build deterministic public reports from normalized evidence."""

from __future__ import annotations

from collections.abc import Collection, Mapping

from cli.evaluation.architecture_feedback import architecture_recommendations
from cli.evaluation.contracts import RunManifest
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.evidence_level import track_evidence_level
from cli.evaluation.metric_core import (
    _canonical_ordered_float_sum,
    aggregate_track_coverage,
)
from cli.evaluation.metrics import coverage
from cli.evaluation.reporting import (
    EvaluationArtifact,
    EvaluationCostAmount,
    EvaluationCostLedgers,
    EvaluationGate,
    EvaluationMetric,
    EvaluationProvenance,
    EvaluationReport,
    EvaluationReportSummary,
    EvaluationRun,
    EvaluationTrackReport,
)


def _value(metrics: list[EvaluationMetric], metric_id: str) -> float | None:
    metric = next((row for row in metrics if row.id == metric_id), None)
    return metric.value if metric else None


def _sum_optional(values: list[float | None]) -> float | None:
    available = [value for value in values if value is not None]
    return _canonical_ordered_float_sum(available) if available else None


def select_report_metrics(
    manifest: RunManifest, metrics: list[EvaluationMetric]
) -> list[EvaluationMetric]:
    """Project computed metrics onto the immutable run track selection."""

    return [row for row in metrics if row.track_id in manifest.track_ids]


def _track_plan_totals(
    manifest: RunManifest,
    planned_case_ids: Mapping[str, Collection[str]],
) -> dict[str, int]:
    """Count immutable case-track cells, independent of executor output."""

    if set(planned_case_ids) != set(manifest.track_ids):
        raise ValueError("report plan tracks do not match the immutable run")
    totals = {
        track_id: len(planned_case_ids[track_id]) for track_id in manifest.track_ids
    }
    if any(total < 1 for total in totals.values()):
        raise ValueError("report plan cannot contain an empty selected track")
    return totals


def build_costs(records: list[ExecutionRecord]) -> EvaluationCostLedgers:
    return EvaluationCostLedgers(
        runtime=EvaluationCostAmount(
            amount=_sum_optional([row.runtime_cost for row in records]),
            currency="USD",
            input_tokens=sum(row.input_tokens or 0 for row in records),
            output_tokens=sum(row.output_tokens or 0 for row in records),
        ),
        evaluation_overhead=EvaluationCostAmount(
            amount=_sum_optional([row.evaluation_cost for row in records]),
            currency="USD",
        ),
        capacity_tco=EvaluationCostAmount(
            amount=_sum_optional([row.capacity_tco for row in records]),
            currency="USD",
            gpu_seconds=_sum_optional([row.gpu_seconds for row in records]),
            energy_kwh=_sum_optional([row.energy_kwh for row in records]),
        ),
    )


def _verdict(gates: list[EvaluationGate]) -> str:
    required = [gate for gate in gates if gate.disposition == "required"]
    if any(gate.verdict == "fail" for gate in required):
        return "fail"
    if any(gate.verdict == "unavailable" for gate in required):
        return "unavailable"
    return "pass"


def _track_reports(
    manifest: RunManifest,
    records: list[ExecutionRecord],
    metrics: list[EvaluationMetric],
    gates: list[EvaluationGate],
    totals: dict[str, int],
) -> tuple[EvaluationTrackReport, ...]:
    executor_id = next(iter(manifest.suite_executors.values()))
    reports: list[EvaluationTrackReport] = []
    for track_id in manifest.track_ids:
        track_records = [row for row in records if row.track_id == track_id]
        available = [row for row in track_records if row.status != "unavailable"]
        track_metrics = tuple(row for row in metrics if row.track_id == track_id)
        track_gates = tuple(row for row in gates if row.track_id == track_id)
        track_coverage = coverage(track_records, totals.get(track_id, 0))
        if available:
            status = "completed"
            failures = sum(row.status == "failed" for row in available)
            summary = f"Collected {len(available)} evidence records"
            if failures:
                summary += (
                    f"; {failures} executions failed and remain in the denominator."
                )
            else:
                summary += "."
        else:
            status = "unavailable"
            summary = "No qualified evidence was produced."
        reports.append(
            EvaluationTrackReport(
                track_id=track_id,
                status=status,
                evidence_level=track_evidence_level(
                    manifest.mode, executor_id, track_id, track_records
                ),
                summary=summary,
                coverage=track_coverage,
                metrics=track_metrics,
                gates=track_gates,
            )
        )
    return tuple(reports)


def build_report(
    *,
    manifest: RunManifest,
    run: EvaluationRun,
    records: list[ExecutionRecord],
    metrics: list[EvaluationMetric],
    gates: list[EvaluationGate],
    provenance: EvaluationProvenance,
    artifacts: tuple[EvaluationArtifact, ...],
    planned_case_ids: Mapping[str, Collection[str]],
) -> EvaluationReport:
    metrics = select_report_metrics(manifest, metrics)
    selected_gates = list(gates)
    costs = build_costs(records)
    totals = _track_plan_totals(manifest, planned_case_ids)
    overall_coverage = aggregate_track_coverage(records, totals)
    quality = _value(metrics, "joint.realized_quality")
    if quality is None:
        quality = _value(metrics, "routing.accuracy")
    if quality is None:
        quality = _value(metrics, "model_pool.oracle_quality")
    latency = _value(metrics, "joint.latency_p95_ms")
    if latency is None:
        latency = _value(metrics, "capacity.latency_p95_ms")
    if latency is None:
        latency = _value(metrics, "routing.latency_p95_ms")
    promotion_summary_available = run.evidence_level != "E0"
    verdict = _verdict(selected_gates)
    unavailable = [gate for gate in selected_gates if gate.verdict == "unavailable"]
    failed = [gate for gate in selected_gates if gate.verdict == "fail"]
    track_reports = _track_reports(manifest, records, metrics, selected_gates, totals)
    qualified_track_ids = {
        track.track_id for track in track_reports if track.evidence_level != "E0"
    }
    gate_recommendations = [
        f"Resolve {gate.id} ({gate.name}): {gate.rationale or 'inspect evidence.'}"
        for gate in failed + unavailable
    ]
    architecture_findings = list(
        architecture_recommendations(
            [metric for metric in metrics if metric.track_id in qualified_track_ids],
            [],
        )
    )
    if run.evidence_level == "E0":
        gate_recommendations.insert(
            0,
            (
                "At least one selected track is E0, so the promotion summary is withheld. "
                "Architecture findings use only tracks with source-bound evidence above E0."
                if qualified_track_ids
                else (
                    "E0 diagnostic only: validate the harness, then collect qualified "
                    "evidence before inferring a recipe, pool, or runtime architecture "
                    "change. For normalized imports, deterministic parsing proves the "
                    "imported bytes but not upstream native benchmark execution."
                )
            ),
        )
    recommendations = list(dict.fromkeys(gate_recommendations + architecture_findings))
    if not recommendations:
        recommendations = [
            "All applicable local gates passed; validate on the target runtime before promotion."
        ]
    return EvaluationReport(
        run=run,
        summary=EvaluationReportSummary(
            verdict=verdict,
            quality_score=quality if promotion_summary_available else None,
            latency_p95_ms=latency if promotion_summary_available else None,
            runtime_cost=(
                costs.runtime.amount if promotion_summary_available else None
            ),
            capacity_tco=(
                costs.capacity_tco.amount if promotion_summary_available else None
            ),
            coverage=overall_coverage,
            passed_gates=sum(gate.verdict == "pass" for gate in selected_gates),
            failed_gates=len(failed),
            unavailable_gates=len(unavailable),
        ),
        tracks=track_reports,
        metrics=tuple(metrics),
        gates=tuple(selected_gates),
        costs=costs,
        recommendations=tuple(recommendations),
        provenance=provenance,
        artifacts=artifacts,
    )
