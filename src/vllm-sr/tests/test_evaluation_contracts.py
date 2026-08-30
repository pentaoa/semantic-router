from __future__ import annotations

import json
import math
from importlib.resources import files

import pytest
from cli.evaluation.canonical import digest_value, sha256_digest
from cli.evaluation.catalog import EvaluationCatalog, get_catalog
from cli.evaluation.constants import SCHEMA_VERSION, TRACK_IDS
from cli.evaluation.contracts import (
    ArtifactRef,
    EvaluationTarget,
    EvaluationTargetArm,
    ManifestMixture,
    MixtureDecisionBinding,
    RunManifest,
    SupportModelIdentity,
    WorkloadSnapshot,
)
from cli.evaluation.executor_contracts import BUILTIN_EXECUTOR_CONTRACTS
from cli.evaluation.manifest_identity import (
    manifest_semantic_digest,
    mixture_target_id,
    model_pool_snapshot_digest,
    seal_manifest_fields,
    selector_snapshot_digest,
)
from cli.evaluation.reporting import EvaluationReport, WorkerEvent
from cli.evaluation.schemas import contract_schemas
from cli.evaluation.target_capabilities import DEFAULT_TARGET_REGISTRY
from pydantic import ValidationError


def _golden(name: str) -> dict[str, object]:
    path = files("cli.evaluation").joinpath("golden", name)
    return json.loads(path.read_text(encoding="utf-8"))


def _mixture(arms: tuple[EvaluationTargetArm, ...]) -> ManifestMixture:
    recipe_name = "contract-recipe"
    recipe_digest = digest_value("contract-mixture-policy")
    pool_digest = model_pool_snapshot_digest(arms)
    mixture_id = mixture_target_id(recipe_name)
    aliases = ("entrypoint-contract",)
    selector_policy_digest = digest_value("contract-selector-policy")
    return ManifestMixture(
        id=mixture_id,
        entrypoint_model="entrypoint-contract",
        aliases=aliases,
        recipe_name=recipe_name,
        recipe_description="Contract test recipe",
        recipe_digest=recipe_digest,
        pool_digest=pool_digest,
        selector_policy_digest=selector_policy_digest,
        selector_digest=selector_snapshot_digest(selector_policy_digest, ()),
        adaptation_digest=digest_value("contract-adaptation"),
        binding_digest=digest_value("contract-mixture-binding"),
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


def _assert_catalog_evidence_contract(
    catalog: EvaluationCatalog, report: EvaluationReport
) -> None:
    fixture = next(target for target in catalog.targets if target.id == "fixture")
    assert tuple(target.id for target in catalog.targets) == (
        "fixture",
        "benchmark-source",
    )
    assert fixture.evidence_level == "E0"
    assert report.run.evidence_level == "E0"
    assert tuple(suite.id for suite in catalog.suites) == (
        "evaluation-smoke",
        "live-mom-core",
        "live-agent-tasks",
        "live-fault-recovery",
        "live-multimodal",
        "live-hard-policy",
        "live-production-experiment",
        "live-capacity",
    )
    assert {suite.id: suite.evidence_level for suite in catalog.suites} == {
        "evaluation-smoke": "E0",
        "live-mom-core": "E0",
        "live-agent-tasks": "E5",
        "live-fault-recovery": "E5",
        "live-multimodal": "E0",
        "live-hard-policy": "E4",
        "live-production-experiment": "E5",
        "live-capacity": "E5",
    }
    assert all(suite.methods for suite in catalog.suites)
    expected_slots = tuple(f"G{index}" for index in range(2, 10))
    for profile in catalog.change_profiles:
        assert tuple(slot.gate_id for slot in profile.campaign_slots) == expected_slots
    g4_slots = {
        profile.id: next(
            slot for slot in profile.campaign_slots if slot.gate_id == "G4"
        )
        for profile in catalog.change_profiles
    }
    assert all(slot.mode == "live" for slot in g4_slots.values())
    assert all(slot.minimum_evidence_level == "E4" for slot in g4_slots.values())
    assert all(
        slot.accepted_executor_ids == ("normalized-suite-live.v1",)
        for slot in g4_slots.values()
    )
    _assert_fidelity_slots(catalog)


def _assert_fidelity_slots(catalog: EvaluationCatalog) -> None:
    g5_slots = {
        profile.id: next(
            slot for slot in profile.campaign_slots if slot.gate_id == "G5"
        )
        for profile in catalog.change_profiles
    }
    assert all(slot.mode == "live" for slot in g5_slots.values())
    assert g5_slots["agent_multimodal"].track_id == "multimodal"
    assert g5_slots["agent_multimodal"].minimum_evidence_level == "E4"
    assert g5_slots["agent_multimodal"].accepted_executor_ids == (
        "normalized-suite-live.v1",
    )
    assert all(
        slot.track_id == "joint"
        and slot.minimum_evidence_level == "E5"
        and slot.accepted_executor_ids
        == ("normalized-suite-live.v1", "live-runtime.v1")
        for profile, slot in g5_slots.items()
        if profile != "agent_multimodal"
    )


def test_cross_language_golden_contracts_parse_strictly() -> None:
    catalog = EvaluationCatalog.model_validate(_golden("catalog.json"))
    manifest = RunManifest.model_validate(_golden("manifest.json"))
    live_manifest = RunManifest.model_validate(_golden("live-manifest.json"))
    report = EvaluationReport.model_validate(_golden("report.json"))

    assert catalog.schema_version == manifest.schema_version == report.schema_version
    assert catalog.schema_version == SCHEMA_VERSION == "evaluation.v1"
    assert tuple(track.id for track in catalog.tracks) == TRACK_IDS
    assert report.run.id == manifest.run_id
    assert report.run.client_request_id == report.run.id
    assert report.run.name == manifest.name
    assert report.run.description == manifest.description
    assert manifest_semantic_digest(manifest) == manifest.manifest_digest
    assert manifest_semantic_digest(live_manifest) == live_manifest.manifest_digest
    assert live_manifest.target.mixture is not None
    assert live_manifest.target.mixture.model_arms[0].model == "public-fast"
    assert live_manifest.target.router_api_key is None
    assert live_manifest.target.envoy_api_key is not None
    assert live_manifest.target.envoy_api_key.env == "VLLM_SR_ENVOY_EVAL_API_KEY"
    assert (
        live_manifest.target.mixture.model_arms[0].input_cost_per_million_tokens_usd
        == 0.0
    )
    assert (
        live_manifest.target.mixture.model_arms[0].output_cost_per_million_tokens_usd
        == 1.0
    )
    assert (
        live_manifest.target.mixture.model_arms[1].input_cost_per_million_tokens_usd
        == 1e-7
    )
    assert (
        math.copysign(
            1.0,
            live_manifest.target.mixture.model_arms[
                1
            ].output_cost_per_million_tokens_usd,
        )
        == -1.0
    )
    assert live_manifest.target.mixture.model_arms[1].model == "公共-strong-模型"
    assert live_manifest.created_at.microsecond == 123456
    assert report.summary.verdict == "unavailable"
    assert report.summary.failed_gates == 0
    assert {gate.id: gate.verdict for gate in report.gates}["G8"] == "not_applicable"
    assert {gate.id: gate.verdict for gate in report.gates}["G9"] == "not_applicable"
    _assert_catalog_evidence_contract(catalog, report)
    assert get_catalog(generated_at=False).model_dump(
        mode="json", exclude_none=True
    ) == _golden("catalog.json")


def test_generated_json_schema_matches_versioned_golden_digests() -> None:
    golden = _golden("schema-digests.json")
    actual = {name: digest_value(schema) for name, schema in contract_schemas().items()}
    assert golden["schema_version"] == SCHEMA_VERSION
    assert actual == golden["digests"]


def test_manifest_is_strict_and_has_no_literal_secret_surface() -> None:
    payload = _golden("manifest.json")
    missing_digest = dict(payload)
    missing_digest.pop("manifest_digest")
    with pytest.raises(ValidationError, match="manifest_digest"):
        RunManifest.model_validate(missing_digest)
    with pytest.raises(ValidationError, match="manifest_digest"):
        RunManifest.model_validate({**payload, "manifest_digest": "sha256:caller"})

    payload["api_key"] = "literal-secret"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        RunManifest.model_validate(payload)

    target = dict(payload["target"])
    target["router_api_url"] = "https://user:secret@example.com/router"
    with pytest.raises(ValidationError, match="credentials"):
        EvaluationTarget.model_validate(target)

    for key_field in ("router_api_key", "envoy_api_key"):
        with pytest.raises(ValidationError):
            EvaluationTarget.model_validate(
                {
                    "id": "runtime",
                    "kind": "runtime",
                    key_field: "literal-secret",
                }
            )
        with pytest.raises(ValidationError, match="uppercase environment variable"):
            EvaluationTarget.model_validate(
                {
                    "id": "runtime",
                    "kind": "runtime",
                    key_field: {"env": "literal-secret"},
                }
            )

    target_with_refs = EvaluationTarget.model_validate(
        {
            "id": "runtime",
            "kind": "runtime",
            "router_api_url": "http://router:8080",
            "envoy_url": "http://envoy:8801",
            "router_api_key": {"env": "ROUTER_EVAL_API_KEY"},
            "envoy_api_key": {"env": "ENVOY_EVAL_API_KEY"},
        }
    )
    assert target_with_refs.router_api_key is not None
    assert target_with_refs.router_api_key.env == "ROUTER_EVAL_API_KEY"
    assert target_with_refs.envoy_api_key is not None
    assert target_with_refs.envoy_api_key.env == "ENVOY_EVAL_API_KEY"


def test_manifest_identity_collections_are_canonical_and_unambiguous() -> None:
    payload = _golden("manifest.json")
    parsed = RunManifest.model_validate(payload)
    assert parsed.run_id == "00000000-0000-4000-8000-000000000001"
    assert parsed.suite_ids == tuple(payload["suite_ids"])
    assert parsed.track_ids == tuple(payload["track_ids"])

    for run_id in (
        "fixture-run",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        parsed.run_id.replace("-", ""),
    ):
        with pytest.raises(ValidationError, match="canonical UUID"):
            RunManifest.model_validate({**payload, "run_id": run_id})
    with pytest.raises(ValidationError, match="suite ids must be unique"):
        RunManifest.model_validate(
            {**payload, "suite_ids": ["evaluation-smoke", "evaluation-smoke"]}
        )
    with pytest.raises(ValidationError, match="track ids must be unique"):
        RunManifest.model_validate({**payload, "track_ids": ["routing", "routing"]})

    mixed = {
        **payload,
        "suite_ids": ["suite-a", "suite-b"],
        "suite_revisions": {"suite-a": "revision-a", "suite-b": "revision-b"},
        "suite_executors": {
            "suite-a": "fixture-replay.v1",
            "suite-b": "normalized-suite-replay.v1",
        },
    }
    with pytest.raises(ValidationError, match="cannot mix executor"):
        RunManifest.model_validate(mixed)

    reversed_tracks = {**payload, "track_ids": list(reversed(payload["track_ids"]))}
    with pytest.raises(ValidationError, match="canonical catalog order"):
        RunManifest.model_validate(reversed_tracks)

    live = _golden("live-manifest.json")
    reversed_suites = {**live, "suite_ids": list(reversed(live["suite_ids"]))}
    with pytest.raises(ValidationError, match="canonical catalog order"):
        RunManifest.model_validate(reversed_suites)

    installed = {
        **payload,
        "suite_ids": ["installed-z", "installed-a"],
        "suite_revisions": {"installed-z": "v1", "installed-a": "v1"},
        "suite_executors": {
            "installed-z": "normalized-suite-replay.v1",
            "installed-a": "normalized-suite-replay.v1",
        },
    }
    with pytest.raises(ValidationError, match="lexical canonical order"):
        RunManifest.model_validate(installed)

    for field, value, error in (
        ("name", " padded ", "run name"),
        ("description", " padded ", "run description"),
    ):
        with pytest.raises(ValidationError, match=error):
            RunManifest.model_validate({**payload, field: value})

    report = _golden("report.json")
    report["run"] = {
        **report["run"],
        "client_request_id": "00000000-0000-4000-8000-000000000099",
    }
    with pytest.raises(ValidationError, match="must equal the run id"):
        EvaluationReport.model_validate(report)


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("name", "Tampered evaluation name"),
        ("description", "Tampered evaluation description"),
        ("suite_executors", {"evaluation-smoke": "fixture-replay.v2"}),
    ),
)
def test_manifest_semantic_digest_rejects_field_tampering(
    field: str, value: object
) -> None:
    payload = _golden("manifest.json")
    payload[field] = value

    with pytest.raises(ValidationError, match="manifest_digest does not match"):
        RunManifest.model_validate(payload)


def test_live_manifest_semantic_digest_binds_every_capacity_slo_bound() -> None:
    payload = _golden("live-manifest.json")
    frozen_slo = dict(payload["capacity_slo"])
    tampered_values = {
        "required_concurrency": (2 if frozen_slo["required_concurrency"] == 1 else 1),
        "max_latency_p95_ms": frozen_slo["max_latency_p95_ms"] * 1.1,
        "max_error_rate": (
            frozen_slo["max_error_rate"] / 2
            if frozen_slo["max_error_rate"] > 0
            else 0.001
        ),
        "min_throughput_rps": frozen_slo["min_throughput_rps"] * 1.1,
        "min_throughput_scaling_efficiency": frozen_slo[
            "min_throughput_scaling_efficiency"
        ]
        / 2,
    }
    for field, tampered_value in tampered_values.items():
        tampered_slo = {**frozen_slo, field: tampered_value}
        with pytest.raises(ValidationError, match="manifest_digest does not match"):
            RunManifest.model_validate({**payload, "capacity_slo": tampered_slo})


def test_live_manifest_semantic_digest_binds_every_capacity_protocol_field() -> None:
    payload = _golden("live-manifest.json")
    frozen = dict(payload["capacity_load_protocol"])
    tampered_values = {
        "kind": "other",
        "concurrency_levels": [1, 4],
        "warmup_request_multiplier": frozen["warmup_request_multiplier"] + 1,
        "measurement_requests_per_repetition": (
            frozen["measurement_requests_per_repetition"] + 1
        ),
        "repetitions_per_level": frozen["repetitions_per_level"] + 1,
        "confidence_level": 0.9,
        "max_throughput_cv": frozen["max_throughput_cv"] / 2,
        "max_latency_p95_cv": frozen["max_latency_p95_cv"] / 2,
    }
    for field, tampered_value in tampered_values.items():
        tampered = {**frozen, field: tampered_value}
        assert (
            manifest_semantic_digest({**payload, "capacity_load_protocol": tampered})
            != payload["manifest_digest"]
        )


def test_manifest_target_shape_is_exact_for_each_execution_mode() -> None:
    replay = _golden("manifest.json")
    replay_target = dict(replay["target"])
    replay_target["backend_topology_digest"] = sha256_digest(b"unexpected")
    tampered = seal_manifest_fields(
        {
            **{key: value for key, value in replay.items() if key != "manifest_digest"},
            "target": replay_target,
        }
    )
    fixture_executor = next(
        executor
        for executor in BUILTIN_EXECUTOR_CONTRACTS
        if executor.id == "fixture-replay.v1"
    )
    with pytest.raises(ValueError, match="runtime connectivity"):
        DEFAULT_TARGET_REGISTRY.resolve(
            RunManifest.model_validate(tampered), fixture_executor
        )

    live = _golden("live-manifest.json")
    live_target = dict(live["target"])
    live_target["router_api_key"] = {
        "schema_version": SCHEMA_VERSION,
        "env": "ROUTER_EVAL_API_KEY",
    }
    live_with_router_credential = seal_manifest_fields(
        {
            **{key: value for key, value in live.items() if key != "manifest_digest"},
            "target": live_target,
        }
    )
    live_executor = next(
        executor
        for executor in BUILTIN_EXECUTOR_CONTRACTS
        if executor.id == "live-runtime.v1"
    )
    with pytest.raises(ValueError, match="Router evaluation credential"):
        DEFAULT_TARGET_REGISTRY.resolve(
            RunManifest.model_validate(live_with_router_credential), live_executor
        )


def test_worker_event_payload_is_event_specific_and_scalar_only() -> None:
    track = WorkerEvent(
        type="track", message="Track complete", payload={"record_count": 4}
    )
    completed = WorkerEvent(
        type="completed", message="Run complete", payload={"verdict": "pass"}
    )
    assert track.payload is not None and track.payload.record_count == 4
    assert completed.payload is not None and completed.payload.verdict == "pass"

    invalid_events = (
        {"type": "track", "message": "Track complete"},
        {
            "type": "track",
            "message": "Track complete",
            "payload": {"record_count": -1},
        },
        {
            "type": "completed",
            "message": "Run complete",
            "payload": {"verdict": "maybe"},
        },
        {
            "type": "failed",
            "message": "Run failed",
            "payload": {"record_count": 1},
        },
    )
    for event in invalid_events:
        with pytest.raises(ValidationError):
            WorkerEvent.model_validate(event)


@pytest.mark.parametrize(
    "revision", ("main", "latest", "unavailable", "deadbeef", "commit-abc123")
)
def test_manifest_requires_an_immutable_full_source_revision(revision: str) -> None:
    payload = _golden("manifest.json")
    payload["code_revision"] = revision

    with pytest.raises(ValidationError, match="code_revision"):
        RunManifest.model_validate(payload)


def test_target_model_arms_are_server_owned_strict_identity_and_pricing() -> None:
    arm = {
        "id": "reasoning",
        "model": "org/reasoning-model",
        "provider_model_id_digest": sha256_digest(b"private/provider-id"),
        "input_cost_per_million_tokens_usd": 1.25,
        "output_cost_per_million_tokens_usd": 4.5,
        "capabilities": ["chat", "reasoning"],
        "modalities": ["text"],
        "context_window_tokens": 32768,
        "parameter_size": "70B",
        "runtime_revision": "runtime-v1",
        "config_digest": sha256_digest(b"config"),
    }
    parsed = EvaluationTargetArm.model_validate(arm)
    assert parsed.input_cost_per_million_tokens_usd == 1.25
    assert parsed.output_cost_per_million_tokens_usd == 4.5
    assert parsed.provider_model_id_digest == sha256_digest(b"private/provider-id")
    assert parsed.modalities == ("text",)

    for forbidden_field in ("provider_model_id", "endpoint", "api_key", "secret"):
        unsafe = {**arm, forbidden_field: "https://private.example.test"}
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            EvaluationTargetArm.model_validate(unsafe)

    for invalid_price in (-0.01, float("inf"), float("nan"), "1.25"):
        invalid = {**arm, "input_cost_per_million_tokens_usd": invalid_price}
        with pytest.raises(ValidationError):
            EvaluationTargetArm.model_validate(invalid)


def test_target_model_arm_identity_and_model_are_unique() -> None:
    first = EvaluationTargetArm(
        id="fast",
        model="org/fast",
        provider_model_id_digest=sha256_digest(b"org/private-fast"),
        input_cost_per_million_tokens_usd=0.1,
        output_cost_per_million_tokens_usd=0.2,
    )
    duplicate_id = first.model_copy(update={"model": "org/other"})
    duplicate_model = first.model_copy(update={"id": "other"})

    with pytest.raises(ValidationError, match="arm ids must be unique"):
        _mixture((first, duplicate_id))
    with pytest.raises(ValidationError, match="arm models must be unique"):
        _mixture((first, duplicate_model))
    colliding_selector = first.model_copy(update={"id": "other", "model": first.id})
    with pytest.raises(ValidationError, match="ids and models must be unambiguous"):
        _mixture((first, colliding_selector))


def test_selector_support_identity_is_strict_and_digest_bound() -> None:
    arm = EvaluationTargetArm(
        id="fast",
        model="org/fast",
        provider_model_id_digest=sha256_digest(b"org/private-fast"),
        input_cost_per_million_tokens_usd=0.1,
        output_cost_per_million_tokens_usd=0.2,
    )
    mixture = _mixture((arm,))
    support = SupportModelIdentity(
        model="org/selector",
        provider_model_id_digest=sha256_digest(b"private/selector-v1"),
        config_digest=sha256_digest(b"selector-config-v1"),
        runtime_revision="runtime-v1",
        backend_topology_digest=sha256_digest(b"private-selector-endpoint"),
    )
    payload = mixture.model_dump(mode="python")
    payload["support_models"] = (support,)
    payload["selector_digest"] = selector_snapshot_digest(
        mixture.selector_policy_digest, (support,)
    )
    parsed = ManifestMixture.model_validate(payload)
    assert parsed.support_models == (support,)

    payload["selector_digest"] = sha256_digest(b"unbound-selector")
    with pytest.raises(ValidationError, match="must bind policy and support models"):
        ManifestMixture.model_validate(payload)

    unsafe = {
        **support.model_dump(mode="python"),
        "endpoint": "https://private.example.test",
    }
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        SupportModelIdentity.model_validate(unsafe)


def test_runtime_catalog_tracks_are_capability_dependent() -> None:
    matrix = _golden("capability-matrix.json")
    assert matrix["schema_version"] == SCHEMA_VERSION
    for case in matrix["cases"]:
        if not case["valid"]:
            with pytest.raises(ValidationError):
                EvaluationTarget.model_validate(case["target"])
            continue
        target = EvaluationTarget.model_validate(case["target"])
        catalog = get_catalog(
            generated_at=False,
            router_api_url=target.router_api_url,
            envoy_url=target.envoy_url,
            agent_task_ledger=target.agent_task_ledger,
            fault_recovery_ledger=target.fault_recovery_ledger,
            hard_policy_ledger=target.hard_policy_ledger,
            production_experiment_ledger=target.production_experiment_ledger,
            mixture=target.mixture,
            backend_topology_digest=target.backend_topology_digest,
        )
        if target.mixture is None:
            assert tuple(item.id for item in catalog.targets) == (
                "fixture",
                "benchmark-source",
            )
            assert case["expected_tracks"] == []
            continue
        mixture_target = next(
            item for item in catalog.targets if item.id == target.mixture.id
        )
        assert mixture_target.track_ids == tuple(case["expected_tracks"]), case["name"]
        assert mixture_target.healthy is bool(case["expected_tracks"]), case["name"]
        assert mixture_target.mixture == target.mixture.public_summary()


def test_live_manifest_requires_the_current_runtime_endpoint_contract() -> None:
    payload = _golden("live-manifest.json")
    frozen_mixture = dict(dict(payload["target"])["mixture"])
    mixture_id = frozen_mixture["id"]
    payload = seal_manifest_fields(
        {
            **{
                key: value for key, value in payload.items() if key != "manifest_digest"
            },
            "mode": "live",
            "target": {
                "schema_version": SCHEMA_VERSION,
                "id": mixture_id,
                "kind": "mixture-of-models",
                "router_api_url": "http://router:8080",
                "envoy_url": "http://envoy:8801",
                "backend_topology_digest": sha256_digest(b"backend-topology"),
                "mixture": frozen_mixture,
            },
        }
    )
    parsed = RunManifest.model_validate(payload)
    live_executor = next(
        executor
        for executor in BUILTIN_EXECUTOR_CONTRACTS
        if executor.id == "live-runtime.v1"
    )
    DEFAULT_TARGET_REGISTRY.resolve(parsed, live_executor)
    assert parsed.target.envoy_url == "http://envoy:8801"
    assert parsed.target.mixture is not None
    assert parsed.target.mixture.model_arms[0].id == "fast"
    missing_topology = dict(payload)
    missing_topology["target"] = {
        key: value
        for key, value in dict(payload["target"]).items()
        if key != "backend_topology_digest"
    }
    missing_topology_manifest = RunManifest.model_validate(
        seal_manifest_fields(
            {
                key: value
                for key, value in missing_topology.items()
                if key != "manifest_digest"
            }
        )
    )
    with pytest.raises(ValueError, match="brokered-runtime target is incomplete"):
        DEFAULT_TARGET_REGISTRY.resolve(missing_topology_manifest, live_executor)
    payload["target"] = {
        "schema_version": SCHEMA_VERSION,
        "id": mixture_id,
        "kind": "mixture-of-models",
        "mixture": frozen_mixture,
    }
    missing_endpoints = RunManifest.model_validate(
        seal_manifest_fields(
            {key: value for key, value in payload.items() if key != "manifest_digest"}
        )
    )
    with pytest.raises(ValueError, match="brokered-runtime target is incomplete"):
        DEFAULT_TARGET_REGISTRY.resolve(missing_endpoints, live_executor)


def test_visible_and_grading_case_artifacts_must_be_physically_separate() -> None:
    ref = ArtifactRef(
        digest="sha256:" + "a" * 64,
        media_type="application/json",
        size_bytes=10,
    )
    with pytest.raises(ValidationError, match="separate artifacts"):
        WorkloadSnapshot(id="hidden-label-check", visible_cases=ref, grading_cases=ref)


def test_canonical_digest_is_key_order_independent() -> None:
    assert digest_value({"b": 2, "a": [3, 1]}) == digest_value({"a": [3, 1], "b": 2})
