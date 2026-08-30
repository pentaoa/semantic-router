from __future__ import annotations

import hashlib
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
from cli.evaluation.builtin_executors import (
    DEFAULT_EXECUTOR_REGISTRY,
    FixtureReplayExecutor,
)
from cli.evaluation.canonical import digest_value
from cli.evaluation.case_plan import project_visible_case_set
from cli.evaluation.catalog import CatalogSuite, get_catalog
from cli.evaluation.constants import TRACK_IDS
from cli.evaluation.contracts import (
    EvaluationTarget,
    EvaluationTargetArm,
    GradingCaseSet,
    ManifestMixture,
    Message,
    MixtureDecisionBinding,
    RunManifest,
    VisibleCaseSet,
)
from cli.evaluation.evidence import ExecutionRecord
from cli.evaluation.evidence_collection import collect_evidence
from cli.evaluation.execution_contract import (
    FIXTURE_REPLAY_EXECUTOR_ID,
    MOM_REPLAY_EXECUTOR_ID,
)
from cli.evaluation.execution_plan import (
    DEFAULT_SUITE_REGISTRY,
    resolve_execution_plan,
)
from cli.evaluation.executor_contracts import ExecutorContract
from cli.evaluation.executor_registry import CollectedEvidence, ExecutorRegistry
from cli.evaluation.fixture_executor import execute_fixture
from cli.evaluation.fixtures import fixture_inputs
from cli.evaluation.live_executor import LiveRawResult
from cli.evaluation.live_mom_cases import LIVE_MOM_CASE_COUNT, live_mom_case_sets
from cli.evaluation.manifest_identity import (
    mixture_target_id,
    model_pool_snapshot_digest,
    selector_snapshot_digest,
)
from cli.evaluation.metrics import compute_metrics
from cli.evaluation.mom_replay_executor import mom_replay_fixture
from cli.evaluation.orchestrator import run_evaluation, validate_manifest
from cli.evaluation.reporting import EvaluationReport
from cli.evaluation.resolution import resolve_snapshot, sample_fixture
from cli.evaluation.runtime_factors import runtime_factors
from cli.evaluation.store import LocalArtifactStore


class _ExecutorStub:
    def __init__(self, executor_id: str):
        self.contract = ExecutorContract(
            id=executor_id,
            mode="replay",
            suite_class="test-provider",
            target_profile="recorded-source",
            lineage_profile="fixture-replay",
            track_ids=TRACK_IDS,
            requires_fixture_ref=True,
        )

    def collect(self, *args: object, **kwargs: object) -> object:
        raise AssertionError("registry contract test must not execute the stub")


class _ProviderAgenticExecutor:
    contract = ExecutorContract(
        id="provider-agentic-live.v1",
        mode="live",
        suite_class="runtime",
        target_profile="brokered-runtime",
        lineage_profile="runtime",
        track_ids=("agentic", "preference", "safety"),
        evidence_level_ceiling="E0",
    )

    def collect(self, manifest, store, plan, suite_store) -> CollectedEvidence:
        del suite_store
        source = sample_fixture(fixture_inputs(), manifest.sample_limit, manifest.seed)
        assert source.fixture is not None
        visible = project_visible_case_set(source.visible, manifest.track_ids)
        records = execute_fixture(
            visible, source.grading, source.fixture, manifest.track_ids
        )
        discovered_entrypoints = ("provider-agent-entrypoint",)
        factors = runtime_factors(manifest)
        inputs = replace(
            source,
            visible=visible,
            fixture=None,
            policy=factors.policy,
            arms=factors.arms,
            pool=factors.pool,
            binding=factors.binding,
            environment=factors.environment,
            suite_revisions=dict(plan.suite_revisions),
            suite_executors=dict(plan.suite_executors),
            executor_ids=dict.fromkeys(manifest.track_ids, self.contract.id),
        )
        return CollectedEvidence(
            inputs=inputs,
            visible_ref=store.put_json(inputs.visible),
            grading_ref=store.put_json(inputs.grading),
            fixture_ref=None,
            records=records,
            discovered_entrypoints=discovered_entrypoints,
            routing_traces=(),
        )


class _MissingFixtureExecutor:
    contract = FixtureReplayExecutor.contract

    def collect(self, *args: object, **kwargs: object) -> CollectedEvidence:
        collected = FixtureReplayExecutor().collect(*args, **kwargs)
        return replace(collected, fixture_ref=None)


class _UnexpectedFixtureExecutor:
    contract = ExecutorContract(
        id="unexpected-fixture.v1",
        mode="replay",
        suite_class="test-provider",
        target_profile="recorded-source",
        lineage_profile="runtime",
        track_ids=TRACK_IDS,
    )

    def collect(self, *args: object, **kwargs: object) -> CollectedEvidence:
        collected = FixtureReplayExecutor().collect(*args, **kwargs)
        return replace(
            collected,
            inputs=replace(
                collected.inputs,
                suite_executors={"evaluation-smoke": self.contract.id},
                executor_ids=dict.fromkeys(TRACK_IDS, self.contract.id),
            ),
        )


def _uuid(name: str) -> str:
    try:
        if str(uuid.UUID(name)) == name:
            return name
    except ValueError:
        pass
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"vllm-sr-evaluation:{name}"))


def _manifest(
    run_id: str = "fixture-run",
    sample_limit: int = 4,
    *,
    baseline_run_id: str | None = None,
    code_revision: str = "sha256:" + "1" * 64,
) -> RunManifest:
    return RunManifest.from_semantic_fields(
        run_id=_uuid(run_id),
        name=f"Evaluation {run_id}",
        description="Engine contract fixture",
        mode="replay",
        target=EvaluationTarget(id="fixture", kind="builtin-fixture"),
        change_profile="schema_adapter",
        gate_contract_version="evaluation-release-gates.v2",
        suite_ids=("evaluation-smoke",),
        suite_revisions={"evaluation-smoke": "builtin-v1"},
        suite_executors={"evaluation-smoke": FIXTURE_REPLAY_EXECUTOR_ID},
        track_ids=TRACK_IDS,
        sample_limit=sample_limit,
        concurrency=2,
        seed=17,
        baseline_run_id=_uuid(baseline_run_id) if baseline_run_id else None,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        code_revision=code_revision,
        policy_snapshot_digest=fixture_inputs().policy.recipe_digest,
        config_digest="sha256:"
        + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        redaction_policy="public-safe-v1",
    )


def _live_mixture(
    arms: tuple[EvaluationTargetArm, ...],
    *,
    entrypoint_model: str = "entrypoint-a",
) -> ManifestMixture:
    recipe_name = "fixture-recipe"
    recipe_digest = digest_value("live-policy")
    pool_digest = model_pool_snapshot_digest(arms)
    aliases = (entrypoint_model,)
    mixture_id = mixture_target_id(recipe_name)
    selector_policy_digest = digest_value("live-selector-policy")
    return ManifestMixture(
        id=mixture_id,
        entrypoint_model=entrypoint_model,
        aliases=aliases,
        recipe_name=recipe_name,
        recipe_description="Live engine test recipe",
        recipe_digest=recipe_digest,
        pool_digest=pool_digest,
        selector_policy_digest=selector_policy_digest,
        selector_digest=selector_snapshot_digest(selector_policy_digest, ()),
        adaptation_digest=digest_value("live-adaptation"),
        binding_digest=digest_value(f"live-binding:{entrypoint_model}"),
        model_arms=arms,
        support_models=(),
        fallback_arm_id=arms[0].id,
        decisions=(
            MixtureDecisionBinding(
                name="default",
                algorithm="static" if len(arms) > 1 else "single",
                arm_ids=tuple(sorted(arm.id for arm in arms)),
            ),
        ),
    )


def _live_manifest(
    run_id: str,
    *,
    envoy_url: str = "http://envoy:8801",
    price_delta: float = 0,
    topology_digest: str = "sha256:" + "b" * 64,
) -> RunManifest:
    arms = fixture_inputs().arms
    if price_delta:
        first = arms[0].model_copy(
            update={
                "input_cost_per_million_tokens_usd": (
                    arms[0].input_cost_per_million_tokens_usd + price_delta
                )
            }
        )
        arms = (first, *arms[1:])
    mixture = _live_mixture(arms)
    return RunManifest.from_semantic_fields(
        run_id=_uuid(run_id),
        name=f"Live evaluation {run_id}",
        description="Live engine contract fixture",
        mode="live",
        target=EvaluationTarget(
            id=mixture.id,
            kind="mixture-of-models",
            router_api_url="http://router:8080",
            envoy_url=envoy_url,
            backend_topology_digest=topology_digest,
            mixture=mixture,
        ),
        change_profile="recipe",
        gate_contract_version="evaluation-release-gates.v2",
        suite_ids=("live-mom-core",),
        suite_revisions={"live-mom-core": "mom-campaign-cohort-v1"},
        suite_executors={"live-mom-core": "live-runtime.v1"},
        track_ids=("routing",),
        sample_limit=4,
        concurrency=2,
        seed=17,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        code_revision="sha256:" + "1" * 64,
        policy_snapshot_digest=digest_value("live-policy"),
        config_digest="sha256:"
        + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        redaction_policy="public-safe-v1",
    )


def _mom_replay_manifest(run_id: str = "mom-replay") -> RunManifest:
    live = _live_manifest(run_id)
    return live.with_semantic_updates(
        mode="replay",
        suite_executors={"live-mom-core": MOM_REPLAY_EXECUTOR_ID},
        track_ids=("routing", "model_pool", "joint"),
        sample_limit=LIVE_MOM_CASE_COUNT,
    )


def _resolved_live(manifest: RunManifest, store: LocalArtifactStore):
    factors = runtime_factors(manifest)
    inputs = replace(
        fixture_inputs(),
        policy=factors.policy,
        arms=factors.arms,
        pool=factors.pool,
        binding=factors.binding,
        environment=factors.environment,
        suite_revisions=dict(manifest.suite_revisions),
        suite_executors=dict(manifest.suite_executors),
        executor_ids=dict.fromkeys(manifest.track_ids, "live-runtime.v1"),
    )
    return resolve_snapshot(
        manifest,
        inputs,
        store.put_json(inputs.visible),
        store.put_json(inputs.grading),
        None,
        ("entrypoint-a",),
    )


def _records(store: LocalArtifactStore, run_id: str) -> list[ExecutionRecord]:
    return [
        ExecutionRecord.model_validate_json(line)
        for line in store.read_run_bytes(run_id, "records.jsonl").splitlines()
    ]


def _assert_fixture_run_summary(report: EvaluationReport) -> None:
    assert tuple(track.track_id for track in report.tracks) == TRACK_IDS
    assert all(track.status == "completed" for track in report.tracks)
    assert report.summary.coverage.evaluated == report.summary.coverage.total == 29
    assert report.summary.failed_gates == 0
    assert report.summary.quality_score is None
    assert report.summary.runtime_cost is None
    assert report.summary.capacity_tco is None
    assert report.costs.runtime.amount is not None
    assert report.costs.capacity_tco.amount is not None
    assert report.costs.evaluation_overhead.amount is not None
    assert report.recommendations[0].startswith("E0 diagnostic only")
    assert not any(row.startswith("[AF-") for row in report.recommendations)
    verdicts = {gate.id: gate.verdict for gate in report.gates}
    assert verdicts["G8"] == "not_applicable"
    assert verdicts["G9"] == "not_applicable"


def _assert_fixture_metrics(report: EvaluationReport) -> None:
    metrics = {metric.id: metric.value for metric in report.metrics}
    assert {
        "routing.abstention_rate",
        "routing.fallback_rate",
        "routing.success_rate",
        "routing.selection_entropy_bits",
        "model_pool.best_single_quality",
        "model_pool.arm_count",
        "model_pool.oracle_gain",
        "model_pool.unique_win_rate",
        "model_pool.selection_entropy_bits",
        "model_pool.selection_arm_coverage",
        "model_pool.quality_dominated_arm_count",
        "model_pool.pareto_evaluable_arm_count",
        "model_pool.pareto_dominated_arm_count",
        "model_pool.mean_pairwise_failure_jaccard",
        "model_pool.worst_arm_reliability",
        "model_pool.all_arm_failure_rate",
        "joint.normalized_regret",
        "joint.reliability",
        "joint.oracle_capture_ratio",
        "joint.runtime_cost_per_success",
        "agentic.mean_trajectory_steps",
        "agentic.privacy_exposures_per_trajectory",
        "multimodal.image.support_rate",
        "multimodal.image.quality",
        "preference.effective_sample_size",
        "preference.effective_sample_ratio",
        "preference.self_normalized_ips_agreement",
        "safety.violation_upper_95",
        "safety.false_negative_rate",
        "safety.false_positive_rate",
        "capacity.cost_per_successful_request",
        "capacity.success_concurrency_upper_bound",
    } <= set(metrics)
    assert metrics["safety.violation_rate"] == 0
    assert metrics["safety.violation_upper_95"] > 0
    assert metrics["safety.false_negative_rate"] == 0
    assert metrics["safety.false_positive_rate"] == 0
    assert metrics["model_pool.arm_count"] == 2
    assert metrics["model_pool.quality_dominated_arm_count"] == 0
    assert metrics["model_pool.pareto_evaluable_arm_count"] == 2
    assert metrics["model_pool.pareto_dominated_arm_count"] == 1
    assert metrics["model_pool.mean_pairwise_failure_jaccard"] == 0
    assert metrics["model_pool.worst_arm_reliability"] == 0.75
    assert metrics["model_pool.all_arm_failure_rate"] == 0
    assert metrics["agentic.mean_trajectory_steps"] == 2.5
    assert metrics["preference.effective_sample_size"] == 1
    assert metrics["preference.effective_sample_ratio"] == 1
    assert metrics["preference.self_normalized_ips_agreement"] == 1
    assert metrics["capacity.success_concurrency_upper_bound"] == 8
    assert any(metric_id.endswith("marginal_contribution") for metric_id in metrics)


def _assert_fixture_bundle(report: EvaluationReport, store: LocalArtifactStore) -> None:
    names = {artifact.name for artifact in report.artifacts}
    assert names == {
        "metrics.json",
        "gates.json",
        "provenance.json",
        "failure-summary.json",
        "checksums.sha256",
    }
    assert "report.json" not in names
    assert all("/" not in (artifact.uri or "") for artifact in report.artifacts)

    checksum_lines = (
        (store.runs / report.run.id / "checksums.sha256").read_text().splitlines()
    )
    checksums = dict(line.split("  ", 1)[::-1] for line in checksum_lines)
    assert set(checksums) == names - {"checksums.sha256"}
    for name, expected in checksums.items():
        actual = hashlib.sha256(
            (store.runs / report.run.id / name).read_bytes()
        ).hexdigest()
        assert actual == expected

    private_checksum_lines = (
        (store.runs / report.run.id / "private-checksums.sha256")
        .read_text()
        .splitlines()
    )
    private_checksums = dict(
        line.split("  ", 1)[::-1] for line in private_checksum_lines
    )
    assert {
        "run-manifest.json",
        "cases.jsonl",
        "grading-cases.jsonl",
        "records.jsonl",
        "lineage.json",
        "failure-cases.jsonl",
        "report.md",
        "report.html",
        "checksums.sha256",
    } <= set(private_checksums)
    assert "private-checksums.sha256" not in names


def test_fixture_run_completes_all_tracks_with_rich_bundle(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "store")
    report = run_evaluation(_manifest(), store)

    _assert_fixture_run_summary(report)
    _assert_fixture_metrics(report)
    _assert_fixture_bundle(report, store)


def test_rich_pool_and_preference_reducers_preserve_decision_information() -> None:
    pool_records = [
        ExecutionRecord(
            id=f"pool-{case_id}-{arm_id}",
            track_id="model_pool",
            case_id=case_id,
            attempt_id=f"attempt-{case_id}-{arm_id}",
            status="succeeded",
            arm_id=arm_id,
            success=True,
            quality=quality,
            runtime_cost=runtime_cost,
        )
        for case_id, arm_id, quality, runtime_cost in (
            ("case-1", "arm-a", 0.5, 0.3),
            ("case-1", "arm-b", 0.6, 0.2),
            ("case-2", "arm-a", 0.4, 0.3),
            ("case-2", "arm-b", 0.4, 0.2),
        )
    ]
    preference_records = [
        ExecutionRecord(
            id=f"preference-{index}",
            track_id="preference",
            case_id=f"preference-case-{index}",
            attempt_id=f"preference-attempt-{index}",
            status="succeeded",
            success=True,
            preference_match=matched,
            behavior_propensity=propensity,
        )
        for index, (matched, propensity) in enumerate(
            ((True, 0.1), (False, 0.9)), start=1
        )
    ]

    metrics = {
        metric.id: metric.value
        for metric in compute_metrics(
            pool_records + preference_records,
            capacity_profile=None,
        )
    }

    assert metrics["model_pool.quality_dominated_arm_count"] == 1
    assert metrics["model_pool.pareto_evaluable_arm_count"] == 2
    assert metrics["model_pool.pareto_dominated_arm_count"] == 1
    assert metrics["model_pool.mean_pairwise_failure_jaccard"] == 0
    assert metrics["model_pool.all_arm_failure_rate"] == 0
    assert metrics["preference.effective_sample_size"] == pytest.approx(
        1.2195121951219512
    )
    assert metrics["preference.effective_sample_ratio"] == pytest.approx(
        0.6097560975609756
    )
    assert metrics["preference.self_normalized_ips_agreement"] == pytest.approx(0.9)


def test_executor_registry_is_explicit_and_rejects_ambiguous_ids() -> None:
    registry = ExecutorRegistry((_ExecutorStub("executor-a"),))
    assert registry.ids == ("executor-a",)
    assert registry.require("executor-a").contract.id == "executor-a"
    with pytest.raises(ValueError, match="unknown evaluation executor"):
        registry.require("missing")
    with pytest.raises(ValueError, match="duplicate evaluation executor"):
        ExecutorRegistry((_ExecutorStub("executor-a"), _ExecutorStub("executor-a")))

    validate_manifest(
        _manifest(),
        executor_registry=ExecutorRegistry(
            (_ExecutorStub(FIXTURE_REPLAY_EXECUTOR_ID),)
        ),
    )


def test_execution_entry_rejects_a_model_copy_that_bypassed_digest_validation() -> None:
    tampered = _manifest().model_copy(update={"name": "Tampered after validation"})

    with pytest.raises(ValueError, match="manifest_digest does not match"):
        validate_manifest(tampered)


def test_execution_identity_maps_are_immutable_after_resolution() -> None:
    manifest = _manifest()
    plan = resolve_execution_plan(
        manifest, None, DEFAULT_SUITE_REGISTRY, DEFAULT_EXECUTOR_REGISTRY
    )
    inputs = fixture_inputs()

    with pytest.raises(TypeError):
        plan.suite_revisions["evaluation-smoke"] = "changed"  # type: ignore[index]
    with pytest.raises(TypeError):
        plan.suite_executors["evaluation-smoke"] = "changed"  # type: ignore[index]
    with pytest.raises(TypeError):
        inputs.suite_executors["evaluation-smoke"] = "changed"  # type: ignore[index]
    with pytest.raises(TypeError):
        inputs.executor_ids["routing"] = "changed"  # type: ignore[index]

    reversed_grading = GradingCaseSet(cases=tuple(reversed(inputs.grading.cases)))
    with pytest.raises(ValueError, match="identical ordering"):
        replace(inputs, grading=reversed_grading)


def test_catalog_suite_mode_executor_contract_is_exact_and_immutable() -> None:
    fields = {
        "id": "installed-routing",
        "name": "Installed routing",
        "description": "One workload with distinct replay and live strategies.",
        "track_ids": ("routing",),
        "modes": ("replay", "live"),
        "evidence_level": "E0",
        "executors": {
            "replay": "normalized-suite-replay.v1",
            "live": "normalized-suite-live.v1",
        },
        "revision": "sha256:" + "a" * 64,
        "methods": (
            {
                "id": "installed.routing.v1",
                "track_id": "routing",
                "qualified_gate_ids": (),
                "evidence_source": "normalized_import",
                "status": "configured",
            },
        ),
    }
    suite = CatalogSuite.model_validate(fields)
    with pytest.raises(TypeError):
        suite.executors["replay"] = "changed"  # type: ignore[index]

    with pytest.raises(ValueError, match="exactly cover"):
        CatalogSuite.model_validate(
            {**fields, "executors": {"replay": "normalized-suite-replay.v1"}}
        )
    with pytest.raises(ValueError, match="canonical replay/live order"):
        CatalogSuite.model_validate({**fields, "modes": ("live", "replay")})
    with pytest.raises(ValueError):
        CatalogSuite.model_validate(
            {
                key: value
                for key, value in {
                    **fields,
                    "executor_id": "normalized-suite-replay.v1",
                }.items()
                if key != "executors"
            }
        )


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("modes", ("live",)),
        ("executors", {"replay": MOM_REPLAY_EXECUTOR_ID, "live": "wrong.v1"}),
        ("evidence_level", "E1"),
        ("case_count", LIVE_MOM_CASE_COUNT - 1),
        ("campaign_minimum_cases", 58),
        ("track_ids", ("routing", "model_pool")),
    ),
)
def test_campaign_eligibility_requires_the_exact_mom_cohort_contract(
    field: str, value: object
) -> None:
    suite = next(
        suite
        for suite in get_catalog(generated_at=False).suites
        if suite.id == "live-mom-core"
    )
    payload = suite.model_dump(mode="python")
    payload[field] = value

    with pytest.raises(ValueError):
        CatalogSuite.model_validate(payload)


def test_executor_output_is_validated_against_the_resolved_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = _manifest()
    plan = resolve_execution_plan(
        manifest, None, DEFAULT_SUITE_REGISTRY, DEFAULT_EXECUTOR_REGISTRY
    )
    store = LocalArtifactStore(tmp_path / "store")

    drifted_plan = replace(
        plan, suite_revisions={"evaluation-smoke": "different-revision"}
    )
    with pytest.raises(ValueError, match="different suite revisions"):
        collect_evidence(manifest, store, drifted_plan)

    drifted_manifest = manifest.with_semantic_updates(
        suite_executors={"evaluation-smoke": "normalized-suite-replay.v1"}
    )
    with pytest.raises(ValueError, match="suite executors"):
        validate_manifest(drifted_manifest)

    monkeypatch.setattr(
        "cli.evaluation.builtin_executors.execute_fixture", lambda *args: []
    )
    with pytest.raises(ValueError, match="omitted a planned case-track cell"):
        collect_evidence(manifest, store, plan)


def test_executor_fixture_declaration_is_enforced_centrally(tmp_path: Path) -> None:
    manifest = _manifest()
    plan = resolve_execution_plan(
        manifest, None, DEFAULT_SUITE_REGISTRY, DEFAULT_EXECUTOR_REGISTRY
    )
    store = LocalArtifactStore(tmp_path / "store")
    with pytest.raises(ValueError, match="omitted its required fixture reference"):
        collect_evidence(
            manifest,
            store,
            plan,
            registry=ExecutorRegistry((_MissingFixtureExecutor(),)),
        )

    unexpected = _UnexpectedFixtureExecutor()
    unexpected_plan = replace(
        plan,
        suite_executors={"evaluation-smoke": unexpected.contract.id},
    )
    with pytest.raises(ValueError, match="undeclared fixture reference"):
        collect_evidence(
            manifest,
            store,
            unexpected_plan,
            registry=ExecutorRegistry((unexpected,)),
        )


def test_mom_replay_executes_the_same_dense_campaign_cohort(tmp_path: Path) -> None:
    manifest = _mom_replay_manifest()
    store = LocalArtifactStore(tmp_path / "store")

    report = run_evaluation(manifest, store)
    records = _records(store, report.run.id)
    by_track = {
        track_id: [row for row in records if row.track_id == track_id]
        for track_id in ("routing", "model_pool", "joint")
    }

    assert report.run.status == "completed"
    assert report.run.evidence_level == "E0"
    assert {track.evidence_level for track in report.tracks} == {"E0"}
    assert len(by_track["routing"]) == LIVE_MOM_CASE_COUNT
    assert len(by_track["model_pool"]) == LIVE_MOM_CASE_COUNT * 2
    assert len(by_track["joint"]) == LIVE_MOM_CASE_COUNT
    assert len({row.case_id for row in records}) == LIVE_MOM_CASE_COUNT
    assert {row.grader for row in by_track["routing"] if row.quality is not None} == {
        "dense-pool-oracle.v1"
    }
    assert all(
        {row.arm_id for row in by_track["model_pool"] if row.case_id == case_id}
        == {arm.id for arm in manifest.target.mixture.model_arms}
        for case_id in {row.case_id for row in by_track["routing"]}
    )


def test_mom_replay_and_live_freeze_identical_workload_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replay = _mom_replay_manifest("mom-workload-replay")
    live = replay.with_semantic_updates(
        run_id=_uuid("mom-workload-live"),
        name="Live workload bridge",
        mode="live",
        suite_executors={"live-mom-core": "live-runtime.v1"},
    )
    empty_raw = LiveRawResult(
        records=[],
        discovered_entrypoints=(live.target.mixture.entrypoint_model,),
        routing_traces=(),
        chat_results={},
        model_pool_results={},
        model_pool_arm_ids=tuple(arm.id for arm in live.target.mixture.model_arms),
        joint_results={},
    )
    monkeypatch.setattr(
        "cli.evaluation.builtin_executors.execute_live_raw",
        lambda *args, **kwargs: empty_raw,
    )
    store = LocalArtifactStore(tmp_path / "store")

    replay_evidence = DEFAULT_EXECUTOR_REGISTRY.require(MOM_REPLAY_EXECUTOR_ID).collect(
        replay,
        store,
        resolve_execution_plan(
            replay, None, DEFAULT_SUITE_REGISTRY, DEFAULT_EXECUTOR_REGISTRY
        ),
        None,
    )
    live_evidence = DEFAULT_EXECUTOR_REGISTRY.require("live-runtime.v1").collect(
        live,
        store,
        resolve_execution_plan(
            live, None, DEFAULT_SUITE_REGISTRY, DEFAULT_EXECUTOR_REGISTRY
        ),
        None,
    )

    assert replay.suite_ids == live.suite_ids == ("live-mom-core",)
    assert replay.suite_revisions == live.suite_revisions
    assert replay_evidence.visible_ref.digest == live_evidence.visible_ref.digest
    assert replay_evidence.grading_ref.digest == live_evidence.grading_ref.digest


def test_mom_replay_randomness_binds_the_full_case_snapshot() -> None:
    manifest = _mom_replay_manifest("mom-case-snapshot")
    visible, grading = live_mom_case_sets()
    original = mom_replay_fixture(manifest, visible, grading)
    first = visible.cases[0]
    changed_visible = VisibleCaseSet(
        cases=(
            first.model_copy(
                update={
                    "messages": (
                        Message(
                            role="user",
                            content="Return exactly 43; this is a changed frozen case.",
                        ),
                    )
                }
            ),
            *visible.cases[1:],
        )
    )
    changed = mom_replay_fixture(manifest, changed_visible, grading)

    assert original.cases[0].model_dump(mode="json") != changed.cases[0].model_dump(
        mode="json"
    )
