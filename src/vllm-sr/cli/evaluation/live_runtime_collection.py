"""Evidence assembly for the built-in live runtime executor."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

from cli.evaluation.agent_task_ledger import execute_agent_task_ledger
from cli.evaluation.case_plan import project_visible_case_set
from cli.evaluation.contracts import (
    CaseGrading,
    CaseVisible,
    GradingCaseSet,
    HTTPServiceEndpoint,
    RunManifest,
    VisibleCaseSet,
)
from cli.evaluation.evidence import ExecutionRecord, RoutingDiagnostic
from cli.evaluation.executor_registry import CollectedEvidence
from cli.evaluation.fault_recovery_ledger import execute_fault_recovery_ledger
from cli.evaluation.fixtures import fixture_inputs
from cli.evaluation.hard_policy_ledger import execute_hard_policy_ledger
from cli.evaluation.http_client import EvaluationHTTPClient
from cli.evaluation.live_executor import (
    LiveRawResult,
    discover_live_entrypoints,
    grade_live_execution,
)
from cli.evaluation.live_mom_cases import live_mom_case_sets
from cli.evaluation.production_experiment_ledger import (
    execute_production_experiment_ledger,
)
from cli.evaluation.resolution import live_grading, sample_case_sets, sample_fixture
from cli.evaluation.runtime_factors import runtime_factors
from cli.evaluation.store import LocalArtifactStore

_BASE_TRACK_IDS = frozenset(
    {"routing", "model_pool", "joint", "multimodal", "capacity"}
)
_MOM_TRACK_IDS = frozenset({"routing", "model_pool", "joint"})
_SERVICE_TRACK_IDS = frozenset({"multimodal", "capacity"})


def _ledger_client(endpoint: HTTPServiceEndpoint) -> EvaluationHTTPClient:
    return EvaluationHTTPClient(
        timeout=endpoint.timeout_seconds,
        credential_env=endpoint.api_key.env if endpoint.api_key else None,
    )


def _base_case_sets(
    manifest: RunManifest,
) -> tuple[VisibleCaseSet, GradingCaseSet, tuple[str, ...]]:
    source = fixture_inputs()
    track_ids = tuple(
        track_id for track_id in manifest.track_ids if track_id in _BASE_TRACK_IDS
    )
    visible_cases: list[CaseVisible] = []
    grading_cases: list[CaseGrading] = []
    mom_track_ids = tuple(
        track_id for track_id in track_ids if track_id in _MOM_TRACK_IDS
    )
    if mom_track_ids:
        mom_visible, mom_grading = live_mom_case_sets()
        mom_visible, mom_grading = sample_case_sets(
            mom_visible,
            mom_grading,
            manifest.sample_limit,
            manifest.seed,
        )
        visible_cases.extend(project_visible_case_set(mom_visible, mom_track_ids).cases)
        grading_cases.extend(mom_grading.cases)

    service_track_ids = tuple(
        track_id for track_id in track_ids if track_id in _SERVICE_TRACK_IDS
    )
    if service_track_ids:
        all_case_ids = frozenset(
            case.id
            for case in source.visible.cases
            if set(case.track_ids).intersection(service_track_ids)
        )
        non_text_case_ids = frozenset(
            case.id for case in source.visible.cases if case.modality != "text"
        )
        sampled = sample_fixture(
            source,
            manifest.sample_limit,
            manifest.seed,
            eligible_case_ids=(
                non_text_case_ids
                if set(service_track_ids) == {"multimodal"}
                else all_case_ids
            ),
            required_case_groups=(
                (non_text_case_ids,) if "multimodal" in service_track_ids else ()
            ),
        )
        visible_cases.extend(
            project_visible_case_set(sampled.visible, service_track_ids).cases
        )
        grading_cases.extend(live_grading(sampled.grading).cases)
    return (
        VisibleCaseSet(cases=tuple(visible_cases)),
        GradingCaseSet(cases=tuple(grading_cases)),
        track_ids,
    )


def _execute_base_tracks(
    manifest: RunManifest,
    execute_raw: Callable[..., LiveRawResult],
) -> tuple[
    VisibleCaseSet,
    GradingCaseSet,
    list[ExecutionRecord],
    tuple[str, ...],
    tuple[RoutingDiagnostic, ...],
]:
    visible, grading, track_ids = _base_case_sets(manifest)
    if not track_ids:
        envoy_client = EvaluationHTTPClient(
            credential_env=(
                manifest.target.envoy_api_key.env
                if manifest.target.envoy_api_key
                else None
            )
        )
        return (
            visible,
            grading,
            [],
            discover_live_entrypoints(
                envoy_client,
                manifest.target.envoy_url or "",
                manifest.target.mixture,
            ),
            (),
        )
    raw = execute_raw(
        visible,
        track_ids=track_ids,
        router_api_url=manifest.target.router_api_url,
        envoy_url=manifest.target.envoy_url or "",
        concurrency=manifest.concurrency,
        capacity_load_protocol=manifest.capacity_load_protocol,
        mixture=manifest.target.mixture,
        router_api_key_env=(
            manifest.target.router_api_key.env
            if manifest.target.router_api_key
            else None
        ),
        envoy_api_key_env=(
            manifest.target.envoy_api_key.env if manifest.target.envoy_api_key else None
        ),
    )
    result = grade_live_execution(raw, grading)
    return (
        visible,
        grading,
        list(result.records),
        result.discovered_entrypoints,
        result.routing_traces,
    )


def _append_ledger_evidence(
    manifest: RunManifest,
    visible_cases: list[CaseVisible],
    grading_cases: list[CaseGrading],
    records: list[ExecutionRecord],
) -> None:
    if "live-agent-tasks" in manifest.suite_ids:
        endpoint = manifest.target.agent_task_ledger
        if endpoint is None:
            raise ValueError(
                "live-agent-tasks requires its dedicated agent_task_ledger capability"
            )
        if manifest.target.mixture is None:
            raise ValueError("live-agent-tasks requires a frozen Mixture")
        execution = execute_agent_task_ledger(
            _ledger_client(endpoint),
            endpoint.url,
            policy_snapshot_digest=manifest.policy_snapshot_digest,
            config_digest=manifest.config_digest,
            target_id=manifest.target.id,
            backend_topology_digest=manifest.target.backend_topology_digest or "",
            mixture=manifest.target.mixture,
            sample_limit=manifest.sample_limit,
            seed=manifest.seed,
        )
        visible_cases.extend(execution.visible.cases)
        grading_cases.extend(execution.grading.cases)
        records.extend(execution.records)

    if "live-fault-recovery" in manifest.suite_ids:
        endpoint = manifest.target.fault_recovery_ledger
        if endpoint is None:
            raise ValueError(
                "live-fault-recovery requires its dedicated fault_recovery_ledger capability"
            )
        execution = execute_fault_recovery_ledger(
            _ledger_client(endpoint),
            endpoint.url,
            policy_snapshot_digest=manifest.policy_snapshot_digest,
            config_digest=manifest.config_digest,
            target_id=manifest.target.id,
            backend_topology_digest=manifest.target.backend_topology_digest or "",
            mixture=manifest.target.mixture,
            sample_limit=manifest.sample_limit,
            seed=manifest.seed,
        )
        visible_cases.extend(execution.visible.cases)
        grading_cases.extend(execution.grading.cases)
        records.extend(execution.records)

    if "safety" in manifest.track_ids:
        endpoint = manifest.target.hard_policy_ledger
        if endpoint is None:
            raise ValueError(
                "safety live evaluation requires hard_policy_ledger capability"
            )
        execution = execute_hard_policy_ledger(
            _ledger_client(endpoint),
            endpoint.url,
            policy_snapshot_digest=manifest.policy_snapshot_digest,
            config_digest=manifest.config_digest,
            target_id=manifest.target.id,
            backend_topology_digest=manifest.target.backend_topology_digest or "",
            mixture=manifest.target.mixture,
            sample_limit=manifest.sample_limit,
            seed=manifest.seed,
        )
        visible_cases.extend(execution.visible.cases)
        grading_cases.extend(execution.grading.cases)
        records.extend(execution.records)

    if "preference" in manifest.track_ids:
        endpoint = manifest.target.production_experiment_ledger
        if endpoint is None:
            raise ValueError(
                "preference live evaluation requires production_experiment_ledger capability"
            )
        execution = execute_production_experiment_ledger(
            _ledger_client(endpoint),
            endpoint.url,
            policy_snapshot_digest=manifest.policy_snapshot_digest,
            config_digest=manifest.config_digest,
            target_id=manifest.target.id,
            backend_topology_digest=manifest.target.backend_topology_digest or "",
            mixture=manifest.target.mixture,
            model_arms=manifest.target.mixture.model_arms,
            sample_limit=manifest.sample_limit,
            seed=manifest.seed,
        )
        visible_cases.extend(execution.visible.cases)
        grading_cases.extend(execution.grading.cases)
        records.extend(execution.records)


def collect_live_runtime_evidence(
    manifest: RunManifest,
    store: LocalArtifactStore,
    *,
    executor_id: str,
    execute_raw: Callable[..., LiveRawResult],
) -> CollectedEvidence:
    """Collect every live-runtime track under one frozen manifest."""

    if manifest.target.envoy_url is None:
        raise ValueError("live runtime executor requires envoy_url")
    if manifest.target.mixture is None:
        raise ValueError("live runtime executor requires a frozen target mixture")
    source = fixture_inputs()
    visible, grading, records, discovered_entrypoints, routing_traces = (
        _execute_base_tracks(manifest, execute_raw)
    )
    visible_cases = list(visible.cases)
    grading_cases = list(grading.cases)
    _append_ledger_evidence(manifest, visible_cases, grading_cases, records)

    visible = VisibleCaseSet(cases=tuple(visible_cases))
    grading = GradingCaseSet(cases=tuple(grading_cases))
    factors = runtime_factors(manifest)
    inputs = replace(
        source,
        visible=visible,
        grading=grading,
        fixture=None,
        policy=factors.policy,
        pool=factors.pool,
        arms=factors.arms,
        binding=factors.binding,
        environment=factors.environment,
        suite_revisions=dict(manifest.suite_revisions),
        suite_executors=dict(manifest.suite_executors),
        executor_ids=dict.fromkeys(manifest.track_ids, executor_id),
    )
    return CollectedEvidence(
        inputs=inputs,
        visible_ref=store.put_json(inputs.visible),
        grading_ref=store.put_json(inputs.grading),
        fixture_ref=None,
        records=records,
        discovered_entrypoints=discovered_entrypoints,
        routing_traces=routing_traces,
    )
