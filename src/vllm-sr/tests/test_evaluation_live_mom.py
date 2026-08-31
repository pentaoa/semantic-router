from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pytest
from cli.evaluation import live_executor as live_executor_module
from cli.evaluation.contract_validation import derived_portable_id, is_portable_id
from cli.evaluation.fixtures import fixture_inputs
from cli.evaluation.http_client import EvaluationHTTPClient, HTTPResult
from cli.evaluation.live_chat import execute_chat_cases
from cli.evaluation.live_executor import (
    LiveRawResult,
    execute_live_raw,
    grade_live_execution,
)
from cli.evaluation.live_mom_cases import LIVE_MOM_CASE_COUNT, live_mom_case_sets
from cli.evaluation.orchestrator import run_evaluation
from cli.evaluation.store import LocalArtifactStore
from test_evaluation_live import (
    _LIVE_TRACKS,
    CatalogSession,
    FailingSession,
    FakeResponse,
    FakeSession,
    _arms,
    _manifest,
    _mixture,
    _run,
)


@pytest.mark.parametrize(
    ("rows", "message"),
    (
        (
            [
                {
                    "id": "entrypoint-a",
                    "routing": {
                        "resolution": "virtual",
                        "selectable": True,
                        "default_route": True,
                        "recipe": "other-recipe",
                    },
                },
            ],
            "does not expose frozen mixture alias",
        ),
        (
            [
                {
                    "id": "entrypoint-b",
                    "routing": {
                        "resolution": "virtual",
                        "selectable": True,
                        "default_route": True,
                        "recipe": "other-recipe",
                    },
                },
            ],
            "does not bind recipe",
        ),
        (
            [
                {
                    "id": "entrypoint-b",
                    "routing": {
                        "resolution": "virtual",
                        "selectable": True,
                        "default_route": True,
                        "recipe": "fixture-recipe",
                    },
                },
                {
                    "id": "entrypoint-b",
                    "routing": {
                        "resolution": "virtual",
                        "selectable": True,
                        "default_route": False,
                        "recipe": "fixture-recipe",
                    },
                },
            ],
            "duplicate virtual entrypoints",
        ),
        (
            [{"id": "entrypoint-b", "routing": {"resolution": "virtual"}}],
            "routing flags must be boolean",
        ),
    ),
)
def test_live_executor_rejects_catalogs_that_do_not_attest_the_frozen_mixture(
    rows: list[dict[str, Any]], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        execute_live_raw(
            fixture_inputs().visible,
            track_ids=("routing",),
            router_api_url="http://router:8080",
            envoy_url="http://envoy:8801",
            concurrency=1,
            capacity_load_protocol=None,
            mixture=_mixture(),
            client=EvaluationHTTPClient(session=CatalogSession(rows)),
        )


def test_live_model_pool_and_joint_execute_the_same_dense_cohort() -> None:
    _, result = _run(FakeSession(), track_ids=("model_pool", "joint"))
    pool = [row for row in result.records if row.track_id == "model_pool"]
    joint = [row for row in result.records if row.track_id == "joint"]
    assert {row.case_id for row in pool} == {row.case_id for row in joint}
    assert len(pool) == len(joint) * len(_arms())


def test_derived_live_evidence_ids_are_stable_and_bounded() -> None:
    case_id = "case-" + "c" * 122
    arm_id = "arm-" + "a" * 123
    first = derived_portable_id("attempt-model-pool", case_id, arm_id)
    second = derived_portable_id("attempt-model-pool", case_id, arm_id)
    sibling = derived_portable_id("attempt-model-pool", case_id, arm_id[:-1] + "b")

    assert first == second
    assert first != sibling
    assert is_portable_id(first)
    assert len(first) <= 128
    assert derived_portable_id("model-pool", "case-a", "arm-b") != derived_portable_id(
        "model-pool", "case", "a-arm-b"
    )
    overflow = derived_portable_id("attempt", "x" * 128)
    assert derived_portable_id("attempt", overflow.removeprefix("attempt-")) != overflow


def test_multimodal_probe_compacts_a_maximum_length_case_identity() -> None:
    case = fixture_inputs().visible.cases[0].model_copy(update={"id": "c" * 128})
    attempts: list[str] = []

    class CapturingClient:
        def post(self, _endpoint: str, _payload: object, **metadata: str) -> HTTPResult:
            attempts.append(metadata["attempt_id"])
            return HTTPResult(
                success=False,
                status_code=503,
                payload=None,
                latency_ms=1,
                headers={},
                error="HTTP 503",
            )

    execute_chat_cases(
        CapturingClient(),  # type: ignore[arg-type]
        "http://envoy.test/v1/chat/completions",
        (case,),
        "vllm-sr/auto",
    )

    assert attempts == [derived_portable_id("attempt", case.id)]
    assert is_portable_id(attempts[0])


def test_live_mom_cohort_is_layered_exact_and_has_no_synthetic_routes() -> None:
    visible, grading = live_mom_case_sets()
    assert len(visible.cases) == len(grading.cases) == LIVE_MOM_CASE_COUNT
    assert len({case.id for case in visible.cases}) == LIVE_MOM_CASE_COUNT
    assert {case.id for case in visible.cases} == {
        label.case_id for label in grading.cases
    }
    assert all(
        case.track_ids == ("routing", "model_pool", "joint") for case in visible.cases
    )
    assert all(
        "Return exactly" in str(case.messages[0].content) for case in visible.cases
    )
    assert all(
        any(tag.startswith("domain:") for tag in case.tags) for case in visible.cases
    )
    assert all(
        any(tag.startswith("difficulty:") for tag in case.tags)
        for case in visible.cases
    )
    assert all(label.expected_route is None for label in grading.cases)
    assert all(label.expected_answer for label in grading.cases)


def test_live_model_pool_concurrency_is_bounded_and_records_are_canonical() -> None:
    class ConcurrentSession(FakeSession):
        def __init__(self) -> None:
            super().__init__()
            self.lock = threading.Lock()
            self.release = threading.Event()
            self.active = 0
            self.max_active = 0

        def post(
            self,
            url: str,
            json: dict[str, Any],
            headers: dict[str, str],
            timeout: float,
        ) -> FakeResponse:
            if url.endswith("/v1/chat/completions"):
                with self.lock:
                    self.active += 1
                    self.max_active = max(self.max_active, self.active)
                    if self.active == 2:
                        self.release.set()
                assert self.release.wait(2)
                try:
                    return super().post(url, json, headers, timeout)
                finally:
                    with self.lock:
                        self.active -= 1
            return super().post(url, json, headers, timeout)

    session = ConcurrentSession()
    raw = execute_live_raw(
        fixture_inputs().visible,
        track_ids=("model_pool",),
        router_api_url=None,
        envoy_url="http://envoy:8801",
        concurrency=2,
        capacity_load_protocol=None,
        mixture=_mixture(),
        client=EvaluationHTTPClient(session=session),
    )
    records = [row for row in raw.records if row.track_id == "model_pool"]
    assert session.max_active == 2
    assert [(row.case_id, row.arm_id) for row in records] == [
        (case.id, arm.id) for case in fixture_inputs().visible.cases for arm in _arms()
    ]


def test_routing_oracle_requires_every_frozen_arm_outcome() -> None:
    visible, grading = live_mom_case_sets()
    visible = visible.model_copy(update={"cases": visible.cases[:2]})
    grading = grading.model_copy(update={"cases": grading.cases[:2]})
    raw = execute_live_raw(
        visible,
        track_ids=("routing", "model_pool"),
        router_api_url="http://router:8080",
        envoy_url="http://envoy:8801",
        concurrency=2,
        capacity_load_protocol=None,
        mixture=_mixture(),
        client=EvaluationHTTPClient(session=FakeSession()),
    )
    missing_key = (visible.cases[0].id, _arms()[0].id)
    incomplete = LiveRawResult(
        records=[
            row
            for row in raw.records
            if not (
                row.track_id == "model_pool"
                and (row.case_id, row.arm_id) == missing_key
            )
        ],
        discovered_entrypoints=raw.discovered_entrypoints,
        routing_traces=raw.routing_traces,
        chat_results=raw.chat_results,
        model_pool_results={
            key: result
            for key, result in raw.model_pool_results.items()
            if key != missing_key
        },
        model_pool_arm_ids=raw.model_pool_arm_ids,
        joint_results=raw.joint_results,
    )
    result = grade_live_execution(incomplete, grading)
    routed = next(
        row
        for row in result.records
        if row.track_id == "routing" and row.case_id == visible.cases[0].id
    )
    assert routed.quality is None
    assert routed.grader is None


def test_live_entrypoint_attestation_ignores_defaults_and_other_mixtures() -> None:
    rows = [
        {
            "id": "entrypoint-a",
            "routing": {
                "resolution": "virtual",
                "selectable": True,
                "default_route": True,
                "recipe": "other-recipe",
            },
        },
        {
            "id": "entrypoint-b",
            "routing": {
                "resolution": "virtual",
                "selectable": True,
                "default_route": True,
                "recipe": "fixture-recipe",
            },
        },
        {
            "id": "another-default-alias",
            "routing": {
                "resolution": "virtual",
                "selectable": True,
                "default_route": True,
                "recipe": "other-recipe",
            },
        },
    ]
    session = CatalogSession(rows)
    raw = execute_live_raw(
        fixture_inputs().visible,
        track_ids=("routing",),
        router_api_url="http://router:8080",
        envoy_url="http://envoy:8801",
        concurrency=1,
        capacity_load_protocol=None,
        mixture=_mixture(),
        client=EvaluationHTTPClient(session=session),
    )
    assert raw.discovered_entrypoints == ("entrypoint-b",)
    assert {payload["model"] for _, payload, _ in session.posts} == {"entrypoint-b"}


@pytest.mark.parametrize("track_id", ("agentic", "preference", "safety"))
def test_live_mom_executor_rejects_unowned_tracks(track_id: str) -> None:
    with pytest.raises(ValueError, match="does not own tracks"):
        _run(FakeSession(), track_ids=(track_id,))


def test_http_client_separates_env_credentials_and_redacts_request_exceptions(
    monkeypatch: Any,
) -> None:
    monkeypatch.setenv("VLLM_SR_EVAL_API_KEY", "implicit-secret")
    uncredentialed_session = FakeSession()
    EvaluationHTTPClient(session=uncredentialed_session).post(
        "http://router:8080/api/v1/eval",
        {"model": "auto"},
        track_id="routing",
        case_id="case-1",
        attempt_id="attempt-1",
    )
    assert "Authorization" not in uncredentialed_session.posts[0][2]

    monkeypatch.setenv("ROUTER_EVAL_KEY", "router-secret")
    session = FakeSession()
    client = EvaluationHTTPClient(session=session, credential_env="ROUTER_EVAL_KEY")
    client.post(
        "http://router:8080/api/v1/eval",
        {"model": "auto"},
        track_id="routing",
        case_id="case-1",
        attempt_id="attempt-1",
    )
    assert session.posts[0][2]["Authorization"] == "Bearer router-secret"

    failed = EvaluationHTTPClient(session=FailingSession()).post(
        "http://private-host:8080/v1/chat/completions",
        {"model": "auto"},
        track_id="capacity",
        case_id="case-1",
        attempt_id="attempt-1",
    )
    assert failed.error == "request_error:ConnectionError"
    assert "private-host" not in (failed.error or "")
    assert "literal-secret" not in (failed.error or "")

    monkeypatch.setenv("ENVOY_EVAL_KEY", "envoy-secret")
    created: list[str | None] = []

    def client_factory(*, credential_env: str | None = None) -> EvaluationHTTPClient:
        created.append(credential_env)
        return EvaluationHTTPClient(session=session, credential_env=credential_env)

    monkeypatch.setattr(live_executor_module, "EvaluationHTTPClient", client_factory)
    execute_live_raw(
        fixture_inputs().visible,
        track_ids=("routing", "multimodal"),
        router_api_url="http://router:8080",
        envoy_url="http://envoy:8801",
        concurrency=1,
        capacity_load_protocol=None,
        mixture=_mixture(),
        router_api_key_env="ROUTER_EVAL_KEY",
        envoy_api_key_env="ENVOY_EVAL_KEY",
    )
    assert created == ["ROUTER_EVAL_KEY", "ENVOY_EVAL_KEY"]
    authorization_values = {
        headers.get("Authorization") for _, _, headers in session.posts
    }
    assert {"Bearer router-secret", "Bearer envoy-secret"} <= authorization_values


def test_live_run_writes_trace_capacity_and_rich_metric_artifacts(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    clock = iter(float(value) for value in range(100))
    monkeypatch.setattr(
        "cli.evaluation.load_executor.perf_counter", lambda: next(clock)
    )
    monkeypatch.setattr(
        live_executor_module,
        "chat_request",
        lambda *_args, **_kwargs: HTTPResult(
            success=True,
            status_code=200,
            payload={
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            },
            latency_ms=50,
            headers={
                "x-vsr-selected-model": "provider-strong",
                "x-vsr-selected-algorithm": "weighted-lottery",
            },
        ),
    )

    def fixed_raw(visible: Any, **kwargs: object) -> LiveRawResult:
        assert "grading" not in kwargs
        return execute_live_raw(
            visible,
            **kwargs,
            client=EvaluationHTTPClient(session=FakeSession()),
        )

    monkeypatch.setattr("cli.evaluation.builtin_executors.execute_live_raw", fixed_raw)
    store = LocalArtifactStore(tmp_path / "store")
    report = run_evaluation(_manifest(), store)
    artifacts = {artifact.name for artifact in report.artifacts}
    assert {"routing-traces.jsonl", "capacity-profile.json"} <= artifacts

    traces = store.read_run_text(report.run.id, "routing-traces.jsonl")
    records = store.read_run_text(report.run.id, "records.jsonl")
    for private_value in (
        "original_text",
        "must never be persisted",
        "secret.invalid",
        "private free-form reason",
    ):
        assert private_value not in traces
        assert private_value not in records
    capacity = store.read_run_json(report.run.id, "capacity-profile.json")
    assert [level["concurrency"] for level in capacity["levels"]] == [1, 2, 3]
    assert capacity["kind"] == "repeated-closed-loop-capacity"
    assert report.run.capacity_load_protocol is not None
    assert capacity["protocol"] == report.run.capacity_load_protocol.model_dump(
        mode="json", exclude_none=False
    )
    assert report.run.capacity_slo is not None
    assert capacity["slo"] == report.run.capacity_slo.model_dump(
        mode="json", exclude_none=False
    )
    assert capacity["assessment"]["verdict"] == "pass"
    assert capacity["assessment"]["qualified_concurrency"] == 3
    assert capacity["assessment"]["slo_headroom"] == 0

    metrics = {metric.id: metric for metric in report.metrics}
    assert metrics["routing.accuracy"].value == 1.0
    persisted_records = [
        json.loads(line) for line in records.splitlines() if line.strip()
    ]
    assert {
        row["grader"] for row in persisted_records if row["track_id"] == "routing"
    } == {"dense-pool-oracle.v1"}
    assert metrics["capacity.latency_p99_ms"].value is not None
    assert metrics["capacity.level.1.throughput_rps"].value is not None
    assert metrics["capacity.slo_headroom"].value == 0
    assert metrics["capacity.cost_per_successful_request"].value is not None
    assert report.provenance.binding_snapshot_digest is not None
    lineage = store.read_run_json(report.run.id, "lineage.json")
    assert lineage["policy"]["entrypoint_model"] == "entrypoint-b"
    levels = {track.track_id: track.evidence_level for track in report.tracks}
    assert levels == {
        "routing": "E3",
        "model_pool": "E4",
        "joint": "E5",
        "multimodal": "E0",
        "capacity": "E0",
    }
    assert report.run.evidence_level == "E0"
    assert report.summary.quality_score is None

    persisted_metrics = store.read_run_json(report.run.id, "metrics.json")["metrics"]
    assert persisted_metrics == [
        metric.model_dump(mode="json", exclude_none=False) for metric in report.metrics
    ]
    assert {metric["track_id"] for metric in persisted_metrics} == set(_LIVE_TRACKS)
