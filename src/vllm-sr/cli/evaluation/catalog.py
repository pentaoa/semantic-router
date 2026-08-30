"""Built-in evaluation catalog exposed to CLI and Dashboard."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Literal

from pydantic import field_serializer, model_validator

from cli.evaluation.catalog_tracks import (
    CATALOG_TRACKS,
    CatalogMethod,
    CatalogTrack,
)
from cli.evaluation.constants import BUILTIN_SUITE_IDS, SCHEMA_VERSION
from cli.evaluation.contracts import (
    CatalogMixture,
    EvaluationTarget,
    HTTPServiceEndpoint,
    ManifestMixture,
    StrictModel,
)
from cli.evaluation.execution_contract import (
    FIXTURE_REPLAY_EXECUTOR_ID,
    LIVE_RUNTIME_EXECUTOR_ID,
    MOM_REPLAY_EXECUTOR_ID,
    NORMALIZED_LIVE_EXECUTOR_ID,
)
from cli.evaluation.executor_contracts import (
    BUILTIN_EXECUTOR_CONTRACTS,
    ExecutorContract,
)
from cli.evaluation.gate_contract import (
    CHANGE_PROFILE_DEFINITIONS,
    GATE_CONTRACT_VERSION,
    ChangeProfile,
    GateDisposition,
    gate_applicability,
)
from cli.evaluation.live_mom_cases import LIVE_MOM_CASE_COUNT
from cli.evaluation.reporting import EvidenceLevel, TrackID
from cli.evaluation.target_capabilities import (
    DEFAULT_TARGET_REGISTRY,
    TargetContract,
    TargetRegistry,
    mixture_target_contract,
)

_CAMPAIGN_MINIMUM_CASES = 59


class CatalogSuite(StrictModel):
    id: str
    name: str
    description: str
    track_ids: tuple[TrackID, ...]
    modes: tuple[Literal["replay", "live"], ...]
    evidence_level: EvidenceLevel
    executors: Mapping[Literal["replay", "live"], str]
    case_count: int | None = None
    campaign_eligible: bool = False
    campaign_minimum_cases: int = 0
    revision: str | None = None
    tags: tuple[str, ...] = ()
    methods: tuple[CatalogMethod, ...]

    @model_validator(mode="after")
    def modes_have_one_executor(self) -> CatalogSuite:
        canonical_modes = tuple(
            mode for mode in ("replay", "live") if mode in self.modes
        )
        if self.modes != canonical_modes or len(set(self.modes)) != len(self.modes):
            raise ValueError("suite modes must use canonical replay/live order")
        if set(self.executors) != set(self.modes):
            raise ValueError("suite executors must exactly cover declared modes")
        if any(not executor_id for executor_id in self.executors.values()):
            raise ValueError("suite executor identities cannot be empty")
        method_ids = [method.id for method in self.methods]
        method_tracks = {method.track_id for method in self.methods}
        if (
            not self.methods
            or len(method_ids) != len(set(method_ids))
            or method_tracks != set(self.track_ids)
        ):
            raise ValueError(
                "suite methods must uniquely and exactly cover declared tracks"
            )
        if (
            any(
                method.evidence_source == "normalized_import" for method in self.methods
            )
            and self.evidence_level != "E0"
        ):
            raise ValueError("normalized import suites must remain E0")
        core_tracks = ("routing", "model_pool", "joint")
        if self.campaign_eligible:
            if (
                self.modes != ("replay", "live")
                or self.executors
                != {
                    "replay": MOM_REPLAY_EXECUTOR_ID,
                    "live": LIVE_RUNTIME_EXECUTOR_ID,
                }
                or self.evidence_level != "E0"
                or self.case_count != LIVE_MOM_CASE_COUNT
                or self.campaign_minimum_cases != _CAMPAIGN_MINIMUM_CASES
                or self.track_ids != core_tracks
            ):
                raise ValueError(
                    "campaign-eligible suites require the exact replay/live MoM cohort contract"
                )
        elif self.campaign_minimum_cases != 0:
            raise ValueError("non-campaign suites cannot declare a campaign minimum")
        object.__setattr__(self, "executors", MappingProxyType(dict(self.executors)))
        return self

    @field_serializer("executors")
    def serialize_executors(
        self, value: Mapping[Literal["replay", "live"], str]
    ) -> dict[str, str]:
        return dict(value)


class CatalogTarget(StrictModel):
    id: str
    name: str
    description: str
    kind: str
    track_ids: tuple[TrackID, ...]
    modes: tuple[Literal["replay", "live"], ...]
    accepted_executors: Mapping[Literal["replay", "live"], tuple[str, ...]]
    evidence_level: EvidenceLevel | None = None
    healthy: bool | None = None
    labels: dict[str, str] | None = None
    mixture: CatalogMixture | None = None

    @model_validator(mode="after")
    def executors_exactly_cover_modes(self) -> CatalogTarget:
        canonical_modes = tuple(
            mode for mode in ("replay", "live") if mode in self.modes
        )
        if self.modes != canonical_modes or len(set(self.modes)) != len(self.modes):
            raise ValueError("target modes must use canonical replay/live order")
        if set(self.accepted_executors) != set(self.modes):
            raise ValueError("target executors must exactly cover declared modes")
        frozen: dict[Literal["replay", "live"], tuple[str, ...]] = {}
        for mode in self.modes:
            executors = tuple(self.accepted_executors[mode])
            if (
                not executors
                or len(executors) != len(set(executors))
                or any(
                    re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", executor) is None
                    for executor in executors
                )
            ):
                raise ValueError(
                    "target executor identities must be portable and unique"
                )
            frozen[mode] = executors
        object.__setattr__(self, "accepted_executors", MappingProxyType(frozen))
        return self

    @field_serializer("accepted_executors")
    def serialize_accepted_executors(
        self,
        value: Mapping[Literal["replay", "live"], tuple[str, ...]],
    ) -> dict[str, list[str]]:
        return {mode: list(value[mode]) for mode in self.modes}


CampaignBindingKind = Literal["run", "controlled_pair", "fidelity_pair"]


class CatalogCampaignSlot(StrictModel):
    """One catalog-owned Campaign evidence binding for a release gate."""

    gate_id: Literal["G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]
    name: str
    description: str
    disposition: GateDisposition
    binding_kind: CampaignBindingKind
    track_id: TrackID
    mode: Literal["replay", "live"] | None = None
    minimum_evidence_level: EvidenceLevel
    accepted_executor_ids: tuple[str, ...]

    @model_validator(mode="after")
    def validate_slot(self) -> CatalogCampaignSlot:
        if (
            not self.name
            or self.name.strip() != self.name
            or not self.description
            or self.description.strip() != self.description
            or not self.accepted_executor_ids
            or len(self.accepted_executor_ids) != len(set(self.accepted_executor_ids))
            or any(
                re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", executor_id) is None
                for executor_id in self.accepted_executor_ids
            )
        ):
            raise ValueError("campaign slot identity is invalid")
        if self.binding_kind == "fidelity_pair":
            if self.gate_id != "G5" or self.mode != "live":
                raise ValueError("fidelity pair is reserved for live G5")
        elif self.mode is None:
            raise ValueError("run and controlled-pair slots require an exact mode")
        if self.binding_kind == "controlled_pair" and self.gate_id != "G3":
            raise ValueError("controlled pair is reserved for G3")
        return self


class CatalogChangeProfile(StrictModel):
    id: ChangeProfile
    name: str
    description: str
    campaign_slots: tuple[CatalogCampaignSlot, ...]

    @model_validator(mode="after")
    def validate_campaign_slots(self) -> CatalogChangeProfile:
        expected_gate_ids = tuple(f"G{index}" for index in range(2, 10))
        if tuple(slot.gate_id for slot in self.campaign_slots) != expected_gate_ids:
            raise ValueError(
                "campaign slots must exactly cover G2-G9 in canonical order"
            )
        expected_dispositions = {
            definition.id: disposition
            for definition, disposition in gate_applicability(self.id)
            if definition.id in expected_gate_ids
        }
        if any(
            slot.disposition != expected_dispositions[slot.gate_id]
            for slot in self.campaign_slots
        ):
            raise ValueError(
                "campaign slot disposition must match the release gate matrix"
            )
        return self


_CAMPAIGN_SLOT_TEMPLATES: tuple[dict[str, object], ...] = (
    {
        "gate_id": "G2",
        "name": "Hard policy",
        "description": "Server-qualified hard-policy enforcement on the candidate subject.",
        "binding_kind": "run",
        "track_id": "safety",
        "mode": "live",
        "minimum_evidence_level": "E3",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
    {
        "gate_id": "G3",
        "name": "Controlled paired-live value",
        "description": "Controlled AB/BA paired-live outcomes under the frozen promotion policy.",
        "binding_kind": "controlled_pair",
        "track_id": "joint",
        "mode": "live",
        "minimum_evidence_level": "E4",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
    {
        "gate_id": "G4",
        "name": "Declared-shift robustness",
        "description": "Server-qualified declared-shift robustness on the candidate subject.",
        "binding_kind": "run",
        "track_id": "routing",
        "mode": "live",
        "minimum_evidence_level": "E4",
        "accepted_executor_ids": (NORMALIZED_LIVE_EXECUTOR_ID,),
    },
    {
        "gate_id": "G5",
        "name": "Live fidelity",
        "description": "Reference-to-fresh-live agreement on an exact candidate and case cohort.",
        "binding_kind": "fidelity_pair",
        "track_id": "joint",
        "mode": "live",
        "minimum_evidence_level": "E5",
        "accepted_executor_ids": (
            NORMALIZED_LIVE_EXECUTOR_ID,
            LIVE_RUNTIME_EXECUTOR_ID,
        ),
    },
    {
        "gate_id": "G6",
        "name": "Live fault-recovery continuity",
        "description": "Server-qualified fault-recovery continuity on the candidate subject.",
        "binding_kind": "run",
        "track_id": "agentic",
        "mode": "live",
        "minimum_evidence_level": "E5",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
    {
        "gate_id": "G7",
        "name": "Cost / latency / capacity",
        "description": "Server-qualified capacity envelope on the candidate subject.",
        "binding_kind": "run",
        "track_id": "capacity",
        "mode": "live",
        "minimum_evidence_level": "E5",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
    {
        "gate_id": "G8",
        "name": "Shadow / canary",
        "description": "Server-qualified production assignment, exposure, risk, stop, and rollback controls.",
        "binding_kind": "run",
        "track_id": "preference",
        "mode": "live",
        "minimum_evidence_level": "E5",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
    {
        "gate_id": "G9",
        "name": "Online preference",
        "description": "Server-qualified online preference evidence on the candidate subject.",
        "binding_kind": "run",
        "track_id": "preference",
        "mode": "live",
        "minimum_evidence_level": "E5",
        "accepted_executor_ids": (LIVE_RUNTIME_EXECUTOR_ID,),
    },
)


def _campaign_slots(profile: ChangeProfile) -> tuple[CatalogCampaignSlot, ...]:
    dispositions = {
        definition.id: disposition
        for definition, disposition in gate_applicability(profile)
    }
    slots: list[CatalogCampaignSlot] = []
    for template in _CAMPAIGN_SLOT_TEMPLATES:
        values = {
            **template,
            "disposition": dispositions[str(template["gate_id"])],
        }
        if profile == "agent_multimodal" and template["gate_id"] == "G5":
            values.update(
                {
                    "description": (
                        "Reference-to-fresh-live multimodal agreement on an exact "
                        "candidate and MMR case cohort."
                    ),
                    "track_id": "multimodal",
                    "minimum_evidence_level": "E4",
                    "accepted_executor_ids": (NORMALIZED_LIVE_EXECUTOR_ID,),
                }
            )
        slots.append(CatalogCampaignSlot.model_validate(values))
    return tuple(slots)


class EvaluationCatalog(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    generated_at: datetime | None = None
    gate_contract_version: Literal[GATE_CONTRACT_VERSION] = GATE_CONTRACT_VERSION
    change_profiles: tuple[CatalogChangeProfile, ...]
    tracks: tuple[CatalogTrack, ...]
    suites: tuple[CatalogSuite, ...]
    targets: tuple[CatalogTarget, ...]


_TRACKS = CATALOG_TRACKS
_ALL_TRACK_IDS = tuple(track.id for track in _TRACKS)


def _method(
    method_id: str,
    track_id: TrackID,
    *,
    gate_ids: tuple[str, ...] = (),
    evidence_source: Literal[
        "diagnostic_fixture", "live_runtime", "normalized_import", "live_production"
    ] = "live_runtime",
    status: Literal["qualified", "configured", "data_required"] = "configured",
    reason: str | None = None,
) -> CatalogMethod:
    return CatalogMethod(
        id=method_id,
        track_id=track_id,
        qualified_gate_ids=gate_ids,
        evidence_source=evidence_source,
        status=status,
        reason=reason,
    )


_SUITES = (
    CatalogSuite(
        id="evaluation-smoke",
        name="Evaluation smoke",
        description="Deterministic all-track vertical slice.",
        track_ids=_ALL_TRACK_IDS,
        modes=("replay",),
        evidence_level="E0",
        executors={"replay": FIXTURE_REPLAY_EXECUTOR_ID},
        case_count=4,
        revision="builtin-v1",
        tags=("smoke", "deterministic"),
        methods=tuple(
            _method(
                f"fixture.{track_id}.v1",
                track_id,
                evidence_source="diagnostic_fixture",
            )
            for track_id in _ALL_TRACK_IDS
        ),
    ),
    CatalogSuite(
        id="live-mom-core",
        name="Live Mixture-of-Models core",
        description=(
            "One hidden-label cohort for exact Recipe routing, dense per-arm outcomes, "
            "and routed end-to-end utility."
        ),
        track_ids=("routing", "model_pool", "joint"),
        modes=("replay", "live"),
        evidence_level="E0",
        executors={
            "replay": MOM_REPLAY_EXECUTOR_ID,
            "live": LIVE_RUNTIME_EXECUTOR_ID,
        },
        case_count=LIVE_MOM_CASE_COUNT,
        campaign_eligible=True,
        campaign_minimum_cases=_CAMPAIGN_MINIMUM_CASES,
        revision="mom-campaign-cohort-v1",
        tags=("campaign", "mom", "hidden-label", "paired-live"),
        methods=(
            _method("routing.live-diagnostic.v1", "routing"),
            _method("model-pool.live-dense.v1", "model_pool"),
            _method("joint.live-routed-outcome.v1", "joint"),
        ),
    ),
    CatalogSuite(
        id="live-agent-tasks",
        name="Live agent tasks",
        description=(
            "Brokered complete sealed provider-observed task trajectories on the "
            "exact frozen Mixture. Every task declares a required-tool or pure-reasoning "
            "policy, and required attempts carry unique provider-executed receipts. This method "
            "does not execute tools or claim native benchmark parity."
        ),
        track_ids=("agentic",),
        modes=("live",),
        evidence_level="E5",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(
            _method(
                "live-agent-task.v1",
                "agentic",
                status="data_required",
                reason=(
                    "Configure a dedicated server-owned agent_task_ledger endpoint "
                    "with a complete sealed repeated-task window and explicit per-task "
                    "tool policy on the exact frozen Mixture."
                ),
            ),
        ),
    ),
    CatalogSuite(
        id="live-fault-recovery",
        name="Live fault recovery",
        description=(
            "Brokered exact-step fault injection with paired baseline and treatment "
            "receipts, state continuity, side-effect, retry, and latency evidence."
        ),
        track_ids=("agentic",),
        modes=("live",),
        evidence_level="E5",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(
            _method(
                "live-fault-recovery.v1",
                "agentic",
                gate_ids=("G6",),
                status="data_required",
                reason=(
                    "Configure a server-owned fault_recovery_ledger endpoint with a "
                    "complete sealed exact-step baseline/treatment window."
                ),
            ),
        ),
    ),
    CatalogSuite(
        id="live-multimodal",
        name="Live multimodal",
        description="Bounded non-text request probes with response grading and latency.",
        track_ids=("multimodal",),
        modes=("live",),
        evidence_level="E0",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(_method("multimodal.live-chat.v1", "multimodal"),),
    ),
    CatalogSuite(
        id="live-hard-policy",
        name="Live hard-policy enforcement",
        description=(
            "Brokered runtime policy proof and attack observations bound to the "
            "server-owned policy and configuration snapshots."
        ),
        track_ids=("safety",),
        modes=("live",),
        evidence_level="E4",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(
            _method(
                "policy.hard-enforcement.v1",
                "safety",
                gate_ids=("G2",),
                status="data_required",
                reason=(
                    "Configure a server-owned hard_policy_ledger endpoint with an "
                    "exact rule/enforcement-point proof and complete sealed window."
                ),
            ),
        ),
    ),
    CatalogSuite(
        id="live-production-experiment",
        name="Live production experiment",
        description=(
            "Brokered sealed production assignment and exposure ledger for operational "
            "controls and propensity-qualified target-versus-reference preference lift."
        ),
        track_ids=("preference",),
        modes=("live",),
        evidence_level="E5",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(
            _method(
                "production.experiment-controls.v1",
                "preference",
                gate_ids=("G8",),
                evidence_source="live_production",
                status="data_required",
                reason=(
                    "Configure a server-owned production_experiment_ledger endpoint "
                    "with a complete sealed assignment/exposure and control window."
                ),
            ),
            _method(
                "production.preference-lift.v1",
                "preference",
                gate_ids=("G9",),
                evidence_source="live_production",
                status="data_required",
                reason=(
                    "Configure a server-owned production_experiment_ledger endpoint "
                    "with complete preference outcomes, propensities, and explicit "
                    "target/reference policy probabilities."
                ),
            ),
        ),
    ),
    CatalogSuite(
        id="live-capacity",
        name="Live capacity",
        description=(
            "Repeated closed-loop load levels with frozen warmup, independent "
            "measurement windows, confidence bounds, stability checks, and SLO headroom."
        ),
        track_ids=("capacity",),
        modes=("live",),
        evidence_level="E5",
        executors={"live": LIVE_RUNTIME_EXECUTOR_ID},
        revision="executor-v1",
        methods=(
            _method(
                "capacity.slo-envelope.v1",
                "capacity",
                gate_ids=("G7",),
            ),
        ),
    ),
)

if tuple(suite.id for suite in _SUITES) != BUILTIN_SUITE_IDS:
    raise RuntimeError(
        "built-in suite catalog order differs from the manifest contract"
    )


def _validate_installed_suites(
    installed_suites: tuple[CatalogSuite, ...],
    executor_contracts: tuple[ExecutorContract, ...],
) -> None:
    installed_ids = tuple(suite.id for suite in installed_suites)
    if installed_ids != tuple(sorted(installed_ids)):
        raise ValueError("installed suites must use lexical catalog order")
    if len(installed_ids) != len(set(installed_ids)):
        raise ValueError("installed suite catalog ids must be unique")
    if set(installed_ids).intersection(BUILTIN_SUITE_IDS):
        raise ValueError("installed suite ids cannot shadow built-in suites")
    executor_by_id = {contract.id: contract for contract in executor_contracts}
    for suite in installed_suites:
        expected_modes = ("replay", "live") if "live" in suite.modes else ("replay",)
        if (
            suite.modes != expected_modes
            or suite.case_count is None
            or suite.case_count <= 0
            or suite.revision is None
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", suite.revision)
        ):
            raise ValueError("installed suite catalog entry is not executable")
        for mode in suite.modes:
            executor = executor_by_id.get(suite.executors[mode])
            if (
                executor is None
                or executor.mode != mode
                or not executor.normalized_suite
                or (mode == "replay") != executor.recorded_normalized_import
            ):
                raise ValueError("installed suite catalog executor is not admitted")


def _configured_target(
    contract: TargetContract,
    *,
    router_api_url: str | None,
    envoy_url: str | None,
    agent_task_ledger: HTTPServiceEndpoint | None,
    fault_recovery_ledger: HTTPServiceEndpoint | None,
    hard_policy_ledger: HTTPServiceEndpoint | None,
    production_experiment_ledger: HTTPServiceEndpoint | None,
    mixture: ManifestMixture | None,
    backend_topology_digest: str | None,
) -> EvaluationTarget:
    brokered = contract.execution_profile == "brokered-runtime"
    return EvaluationTarget(
        id=contract.id,
        kind=contract.kind,
        router_api_url=router_api_url if brokered else None,
        envoy_url=envoy_url if brokered else None,
        agent_task_ledger=agent_task_ledger if brokered else None,
        fault_recovery_ledger=fault_recovery_ledger if brokered else None,
        hard_policy_ledger=hard_policy_ledger if brokered else None,
        production_experiment_ledger=(
            production_experiment_ledger if brokered else None
        ),
        mixture=mixture if brokered else None,
        backend_topology_digest=backend_topology_digest if brokered else None,
    )


def _catalog_target(
    contract: TargetContract,
    configured: EvaluationTarget,
    installed_suite_count: int,
    *,
    mixture: CatalogMixture | None = None,
) -> CatalogTarget:
    return CatalogTarget(
        id=contract.id,
        name=contract.name,
        description=contract.description,
        kind=contract.kind,
        track_ids=contract.available_tracks(configured),
        modes=contract.modes,
        accepted_executors=contract.accepted_executors,
        evidence_level=contract.evidence_level,
        healthy=contract.healthy(configured, installed_suite_count),
        labels=(dict(contract.labels) if contract.labels is not None else None),
        mixture=mixture,
    )


def _configured_builtin_suites(
    agent_task_ledger: HTTPServiceEndpoint | None,
    fault_recovery_ledger: HTTPServiceEndpoint | None,
    hard_policy_ledger: HTTPServiceEndpoint | None,
    production_experiment_ledger: HTTPServiceEndpoint | None,
) -> tuple[CatalogSuite, ...]:
    configured_ledgers = {
        "live-agent-task.v1": agent_task_ledger is not None,
        "live-fault-recovery.v1": fault_recovery_ledger is not None,
        "policy.hard-enforcement.v1": hard_policy_ledger is not None,
        "production.experiment-controls.v1": production_experiment_ledger is not None,
        "production.preference-lift.v1": production_experiment_ledger is not None,
    }
    return tuple(
        suite.model_copy(
            update={
                "methods": tuple(
                    (
                        method.model_copy(
                            update={"status": "configured", "reason": None}
                        )
                        if configured_ledgers.get(method.id, False)
                        else method
                    )
                    for method in suite.methods
                )
            }
        )
        for suite in _SUITES
    )


def get_catalog(
    *,
    generated_at: bool = True,
    router_api_url: str | None = None,
    envoy_url: str | None = None,
    agent_task_ledger: HTTPServiceEndpoint | None = None,
    fault_recovery_ledger: HTTPServiceEndpoint | None = None,
    hard_policy_ledger: HTTPServiceEndpoint | None = None,
    production_experiment_ledger: HTTPServiceEndpoint | None = None,
    mixture: ManifestMixture | None = None,
    backend_topology_digest: str | None = None,
    installed_suites: tuple[CatalogSuite, ...] = (),
    executor_contracts: tuple[ExecutorContract, ...] = BUILTIN_EXECUTOR_CONTRACTS,
    target_registry: TargetRegistry = DEFAULT_TARGET_REGISTRY,
) -> EvaluationCatalog:
    _validate_installed_suites(installed_suites, executor_contracts)
    targets: list[CatalogTarget] = []
    for contract in target_registry.contracts:
        configured = _configured_target(
            contract,
            router_api_url=router_api_url,
            envoy_url=envoy_url,
            agent_task_ledger=agent_task_ledger,
            fault_recovery_ledger=fault_recovery_ledger,
            hard_policy_ledger=hard_policy_ledger,
            production_experiment_ledger=production_experiment_ledger,
            mixture=mixture,
            backend_topology_digest=backend_topology_digest,
        )
        targets.append(_catalog_target(contract, configured, len(installed_suites)))
    if mixture is not None:
        contract = mixture_target_contract(mixture)
        configured = _configured_target(
            contract,
            router_api_url=router_api_url,
            envoy_url=envoy_url,
            agent_task_ledger=agent_task_ledger,
            fault_recovery_ledger=fault_recovery_ledger,
            hard_policy_ledger=hard_policy_ledger,
            production_experiment_ledger=production_experiment_ledger,
            mixture=mixture,
            backend_topology_digest=backend_topology_digest,
        )
        targets.append(
            _catalog_target(
                contract,
                configured,
                len(installed_suites),
                mixture=mixture.public_summary(),
            )
        )
    builtin_suites = _configured_builtin_suites(
        agent_task_ledger,
        fault_recovery_ledger,
        hard_policy_ledger,
        production_experiment_ledger,
    )
    return EvaluationCatalog(
        generated_at=datetime.now(timezone.utc) if generated_at else None,
        change_profiles=tuple(
            CatalogChangeProfile(
                id=profile.id,
                name=profile.name,
                description=profile.description,
                campaign_slots=_campaign_slots(profile.id),
            )
            for profile in CHANGE_PROFILE_DEFINITIONS
        ),
        tracks=_TRACKS,
        suites=(*builtin_suites, *installed_suites),
        targets=tuple(targets),
    )
