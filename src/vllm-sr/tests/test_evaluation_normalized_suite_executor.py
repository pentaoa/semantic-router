from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest
from cli.commands.eval import eval
from cli.evaluation.canonical import canonical_json_bytes
from cli.evaluation.constants import TRACK_IDS
from cli.evaluation.evidence import ExecutionRecord, RoutingDiagnostic
from cli.evaluation.execution_contract import (
    NORMALIZED_REPLAY_EXECUTOR_ID,
)
from cli.evaluation.http_client import HTTPResult
from cli.evaluation.live_executor import LiveRawResult
from cli.evaluation.normalized_suite_inputs import SelectedCase, evidence_kind
from cli.evaluation.orchestrator import run_evaluation
from cli.evaluation.store import LocalArtifactStore
from cli.evaluation.suite_contract import (
    NormalizedPerturbation,
)
from cli.evaluation.suite_store import NormalizedSuiteStore
from click.testing import CliRunner
from evaluation_normalized_suite_test_support import (
    _PRIVATE_MARKERS,
    _base_bundle,
    _catalog,
    _decision,
    _digest,
    _install_composite,
    _install_live_target_suite,
    _install_r2_suite,
    _live_manifest,
    _manifest,
    _qualification_cases,
    _suite_request,
    _target_mixture,
    _trusted_source_verifier,
    _write_jsonl,
)

pytestmark = pytest.mark.usefixtures(_trusted_source_verifier.__name__)


def _strip_nondeterministic_report_fields(payload: dict[str, Any]) -> None:
    payload["run"]["started_at"] = None
    payload["run"]["completed_at"] = None
    payload["provenance"]["generated_at"] = None
    for artifact in payload["artifacts"]:
        artifact["digest"] = None
        artifact["size_bytes"] = None
    for gate in payload["gates"]:
        gate["evaluated_at"] = None
    for track in payload["tracks"]:
        for gate in track["gates"]:
            gate["evaluated_at"] = None


def test_installed_composite_executes_all_tracks_deterministically_without_leaks(
    tmp_path: Path,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    suite_ids = _install_composite(tmp_path / "bundles", suite_store)
    manifest = _manifest("normalized-composite", suite_ids, suite_store)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_bytes(canonical_json_bytes(manifest))

    runner = CliRunner()
    validated = runner.invoke(
        eval,
        [
            "validate",
            "--manifest",
            str(manifest_path),
            "--suite-store",
            str(suite_store.root),
        ],
    )
    assert validated.exit_code == 0, validated.output
    assert json.loads(validated.output)["valid"] is True

    first_store = tmp_path / "evaluation-a"
    executed = runner.invoke(
        eval,
        [
            "run",
            "--manifest",
            str(manifest_path),
            "--store",
            str(first_store),
            "--suite-store",
            str(suite_store.root),
        ],
    )
    assert executed.exit_code == 0, executed.output
    first = json.loads(executed.output)
    second = run_evaluation(
        manifest,
        LocalArtifactStore(tmp_path / "evaluation-b"),
        suite_store=suite_store,
    )

    second_payload = second.model_dump(mode="json", exclude_none=False)
    for payload in (first, second_payload):
        _strip_nondeterministic_report_fields(payload)
    assert first == second_payload
    assert {track["track_id"] for track in first["tracks"]} == set(TRACK_IDS)
    assert all(track["status"] == "completed" for track in first["tracks"])
    assert first["run"]["evidence_level"] == "E0"
    assert all(
        _catalog(suite_store).get(suite_id).evidence_level == "E0"
        for suite_id in suite_ids
    )
    assert first["summary"]["verdict"] == "unavailable"
    expected_revisions = {
        suite_id: suite_store.get_suite_manifest(suite_id).revision
        for suite_id in suite_ids
    }
    assert first["provenance"]["benchmark_revisions"] == expected_revisions

    public_names = {artifact["name"] for artifact in first["artifacts"]}
    public_payload = executed.output + "".join(
        (first_store / "runs" / manifest.run_id / name).read_text()
        for name in public_names
        if name.endswith((".json", ".jsonl", ".md", ".html"))
    )
    assert all(marker not in public_payload for marker in _PRIVATE_MARKERS)
    assert "xroute-private-case" not in public_payload
    assert "ace-private-case" not in public_payload
    assert "r2-private-case" not in public_payload
    records = (first_store / "runs" / manifest.run_id / "records.jsonl").read_text()
    assert "normalized suite does not declare this track" not in records

    lineage_path = first_store / "runs" / manifest.run_id / "lineage.json"
    lineage = json.loads(lineage_path.read_text())
    assert lineage["resolved_snapshot"]["policy"]["id"] != "fixture-policy"
    assert (
        lineage["resolved_snapshot"]["environment"]["platform"]
        == "normalized-suite-replay"
    )
    assert any(
        row["source_id"] == "secret-arm-a"
        for row in lineage["normalized_suite_identities"]["arm_identities"]
    )
    assert stat.S_IMODE(lineage_path.stat().st_mode) == 0o600
    assert (
        "HIDDEN EXPECTED ANSWER"
        in (first_store / "runs" / manifest.run_id / "grading-cases.jsonl").read_text()
    )


def _target_executor(observed_case_ids: list[str]) -> Any:
    def execute(visible: Any, **kwargs: object) -> LiveRawResult:
        assert kwargs["track_ids"] == ("routing", "multimodal")
        assert kwargs["mixture"] == _target_mixture()
        case = visible.cases[0]
        observed_case_ids.append(case.id)
        response = HTTPResult(
            success=True,
            status_code=200,
            payload={
                "choices": [{"message": {"content": "  TARGET   HIDDEN ANSWER  "}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            },
            latency_ms=8.0,
            headers={},
        )
        return LiveRawResult(
            records=[
                ExecutionRecord(
                    id=f"routing-{case.id}",
                    track_id="routing",
                    case_id=case.id,
                    attempt_id=f"attempt-{case.id}",
                    status="succeeded",
                    selected_arm_id="provider-strong",
                    selection_status="selected",
                    success=True,
                    latency_ms=2.0,
                    evidence_kind="untrusted-pre-grade-marker",
                ),
                ExecutionRecord(
                    id=f"multimodal-{case.id}",
                    track_id="multimodal",
                    case_id=case.id,
                    attempt_id=f"attempt-{case.id}",
                    status="succeeded",
                    success=True,
                    modality="image",
                    latency_ms=8.0,
                ),
            ],
            discovered_entrypoints=("entrypoint-a",),
            routing_traces=(
                RoutingDiagnostic(
                    case_id=case.id,
                    selected_model="provider-strong",
                    selection_status="selected",
                ),
            ),
            chat_results={case.id: response},
            model_pool_results={},
            model_pool_arm_ids=(),
            joint_results={},
        )

    return execute


def test_same_installed_workload_replays_history_or_executes_current_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    suite_id = _install_live_target_suite(tmp_path / "bundles", suite_store)
    replay = _manifest("target-workload-replay", (suite_id,), suite_store)
    replay = replay.with_semantic_updates(
        track_ids=("routing", "multimodal"), sample_limit=1
    )
    replay_store = LocalArtifactStore(tmp_path / "replay-store")
    run_evaluation(replay, replay_store, suite_store=suite_store)

    observed_case_ids: list[str] = []
    monkeypatch.setattr(
        "cli.evaluation.normalized_suite_live_executor.execute_live_raw",
        _target_executor(observed_case_ids),
    )
    live = _live_manifest("target-workload-live", suite_id, suite_store)
    live_store = LocalArtifactStore(tmp_path / "live-store")
    report = run_evaluation(live, live_store, suite_store=suite_store)

    replay_cases = replay_store.read_run_bytes(
        replay.run_id, "cases.jsonl"
    ).splitlines()
    live_cases = live_store.read_run_bytes(live.run_id, "cases.jsonl").splitlines()
    assert [json.loads(row)["id"] for row in replay_cases] == observed_case_ids
    assert [json.loads(row)["id"] for row in live_cases] == observed_case_ids

    records = [
        ExecutionRecord.model_validate_json(row)
        for row in live_store.read_run_bytes(live.run_id, "records.jsonl").splitlines()
    ]
    routing = next(row for row in records if row.track_id == "routing")
    multimodal = next(row for row in records if row.track_id == "multimodal")
    assert routing.selected_arm_id == "arm-strong"
    assert routing.quality == 1.0
    assert routing.grader == "normalized-suite-hidden-route-label.v1"
    assert multimodal.quality == 1.0
    assert multimodal.grader == "normalized-suite-hidden-answer-exact.v1"
    assert {row.evidence_kind for row in records} == {"normalized-suite-live.v1"}

    lineage = live_store.read_run_json(live.run_id, "lineage.json")
    identities = lineage["normalized_suite_identities"]
    assert identities["arm_identities"] == []
    assert identities["action_identities"] == []
    assert (
        lineage["resolved_snapshot"]["environment"]["target_id"] == _target_mixture().id
    )
    assert "fixture_ref" not in lineage["resolved_snapshot"]
    assert report.run.evidence_level == "E0"


def test_normalized_live_capacity_qualifies_only_from_its_frozen_load_protocol(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    suite_id = _install_r2_suite(tmp_path / "bundles", suite_store)
    manifest = _live_manifest(
        "target-capacity-no-replay-qualification",
        suite_id,
        suite_store,
        track_ids=("capacity",),
    )

    def fixed_capacity_execution(visible: Any, **kwargs: object) -> LiveRawResult:
        case = visible.cases[0]
        protocol = kwargs["capacity_load_protocol"]
        assert protocol == manifest.capacity_load_protocol
        assert protocol is not None
        records: list[ExecutionRecord] = []
        for concurrency in protocol.concurrency_levels:
            throughput = float(concurrency * 8)
            batches = (
                ("warmup", 0, concurrency * protocol.warmup_request_multiplier),
                *(
                    (
                        "measurement",
                        repetition,
                        protocol.measurement_requests_per_repetition,
                    )
                    for repetition in range(1, protocol.repetitions_per_level + 1)
                ),
            )
            for phase, repetition, request_count in batches:
                elapsed = request_count / throughput
                for request_index in range(request_count):
                    attempt_id = (
                        f"capacity-c{concurrency}-{phase[0]}"
                        f"{repetition}-q{request_index}"
                    )
                    records.append(
                        ExecutionRecord(
                            id=attempt_id,
                            track_id="capacity",
                            case_id=case.id,
                            attempt_id=attempt_id,
                            status="succeeded",
                            success=True,
                            latency_ms=12.0,
                            input_tokens=1,
                            output_tokens=1,
                            runtime_cost=0.001,
                            concurrency=concurrency,
                            throughput_rps=throughput,
                            load_elapsed_seconds=elapsed,
                            load_phase=phase,
                            load_repetition=repetition,
                            load_request_index=request_index,
                            evidence_kind="capacity.closed-loop.v1",
                        )
                    )
        return LiveRawResult(
            records=records,
            discovered_entrypoints=("entrypoint-a",),
            routing_traces=(),
            chat_results={},
            model_pool_results={},
            model_pool_arm_ids=(),
            joint_results={},
        )

    monkeypatch.setattr(
        "cli.evaluation.normalized_suite_live_executor.execute_live_raw",
        fixed_capacity_execution,
    )
    report = run_evaluation(
        manifest,
        LocalArtifactStore(tmp_path / "evaluation"),
        suite_store=suite_store,
    )

    gate = next(row for row in report.gates if row.id == "G7")
    assert gate.disposition == "required"
    assert gate.verdict == "pass"
    assert gate.observed == 1
    assert gate.threshold is not None
    assert gate.threshold.operator == ">="
    assert gate.threshold.value == 0


def test_declared_track_without_qualification_artifact_is_unavailable(
    tmp_path: Path,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    bundle = tmp_path / "missing-safety"
    _base_bundle(bundle, "missing-private-case", track_ids=("safety",))
    request = _suite_request(
        bundle,
        adapter_id="acebench",
        suite_id="missing-safety-suite",
        case_id="missing-private-case",
        tracks=("safety",),
        optional_roles=(),
    )
    installed = suite_store.install(request, bundle, source_root=bundle.parent)
    manifest = _manifest(
        "missing-safety-run", (installed.id,), suite_store
    ).with_semantic_updates(track_ids=("safety",))

    report = run_evaluation(
        manifest,
        LocalArtifactStore(tmp_path / "evaluation"),
        suite_store=suite_store,
    )

    assert report.run.evidence_level == "E0"
    assert report.tracks[0].status == "unavailable"
    assert report.tracks[0].coverage.evaluated == 0
    records = (
        tmp_path / "evaluation" / "runs" / manifest.run_id / "records.jsonl"
    ).read_text()
    assert '"status":"unavailable"' in records
    assert "lacks safety enforcement observations" in records
    assert "PRIVATE NORMALIZED PROMPT" not in records
    assert "missing-private-case" not in records


def test_composite_sampling_is_stratified_per_suite_and_preserves_track_union(
    tmp_path: Path,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    suite_ids = _install_composite(tmp_path / "bundles", suite_store)
    manifest = _manifest("normalized-stratified", suite_ids, suite_store)
    manifest = manifest.with_semantic_updates(sample_limit=1)
    artifact_store = LocalArtifactStore(tmp_path / "evaluation")

    report = run_evaluation(
        manifest,
        artifact_store,
        suite_store=suite_store,
    )

    assert tuple(track.track_id for track in report.tracks) == TRACK_IDS
    assert all(track.status == "completed" for track in report.tracks)
    assert report.run.evidence_level == "E0"
    records = [
        ExecutionRecord.model_validate_json(row)
        for row in artifact_store.read_run_bytes(
            manifest.run_id, "records.jsonl"
        ).splitlines()
    ]
    evidence_by_track = {
        track_id: {row.evidence_kind for row in records if row.track_id == track_id}
        for track_id in TRACK_IDS
    }
    assert evidence_by_track == {
        track_id: {"normalized-suite-replay.v1;ceiling=E0"} for track_id in TRACK_IDS
    }


def test_imported_record_evidence_is_always_e0(
    tmp_path: Path,
) -> None:
    suite_store = NormalizedSuiteStore(tmp_path / "suite-store")
    bundle = tmp_path / "bundles" / "routerarena"
    case_id = "routerarena-case"
    _qualification_cases(bundle, (case_id,), track_ids=("routing",))
    _write_jsonl(bundle / "grading/decisions.jsonl", (_decision(case_id),))
    suite_id = suite_store.install(
        _suite_request(
            bundle,
            adapter_id="routerarena",
            suite_id="imported-routerarena",
            case_id=case_id,
            tracks=("routing",),
            optional_roles=("decisions",),
        ),
        bundle,
        source_root=bundle.parent,
    ).id
    manifest = suite_store.get_suite_manifest(suite_id)
    visible = next(suite_store.load_jsonl(suite_id, "visible_cases"))
    grading = next(suite_store.load_jsonl(suite_id, "grading_cases"))
    case = SelectedCase(
        manifest=manifest,
        source_visible=visible,  # type: ignore[arg-type]
        source_grading=grading,  # type: ignore[arg-type]
        visible=visible,  # type: ignore[arg-type]
        grading=grading,  # type: ignore[arg-type]
        executor_id=NORMALIZED_REPLAY_EXECUTOR_ID,
    )

    assert manifest.qualification_receipt.evidence_level == "E0"
    assert manifest.qualification_receipt.qualified_gate_ids == ()
    assert evidence_kind(case, "routing") == "normalized-suite-replay.v1;ceiling=E0"


def test_imported_robustness_pairs_remain_e0_and_cannot_pass_g4(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "robustness"
    case_ids = ("source", "perturbed")
    _qualification_cases(bundle, case_ids, track_ids=("routing",))
    _write_jsonl(
        bundle / "grading/decisions.jsonl",
        (_decision(case_id) for case_id in case_ids),
    )
    _write_jsonl(
        bundle / "grading/perturbations.jsonl",
        (
            NormalizedPerturbation(
                pair_id="pair-1",
                source_case_id="source",
                perturbed_case_id="perturbed",
                relation="invariant",
                slice_ids=("routerarena:paraphrase",),
                native_pair_count=1,
                source_record_digest=_digest("pair-1"),
            ),
        ),
    )
    request = _suite_request(
        bundle,
        adapter_id="routerarena",
        suite_id="imported-robustness",
        case_id="source",
        tracks=("routing",),
        optional_roles=("decisions", "perturbations"),
        case_count=2,
    )

    suite_store = NormalizedSuiteStore(tmp_path / "store")
    manifest = suite_store.install(request, bundle, source_root=bundle.parent)
    assert manifest.qualification_receipt.evidence_level == "E0"
    assert manifest.qualification_receipt.qualified_gate_ids == ()
    run = _manifest(
        "method-only-g4", (manifest.id,), suite_store
    ).with_semantic_updates(track_ids=("routing",))
    report = run_evaluation(
        run, LocalArtifactStore(tmp_path / "evaluation"), suite_store=suite_store
    )
    assert report.run.evidence_level == "E0"
    assert (
        next(gate for gate in report.gates if gate.id == "G4").verdict == "unavailable"
    )
