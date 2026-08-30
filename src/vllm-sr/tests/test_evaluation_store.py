from __future__ import annotations

import json
import os
import stat
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import pytest
from cli.evaluation.reporting import EvaluationRun, EvaluationRunProgress
from cli.evaluation.store import LocalArtifactStore, StoreError

_RUN_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "vllm-sr-evaluation:store-run"))
_LINKED_RUN_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "vllm-sr-evaluation:linked"))


def _run(
    status: Literal[
        "pending", "running", "sealing", "completed", "failed", "cancelled"
    ],
    run_id: str = _RUN_ID,
) -> EvaluationRun:
    return EvaluationRun(
        id=run_id,
        client_request_id=run_id,
        name="Run 1",
        description="Store contract fixture",
        status=status,
        mode="replay",
        evidence_level="E0",
        target_id="fixture",
        change_profile="schema_adapter",
        suite_ids=("evaluation-smoke",),
        track_ids=("routing",),
        sample_limit=1,
        concurrency=1,
        seed=1,
        progress=EvaluationRunProgress(percent=0, completed=0, total=1),
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def test_cas_deduplicates_and_verifies_content(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    first = store.put_bytes(b"same evidence", "text/plain")
    second = store.put_bytes(b"same evidence", "text/plain")

    assert first == second
    assert store.read_bytes(first) == b"same evidence"
    assert len(list(store.objects.iterdir())) == 1


def test_store_rejects_traversal_and_symlinked_run_directories(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    for invalid_run_id in ("../escape", "portable-but-not-a-uuid", "run.with.dot"):
        with pytest.raises(StoreError, match="invalid run id"):
            store.write_run_json(invalid_run_id, "status.json", {"status": "bad"})

    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, store.runs / _LINKED_RUN_ID)
    with pytest.raises(StoreError, match=r"symlink|escapes store root"):
        store.write_run_json(_LINKED_RUN_ID, "status.json", {"status": "bad"})
    with pytest.raises(StoreError, match="invalid run id"):
        store.read_run_text("../../escape", "report.md")


def test_store_rejects_symlinked_run_artifacts_inside_root(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    store.set_status(_RUN_ID, _run("running"))
    run_dir = store.runs / _RUN_ID
    os.symlink(run_dir / "status.json", run_dir / "metrics.json")
    with pytest.raises(StoreError, match="symlink"):
        store.write_run_json(_RUN_ID, "metrics.json", {"value": 1})
    with pytest.raises(StoreError, match="symlink"):
        store.read_run_json(_RUN_ID, "metrics.json")

    os.symlink(run_dir / "status.json", run_dir / "events.jsonl")
    with pytest.raises(StoreError, match="symlink"):
        store.append_event(_RUN_ID, {"type": "bad"})


def test_atomic_writes_leave_no_temporary_files_and_final_artifacts_are_immutable(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    store.write_run_json(_RUN_ID, "metrics.json", {"value": 1})
    store.write_run_json(_RUN_ID, "metrics.json", {"value": 1})
    assert not list((store.runs / _RUN_ID).glob(".*"))

    with pytest.raises(StoreError, match="immutable"):
        store.write_run_json(_RUN_ID, "metrics.json", {"value": 2})


def test_status_is_atomic_mutable_control_state_for_standalone_runs(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    store.set_status(_RUN_ID, _run("running"))
    store.set_status(_RUN_ID, _run("completed"))
    assert store.read_run_json(_RUN_ID, "status.json")["status"] == "completed"


def test_status_rejects_untyped_state_and_has_no_secondary_index(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    with pytest.raises(TypeError, match="EvaluationRun contract"):
        store.set_status(_RUN_ID, {"status": "running"})  # type: ignore[arg-type]
    assert not (store.root / "index").exists()


def test_concurrent_store_initialization_is_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "store"
    with ThreadPoolExecutor(max_workers=8) as pool:
        stores = tuple(pool.map(lambda _: LocalArtifactStore(root), range(32)))

    assert all(store.root == stores[0].root for store in stores)


def test_concurrent_run_writes_preserve_immutability_and_event_lines(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(tmp_path / "store")

    def write_metric(value: int) -> bool:
        try:
            store.write_run_json(_RUN_ID, "metrics.json", {"value": value})
            return True
        except StoreError:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        metric_results = tuple(pool.map(write_metric, range(8)))
        tuple(
            pool.map(
                lambda index: store.append_event(_RUN_ID, {"sequence": index}),
                range(64),
            )
        )

    assert sum(metric_results) == 1
    assert store.read_run_json(_RUN_ID, "metrics.json")["value"] in range(8)
    events = store.read_run_text(_RUN_ID, "events.jsonl").splitlines()
    assert len(events) == 64
    assert {json.loads(row)["sequence"] for row in events} == set(range(64))


def test_process_private_store_uses_only_in_memory_coordination(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(tmp_path / "store", process_private=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        tuple(
            pool.map(
                lambda index: store.append_event(_RUN_ID, {"sequence": index}),
                range(32),
            )
        )

    assert len(store.read_run_text(_RUN_ID, "events.jsonl").splitlines()) == 32
    assert not (store.runs / _RUN_ID / "artifacts.lock").exists()


def test_store_and_run_directories_are_private(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    store.set_status(_RUN_ID, _run("running"))
    directories = (
        store.root,
        store.root / "objects",
        store.objects,
        store.runs,
        store.runs / _RUN_ID,
    )
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o700 for path in directories)


def test_store_rejects_preexisting_non_private_directory(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir(mode=0o755)
    with pytest.raises(StoreError, match="mode 0700"):
        LocalArtifactStore(root)


def test_store_rejects_a_symlinked_root(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    linked = tmp_path / "linked"
    os.symlink(real, linked)

    with pytest.raises(StoreError, match="root must not be a symlink"):
        LocalArtifactStore(linked)
