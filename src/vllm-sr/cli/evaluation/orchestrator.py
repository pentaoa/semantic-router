"""Run lifecycle, artifact finalization, and executor orchestration."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from cli.evaluation.builtin_executors import DEFAULT_EXECUTOR_REGISTRY
from cli.evaluation.capacity_profile import CapacityProfile, build_capacity_profile
from cli.evaluation.contracts import ArtifactRef, ResolvedRunSnapshot, RunManifest
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.evidence_collection import collect_evidence
from cli.evaluation.evidence_level import run_evidence_level
from cli.evaluation.execution_plan import (
    DEFAULT_SUITE_REGISTRY,
    ExecutionPlan,
    SuiteRegistry,
    resolve_execution_plan,
)
from cli.evaluation.executor_registry import CollectedEvidence, ExecutorRegistry
from cli.evaluation.finalize import finalize_report_bundle
from cli.evaluation.gates import compute_gates
from cli.evaluation.method_gate_evidence import derive_method_gate_evidence
from cli.evaluation.metrics import compute_metrics
from cli.evaluation.normalized_suite_live_robustness import (
    declared_shift_gate_is_complete,
)
from cli.evaluation.reporting import (
    EvaluationGate,
    EvaluationMetric,
    EvaluationReport,
    EvaluationRun,
    EvaluationRunProgress,
    WorkerEvent,
)
from cli.evaluation.resolution import resolve_snapshot
from cli.evaluation.statistics import attach_confidence_intervals
from cli.evaluation.store import LocalArtifactStore, StoreError
from cli.evaluation.suite_store import NormalizedSuiteStore
from cli.evaluation.target_capabilities import (
    DEFAULT_TARGET_REGISTRY,
    TargetRegistry,
)

EventSink = Callable[[WorkerEvent], None]


@dataclass(frozen=True)
class ReducedRunEvidence:
    resolved: ResolvedRunSnapshot
    capacity_profile: CapacityProfile | None
    metrics: list[EvaluationMetric]
    gates: list[EvaluationGate]
    completed_at: datetime


def load_manifest(path: str | Path) -> RunManifest:
    try:
        return RunManifest.model_validate_json(Path(path).read_bytes())
    except OSError as exc:
        raise ValueError(f"cannot read evaluation manifest: {exc}") from exc
    except ValidationError as exc:
        raise ValueError(f"invalid evaluation manifest: {exc}") from exc


def validate_manifest(
    manifest: RunManifest,
    suite_store: NormalizedSuiteStore | None = None,
    executor_registry: ExecutorRegistry = DEFAULT_EXECUTOR_REGISTRY,
    suite_registry: SuiteRegistry = DEFAULT_SUITE_REGISTRY,
    target_registry: TargetRegistry = DEFAULT_TARGET_REGISTRY,
) -> None:
    plan = resolve_execution_plan(
        manifest,
        suite_store,
        suite_registry,
        executor_registry,
        target_registry,
    )
    executor_registry.require(plan.executor_id)


def _emit(
    store: LocalArtifactStore,
    run_id: str,
    sink: EventSink | None,
    event: WorkerEvent,
) -> None:
    store.append_event(run_id, event.model_dump(mode="json", exclude_none=True))
    if sink:
        sink(event)


def _run_model(
    manifest: RunManifest,
    *,
    status: str,
    progress: EvaluationRunProgress,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
    error: str | None = None,
    evidence_level: str = "E0",
) -> EvaluationRun:
    return EvaluationRun(
        id=manifest.run_id,
        client_request_id=manifest.run_id,
        name=manifest.name,
        description=manifest.description,
        status=status,
        mode=manifest.mode,
        evidence_level=evidence_level,
        target_id=manifest.target.id,
        mixture=(
            manifest.target.mixture.public_summary()
            if manifest.target.mixture is not None
            else None
        ),
        change_profile=manifest.change_profile,
        suite_ids=manifest.suite_ids,
        track_ids=manifest.track_ids,
        sample_limit=manifest.sample_limit,
        concurrency=manifest.concurrency,
        capacity_slo=manifest.capacity_slo,
        capacity_load_protocol=manifest.capacity_load_protocol,
        seed=manifest.seed,
        baseline_run_id=manifest.baseline_run_id,
        progress=progress,
        created_at=manifest.created_at,
        started_at=started_at,
        completed_at=completed_at,
        error=error,
    )


def _emit_track_events(
    manifest: RunManifest,
    store: LocalArtifactStore,
    sink: EventSink | None,
    records: list[ExecutionRecord],
) -> None:
    for index, track_id in enumerate(manifest.track_ids, 1):
        record_count = sum(row.track_id == track_id for row in records)
        event_progress = EvaluationRunProgress(
            percent=100 * index / len(manifest.track_ids),
            completed=index,
            total=len(manifest.track_ids),
            current_track_id=track_id,
            message=f"Collected {record_count} records",
        )
        _emit(
            store,
            manifest.run_id,
            sink,
            WorkerEvent(
                type="track",
                message=f"Completed {track_id} evidence collection",
                track_id=track_id,
                progress=event_progress,
                payload={"record_count": record_count},
            ),
        )


def _start_run(
    manifest: RunManifest,
    store: LocalArtifactStore,
    event_sink: EventSink | None,
    manage_control_state: bool,
) -> tuple[datetime, EvaluationRunProgress, ArtifactRef]:
    started = datetime.now(timezone.utc)
    progress = EvaluationRunProgress(
        percent=0,
        completed=0,
        total=len(manifest.track_ids),
        message="Starting evaluation",
    )
    run = _run_model(manifest, status="running", progress=progress, started_at=started)
    if manage_control_state:
        manifest_ref = store.write_run_json(
            manifest.run_id, "run-manifest.json", manifest
        )
    else:
        try:
            staged_manifest = RunManifest.model_validate(
                store.read_run_json(manifest.run_id, "run-manifest.json")
            )
        except (StoreError, ValidationError) as exc:
            raise StoreError(
                "worker requires a valid server-staged run-manifest.json"
            ) from exc
        if staged_manifest != manifest:
            raise StoreError("staged run-manifest.json does not match worker input")
        manifest_ref = store.reference_run_artifact(
            manifest.run_id, "run-manifest.json"
        )
    if manage_control_state:
        store.set_status(manifest.run_id, run)
    _emit(
        store,
        manifest.run_id,
        event_sink,
        WorkerEvent(
            type="snapshot", message="Evaluation manifest validated", progress=progress
        ),
    )
    return started, progress, manifest_ref


def _execute_run(
    manifest: RunManifest,
    store: LocalArtifactStore,
    manifest_ref: ArtifactRef,
    started: datetime,
    event_sink: EventSink | None,
    manage_control_state: bool,
    suite_store: NormalizedSuiteStore | None,
    plan: ExecutionPlan,
    executor_registry: ExecutorRegistry,
) -> EvaluationReport:
    collected = collect_evidence(
        manifest,
        store,
        plan,
        suite_store=suite_store,
        registry=executor_registry,
    )
    records = collected.records
    _emit_track_events(manifest, store, event_sink, records)
    reduced = _reduce_run_evidence(manifest, collected)
    final_progress = EvaluationRunProgress(
        percent=100,
        completed=len(manifest.track_ids),
        total=len(manifest.track_ids),
        message="Evaluation completed",
    )
    completed_run = _run_model(
        manifest,
        status="completed",
        progress=final_progress,
        started_at=started,
        completed_at=reduced.completed_at,
        evidence_level=run_evidence_level(
            manifest.mode,
            plan.executor_id,
            manifest.track_ids,
            records,
            executor_registry.contract(plan.executor_id).evidence_level_ceiling,
        ),
    )
    report = finalize_report_bundle(
        manifest=manifest,
        store=store,
        manifest_ref=manifest_ref,
        inputs=collected.inputs,
        records=records,
        resolved=reduced.resolved,
        metrics=reduced.metrics,
        gates=reduced.gates,
        routing_traces=collected.routing_traces,
        capacity_profile=reduced.capacity_profile,
        run=completed_run,
        completed_at=reduced.completed_at,
        benchmark_revisions=collected.inputs.suite_revisions,
        private_identity_map=collected.inputs.private_identity_map,
    )
    if manage_control_state:
        store.set_status(manifest.run_id, completed_run)
    _emit(
        store,
        manifest.run_id,
        event_sink,
        WorkerEvent(
            type="completed",
            message="Evaluation completed and artifacts were finalized",
            progress=final_progress,
            payload={"verdict": report.summary.verdict},
        ),
    )
    return report


def _reduce_run_evidence(
    manifest: RunManifest,
    collected: CollectedEvidence,
) -> ReducedRunEvidence:
    records = collected.records
    resolved = resolve_snapshot(
        manifest,
        collected.inputs,
        collected.visible_ref,
        collected.grading_ref,
        collected.fixture_ref,
        collected.discovered_entrypoints,
    )
    capacity_profile = (
        build_capacity_profile(
            records,
            manifest.capacity_slo,
            manifest.capacity_load_protocol,
        )
        if manifest.capacity_slo is not None
        else None
    )
    metrics = attach_confidence_intervals(
        compute_metrics(records, capacity_profile=capacity_profile),
        records,
        seed=manifest.seed,
    )
    completed = datetime.now(timezone.utc)
    gates = compute_gates(
        metrics,
        has_records=bool(records),
        change_profile=manifest.change_profile,
        evidence=derive_method_gate_evidence(
            manifest,
            records,
            method_qualified_gate_ids=(
                frozenset({"G4"})
                if manifest.mode == "live"
                and set(collected.inputs.suite_executors.values())
                == {"normalized-suite-live.v1"}
                and declared_shift_gate_is_complete(records)
                else frozenset()
            ),
        ),
        records=records,
        evaluated_at=completed,
    )
    return ReducedRunEvidence(
        resolved=resolved,
        capacity_profile=capacity_profile,
        metrics=metrics,
        gates=gates,
        completed_at=completed,
    )


def _record_failure(
    manifest: RunManifest,
    store: LocalArtifactStore,
    started: datetime,
    progress: EvaluationRunProgress,
    event_sink: EventSink | None,
    manage_control_state: bool,
    exc: Exception,
) -> None:
    failed_progress = EvaluationRunProgress(
        percent=progress.percent,
        completed=progress.completed,
        total=progress.total,
        message="Evaluation failed",
    )
    failed = _run_model(
        manifest,
        status="failed",
        progress=failed_progress,
        started_at=started,
        completed_at=datetime.now(timezone.utc),
        error=f"{type(exc).__name__}: {exc}",
    )
    if manage_control_state:
        store.set_status(manifest.run_id, failed)
    _emit(
        store,
        manifest.run_id,
        event_sink,
        WorkerEvent(type="failed", message="Evaluation failed"),
    )


def run_evaluation(
    manifest: RunManifest,
    store: LocalArtifactStore,
    *,
    event_sink: EventSink | None = None,
    manage_control_state: bool = True,
    suite_store: NormalizedSuiteStore | None = None,
    executor_registry: ExecutorRegistry = DEFAULT_EXECUTOR_REGISTRY,
    suite_registry: SuiteRegistry = DEFAULT_SUITE_REGISTRY,
    target_registry: TargetRegistry = DEFAULT_TARGET_REGISTRY,
) -> EvaluationReport:
    plan = resolve_execution_plan(
        manifest,
        suite_store,
        suite_registry,
        executor_registry,
        target_registry,
    )
    executor_registry.require(plan.executor_id)
    try:
        existing = store.read_run_json(manifest.run_id, "report.json")
    except StoreError:
        existing = None
    if existing is not None:
        try:
            staged_manifest = RunManifest.model_validate(
                store.read_run_json(manifest.run_id, "run-manifest.json")
            )
        except (StoreError, ValidationError) as exc:
            raise StoreError(
                "existing report cannot be tied to a valid staged run manifest"
            ) from exc
        if staged_manifest != manifest:
            raise StoreError("existing report belongs to a different run manifest")
        return EvaluationReport.model_validate(existing)
    started, progress, manifest_ref = _start_run(
        manifest, store, event_sink, manage_control_state
    )
    try:
        return _execute_run(
            manifest,
            store=store,
            manifest_ref=manifest_ref,
            started=started,
            event_sink=event_sink,
            manage_control_state=manage_control_state,
            suite_store=suite_store,
            plan=plan,
            executor_registry=executor_registry,
        )
    except Exception as exc:
        _record_failure(
            manifest,
            store,
            started,
            progress,
            event_sink,
            manage_control_state,
            exc,
        )
        raise
