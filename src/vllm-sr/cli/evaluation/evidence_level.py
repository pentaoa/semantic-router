"""Derive evidence layers from produced records, never connectivity alone."""

from __future__ import annotations

from typing import cast

from cli.evaluation.agent_task_evidence import AGENT_TASK_EVIDENCE_KIND
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.reporting import EvidenceLevel

_LIVE_TRACK_LEVEL: dict[str, EvidenceLevel] = {
    "routing": "E3",
    "model_pool": "E4",
    "joint": "E5",
    "agentic": "E5",
    "multimodal": "E5",
    "preference": "E1",
    "safety": "E2",
    "capacity": "E5",
}
_NORMALIZED_REPLAY_TRACK_LEVEL: dict[str, EvidenceLevel] = {
    "routing": "E3",
    "model_pool": "E4",
    "joint": "E5",
    "agentic": "E5",
    "multimodal": "E5",
    "preference": "E4",
    "safety": "E4",
    "capacity": "E5",
}
_QUALIFIED_LIVE_PREFIX = "qualified-live.v1;level="
_BUILTIN_LIVE_KIND_LEVEL: dict[str, dict[str, EvidenceLevel]] = {
    "routing": {
        "live-routing-diagnostic-smoke": "E3",
        "declared-shift.server-live.v1;level=E4": "E4",
    },
    "model_pool": {"live-mom-arm-outcome.v1": "E4"},
    "joint": {"live-mom-routed-outcome.v1": "E5"},
    # A task ledger reaches E5 only after the strict ledger model has accepted
    # its complete sealed membership; G6 recovery qualification remains a
    # separate reducer and gate.
    "agentic": {AGENT_TASK_EVIDENCE_KIND: "E5"},
}
_LEVEL_ORDER: tuple[EvidenceLevel, ...] = ("E0", "E1", "E2", "E3", "E4", "E5")


def _normalized_replay_level(
    executor_id: str, track_id: str, records: list[ExecutionRecord]
) -> EvidenceLevel:
    if not records or any(record.status == "unavailable" for record in records):
        return "E0"
    ceilings: list[EvidenceLevel] = []
    prefix = f"{executor_id};ceiling="
    for record in records:
        kind = record.evidence_kind or ""
        if not kind.startswith(prefix):
            return "E0"
        ceiling = kind.removeprefix(prefix)
        if ceiling not in _LEVEL_ORDER:
            return "E0"
        ceilings.append(cast(EvidenceLevel, ceiling))
    if not ceilings:
        return "E0"
    ceiling = min(ceilings, key=_LEVEL_ORDER.index)
    produced = _NORMALIZED_REPLAY_TRACK_LEVEL[track_id]
    return min((ceiling, produced), key=_LEVEL_ORDER.index)


def track_evidence_level(
    mode: str,
    executor_id: str,
    track_id: str,
    records: list[ExecutionRecord],
) -> EvidenceLevel:
    if mode == "replay":
        return _normalized_replay_level(executor_id, track_id, records)
    if not records or any(record.status == "unavailable" for record in records):
        return "E0"
    levels: list[EvidenceLevel] = []
    for record in records:
        kind = record.evidence_kind or ""
        builtin_level = _BUILTIN_LIVE_KIND_LEVEL.get(track_id, {}).get(kind)
        if builtin_level is not None:
            levels.append(builtin_level)
            continue
        if not kind.startswith(_QUALIFIED_LIVE_PREFIX):
            return "E0"
        level = kind.removeprefix(_QUALIFIED_LIVE_PREFIX)
        if level not in _LEVEL_ORDER:
            return "E0"
        levels.append(cast(EvidenceLevel, level))
    observed = min(levels, key=_LEVEL_ORDER.index)
    track_ceiling = _LIVE_TRACK_LEVEL[track_id]
    if track_id == "routing" and all(
        record.evidence_kind == "declared-shift.server-live.v1;level=E4"
        for record in records
    ):
        track_ceiling = "E4"
    return min((observed, track_ceiling), key=_LEVEL_ORDER.index)


def run_evidence_level(
    mode: str,
    executor_id: str,
    track_ids: tuple[str, ...],
    records: list[ExecutionRecord],
    evidence_level_ceiling: EvidenceLevel | None,
) -> EvidenceLevel:
    levels = [
        track_evidence_level(
            mode,
            executor_id,
            track_id,
            [record for record in records if record.track_id == track_id],
        )
        for track_id in track_ids
    ]
    observed = min(levels, key=_LEVEL_ORDER.index, default="E0")
    if evidence_level_ceiling is None:
        return observed
    return min((observed, evidence_level_ceiling), key=_LEVEL_ORDER.index)
