"""Validate evidence returned across the executor extension boundary."""

from __future__ import annotations

from cli.evaluation.builtin_executors import DEFAULT_EXECUTOR_REGISTRY
from cli.evaluation.case_plan import planned_case_ids_by_track
from cli.evaluation.contracts import RunManifest
from cli.evaluation.execution_plan import ExecutionPlan
from cli.evaluation.executor_registry import CollectedEvidence, ExecutorRegistry
from cli.evaluation.store import LocalArtifactStore
from cli.evaluation.suite_store import NormalizedSuiteStore


def collect_evidence(
    manifest: RunManifest,
    store: LocalArtifactStore,
    plan: ExecutionPlan,
    *,
    suite_store: NormalizedSuiteStore | None = None,
    registry: ExecutorRegistry = DEFAULT_EXECUTOR_REGISTRY,
) -> CollectedEvidence:
    executor = registry.require(plan.executor_id)
    collected = executor.collect(manifest, store, plan, suite_store)
    _validate_fixture_ref(
        plan.executor_id,
        executor.contract.requires_fixture_ref,
        collected,
    )
    _validate_suite_identity(plan, collected)
    _validate_executor_tracks(manifest, plan, collected)
    planned_cases = _validate_visible_cases(manifest, collected)
    _validate_records(manifest, collected, planned_cases)
    return collected


def _validate_fixture_ref(
    executor_id: str,
    requires_fixture_ref: bool,
    collected: CollectedEvidence,
) -> None:
    if requires_fixture_ref and collected.fixture_ref is None:
        raise ValueError(
            f"executor {executor_id!r} omitted its required fixture reference"
        )
    if not requires_fixture_ref and collected.fixture_ref is not None:
        raise ValueError(
            f"executor {executor_id!r} returned an undeclared fixture reference"
        )


def _validate_suite_identity(
    plan: ExecutionPlan,
    collected: CollectedEvidence,
) -> None:
    if collected.inputs.suite_revisions != plan.suite_revisions:
        raise ValueError("executor returned evidence for different suite revisions")
    if collected.inputs.suite_executors != plan.suite_executors:
        raise ValueError("executor returned evidence for different suite executors")


def _validate_executor_tracks(
    manifest: RunManifest,
    plan: ExecutionPlan,
    collected: CollectedEvidence,
) -> None:
    wrong_executor_tracks = sorted(
        track_id
        for track_id in manifest.track_ids
        if collected.inputs.executor_ids.get(track_id) != plan.executor_id
    )
    if wrong_executor_tracks:
        raise ValueError(
            "executor identity does not match the execution plan for tracks: "
            + ", ".join(wrong_executor_tracks)
        )


def _validate_visible_cases(
    manifest: RunManifest,
    collected: CollectedEvidence,
) -> dict[str, frozenset[str]]:
    selected_tracks = frozenset(manifest.track_ids)
    for case in collected.inputs.visible.cases:
        if not set(case.track_ids).issubset(selected_tracks):
            raise ValueError(
                f"case {case.id!r} plans a track outside the immutable run selection"
            )
    return planned_case_ids_by_track(collected.inputs.visible, manifest.track_ids)


def _validate_records(
    manifest: RunManifest,
    collected: CollectedEvidence,
    planned_cases: dict[str, frozenset[str]],
) -> None:
    visible_case_ids = {case.id for case in collected.inputs.visible.cases}
    record_ids: set[str] = set()
    covered_cells: set[tuple[str, str]] = set()
    for record in collected.records:
        if record.id in record_ids:
            raise ValueError(f"executor returned duplicate record id: {record.id}")
        record_ids.add(record.id)
        if record.track_id not in manifest.track_ids:
            raise ValueError(
                f"executor returned an unrequested track: {record.track_id}"
            )
        if record.case_id not in visible_case_ids:
            raise ValueError(
                f"executor returned an unknown case identity: {record.case_id}"
            )
        if record.case_id not in planned_cases[record.track_id]:
            raise ValueError(
                "executor returned evidence for an unplanned case-track cell: "
                f"{record.case_id}/{record.track_id}"
            )
        covered_cells.add((record.case_id, record.track_id))
    missing_cells = [
        (case_id, track_id)
        for track_id in manifest.track_ids
        for case_id in sorted(planned_cases[track_id])
        if (case_id, track_id) not in covered_cells
    ]
    if missing_cells:
        case_id, track_id = missing_cells[0]
        raise ValueError(
            "executor omitted a planned case-track cell: " f"{case_id}/{track_id}"
        )
