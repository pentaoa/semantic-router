"""Canonical case-to-track evaluation plan primitives."""

from __future__ import annotations

from collections.abc import Iterable

from cli.evaluation.constants import TRACK_IDS
from cli.evaluation.contracts import CaseVisible, VisibleCaseSet


def applicable_track_ids(
    declared_track_ids: Iterable[str], *, modality: str
) -> tuple[str, ...]:
    """Return the canonical non-empty track plan for one source case."""

    selected = frozenset(declared_track_ids)
    unknown = selected.difference(TRACK_IDS)
    if unknown:
        raise ValueError(f"case plan contains unknown track {sorted(unknown)[0]!r}")
    if modality == "text":
        selected = selected.difference({"multimodal"})
    result = tuple(track_id for track_id in TRACK_IDS if track_id in selected)
    if not result:
        raise ValueError("case plan must contain at least one applicable track")
    return result


def project_case_tracks(
    case: CaseVisible, selected_track_ids: Iterable[str]
) -> CaseVisible:
    """Project a source case onto an immutable run's selected tracks."""

    selected = frozenset(selected_track_ids)
    projected = tuple(track_id for track_id in case.track_ids if track_id in selected)
    if not projected:
        raise ValueError(f"case {case.id!r} has no applicable selected track")
    return case.model_copy(update={"track_ids": projected})


def project_visible_case_set(
    visible: VisibleCaseSet, selected_track_ids: Iterable[str]
) -> VisibleCaseSet:
    return VisibleCaseSet(
        cases=tuple(
            project_case_tracks(case, selected_track_ids) for case in visible.cases
        )
    )


def planned_case_ids_by_track(
    visible: VisibleCaseSet, selected_track_ids: Iterable[str]
) -> dict[str, frozenset[str]]:
    """Build the explicit case-track cell plan and reject empty selected tracks."""

    selected = tuple(selected_track_ids)
    selected_set = frozenset(selected)
    if selected != tuple(
        track_id for track_id in TRACK_IDS if track_id in selected_set
    ):
        raise ValueError("selected track ids must be unique and canonical")
    plan = {
        track_id: frozenset(
            case.id for case in visible.cases if track_id in case.track_ids
        )
        for track_id in selected
    }
    empty = [track_id for track_id, case_ids in plan.items() if not case_ids]
    if empty:
        raise ValueError("selected tracks have no planned cases: " + ", ".join(empty))
    return plan
