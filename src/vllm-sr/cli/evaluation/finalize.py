"""Finalize immutable evidence files and public reports for one run."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from cli.evaluation.bundle import checksum_bytes, public_artifacts
from cli.evaluation.canonical import digest_value
from cli.evaluation.capacity_profile import CapacityProfile
from cli.evaluation.case_plan import planned_case_ids_by_track
from cli.evaluation.constants import SCHEMA_VERSION
from cli.evaluation.contracts import ArtifactRef, ResolvedRunSnapshot, RunManifest
from cli.evaluation.evidence import ExecutionRecord, RoutingDiagnostic
from cli.evaluation.execution_contract import (
    EvaluationInputs,
    NormalizedSuiteIdentities,
)
from cli.evaluation.report_builder import (
    build_report,
    select_report_metrics,
)
from cli.evaluation.report_render_html import render_html
from cli.evaluation.report_render_markdown import render_markdown
from cli.evaluation.reporting import (
    EvaluationGate,
    EvaluationMetric,
    EvaluationProvenance,
    EvaluationReport,
    EvaluationRun,
)
from cli.evaluation.store import LocalArtifactStore


def _failure_summary(records: list[ExecutionRecord]) -> dict[str, object]:
    """Aggregate failures without exposing case identity or grading-derived fields."""

    tracks: dict[str, dict[str, int]] = {}
    for record in records:
        counts = tracks.setdefault(
            record.track_id,
            {"succeeded": 0, "failed": 0, "unavailable": 0},
        )
        counts[record.status] += 1
    return {
        "schema_version": SCHEMA_VERSION,
        "total_records": len(records),
        "failed": sum(record.status == "failed" for record in records),
        "unavailable": sum(record.status == "unavailable" for record in records),
        "by_track": [
            {"track_id": track_id, **tracks[track_id]} for track_id in sorted(tracks)
        ],
    }


def _provenance(
    manifest: RunManifest,
    resolved: ResolvedRunSnapshot,
    completed_at: datetime,
    benchmark_revisions: Mapping[str, str],
) -> EvaluationProvenance:
    mixture = manifest.target.mixture
    return EvaluationProvenance(
        generated_at=completed_at,
        code_revision=manifest.code_revision,
        benchmark_revisions=benchmark_revisions,
        workload_snapshot_digest=digest_value(resolved.workload),
        policy_snapshot_digest=(
            mixture.recipe_digest
            if mixture is not None
            else digest_value(resolved.policy)
        ),
        binding_snapshot_digest=(
            mixture.binding_digest
            if mixture is not None
            else digest_value(resolved.binding)
        ),
        pool_snapshot_digest=(
            mixture.pool_digest
            if mixture is not None
            else digest_value({"pool": resolved.pool, "arms": resolved.arms})
        ),
        environment_snapshot_digest=digest_value(resolved.environment),
        target_id=manifest.target.id,
        seed=manifest.seed,
        redaction_policy=manifest.redaction_policy,
    )


def _core_artifacts(
    manifest: RunManifest,
    store: LocalArtifactStore,
    manifest_ref: ArtifactRef,
    inputs: EvaluationInputs,
    records: list[ExecutionRecord],
    resolved: ResolvedRunSnapshot,
    metrics: list[EvaluationMetric],
    gates: list[EvaluationGate],
    provenance: EvaluationProvenance,
    private_identity_map: NormalizedSuiteIdentities | None,
) -> list[tuple[str, ArtifactRef]]:
    lineage: object = resolved
    if private_identity_map is not None:
        lineage = {
            "resolved_snapshot": resolved,
            "normalized_suite_identities": private_identity_map,
        }
    return [
        ("run-manifest.json", manifest_ref),
        (
            "cases.jsonl",
            store.write_run_jsonl(manifest.run_id, "cases.jsonl", inputs.visible.cases),
        ),
        (
            "records.jsonl",
            store.write_run_jsonl(manifest.run_id, "records.jsonl", records),
        ),
        (
            "grading-cases.jsonl",
            store.write_run_jsonl(
                manifest.run_id,
                "grading-cases.jsonl",
                inputs.grading.cases,
            ),
        ),
        (
            "metrics.json",
            store.write_run_json(
                manifest.run_id,
                "metrics.json",
                {
                    "schema_version": SCHEMA_VERSION,
                    "metrics": [
                        metric.model_dump(mode="json", exclude_none=False)
                        for metric in metrics
                    ],
                },
            ),
        ),
        (
            "gates.json",
            store.write_run_json(
                manifest.run_id,
                "gates.json",
                {
                    "schema_version": SCHEMA_VERSION,
                    "gates": [
                        gate.model_dump(mode="json", exclude_none=False)
                        for gate in gates
                    ],
                },
            ),
        ),
        (
            "lineage.json",
            store.write_run_json(manifest.run_id, "lineage.json", lineage),
        ),
        (
            "provenance.json",
            store.write_run_json(manifest.run_id, "provenance.json", provenance),
        ),
        (
            "failure-cases.jsonl",
            store.write_run_jsonl(
                manifest.run_id,
                "failure-cases.jsonl",
                [row for row in records if row.status == "failed"],
            ),
        ),
        (
            "failure-summary.json",
            store.write_run_json(
                manifest.run_id,
                "failure-summary.json",
                _failure_summary(records),
            ),
        ),
    ]


def _live_artifacts(
    manifest: RunManifest,
    store: LocalArtifactStore,
    records: list[ExecutionRecord],
    routing_traces: tuple[RoutingDiagnostic, ...],
    capacity_profile: CapacityProfile | None,
) -> list[tuple[str, ArtifactRef]]:
    if manifest.mode != "live":
        return []
    rows: list[tuple[str, ArtifactRef]] = []
    if routing_traces:
        rows.append(
            (
                "routing-traces.jsonl",
                store.write_run_jsonl(
                    manifest.run_id, "routing-traces.jsonl", routing_traces
                ),
            )
        )
    capacity_rows = [row for row in records if row.track_id == "capacity"]
    if capacity_rows and capacity_profile is None:
        raise ValueError("live capacity records require a typed SLO profile")
    if capacity_profile is not None:
        rows.append(
            (
                "capacity-profile.json",
                store.write_run_json(
                    manifest.run_id,
                    "capacity-profile.json",
                    capacity_profile.model_dump(mode="json", exclude_none=False),
                ),
            )
        )
    return rows


def finalize_report_bundle(
    *,
    manifest: RunManifest,
    store: LocalArtifactStore,
    manifest_ref: ArtifactRef,
    inputs: EvaluationInputs,
    records: list[ExecutionRecord],
    resolved: ResolvedRunSnapshot,
    metrics: list[EvaluationMetric],
    gates: list[EvaluationGate],
    routing_traces: tuple[RoutingDiagnostic, ...],
    capacity_profile: CapacityProfile | None,
    run: EvaluationRun,
    completed_at: datetime,
    benchmark_revisions: Mapping[str, str],
    private_identity_map: NormalizedSuiteIdentities | None = None,
) -> EvaluationReport:
    """Write the non-self-referential bundle, then its canonical report."""

    selected_metrics = select_report_metrics(manifest, metrics)
    provenance = _provenance(manifest, resolved, completed_at, benchmark_revisions)
    artifact_rows = _core_artifacts(
        manifest,
        store,
        manifest_ref,
        inputs,
        records,
        resolved,
        selected_metrics,
        gates,
        provenance,
        private_identity_map,
    )
    artifact_rows.extend(
        _live_artifacts(
            manifest,
            store,
            records,
            routing_traces,
            capacity_profile,
        )
    )
    planned_case_ids = planned_case_ids_by_track(
        inputs.visible,
        manifest.track_ids,
    )
    report_options = {
        "manifest": manifest,
        "run": run,
        "records": records,
        "metrics": selected_metrics,
        "gates": gates,
        "provenance": provenance,
        "planned_case_ids": planned_case_ids,
    }
    draft = build_report(
        **report_options,
        artifacts=public_artifacts(artifact_rows),
    )
    markdown_ref = store.write_run_bytes(
        manifest.run_id, "report.md", render_markdown(draft).encode()
    )
    html_ref = store.write_run_bytes(
        manifest.run_id, "report.html", render_html(draft).encode()
    )
    artifact_rows.extend((("report.md", markdown_ref), ("report.html", html_ref)))
    public_checksum_rows = [
        (artifact.name, ref)
        for artifact in public_artifacts(artifact_rows)
        for name, ref in artifact_rows
        if name == artifact.name
    ]
    checksum_ref = store.write_run_bytes(
        manifest.run_id,
        "checksums.sha256",
        checksum_bytes(public_checksum_rows),
    )
    artifact_rows.append(("checksums.sha256", checksum_ref))
    private_checksum_ref = store.write_run_bytes(
        manifest.run_id,
        "private-checksums.sha256",
        checksum_bytes(artifact_rows),
    )
    artifact_rows.append(("private-checksums.sha256", private_checksum_ref))
    report = build_report(
        **report_options,
        artifacts=public_artifacts(artifact_rows),
    )
    store.write_run_json(
        manifest.run_id,
        "report.json",
        report.model_dump(mode="json", exclude_none=False),
    )
    return report
