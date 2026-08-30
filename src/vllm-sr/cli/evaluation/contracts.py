"""Strict, versioned input contracts for an evaluation run."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cli.evaluation.capacity_load_contract import (
    CAPACITY_LOAD_CONFIDENCE_LEVEL,
    CAPACITY_LOAD_KIND,
    MAX_CAPACITY_MEASUREMENT_REQUESTS,
    MAX_CAPACITY_REPETITIONS,
    MAX_CAPACITY_STABILITY_CV,
    MAX_CAPACITY_WARMUP_MULTIPLIER,
    MIN_CAPACITY_MEASUREMENT_REQUESTS,
    MIN_CAPACITY_REPETITIONS,
    MIN_CAPACITY_WARMUP_MULTIPLIER,
    capacity_concurrency_levels,
    default_capacity_load_protocol_fields,
)
from cli.evaluation.constants import BUILTIN_SUITE_IDS, SCHEMA_VERSION, TRACK_IDS
from cli.evaluation.contract_validation import (
    is_portable_id,
    is_valid_suite_revision,
    validate_canonical_uuid,
    validate_http_origin,
    validate_inline_image_url,
    validate_portable_id,
    validate_run_description,
    validate_run_name,
    validate_secret_env,
)
from cli.evaluation.gate_contract import GATE_CONTRACT_VERSION, ChangeProfile
from cli.evaluation.manifest_identity import (
    mixture_target_id,
    model_pool_snapshot_digest,
    require_manifest_digest,
    seal_manifest_fields,
    selector_snapshot_digest,
)

_MAX_MIXTURE_ALIAS_BYTES = 512
_MAX_SUITE_EXECUTOR_ID_LENGTH = 128
_MINIMUM_MIXTURE_ARM_COUNT = 2
_MINIMUM_LIVE_CAPACITY_CONCURRENCY = 2


class StrictModel(BaseModel):
    """Base contract that rejects silent schema drift."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ArtifactRef(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    media_type: str = Field(min_length=1, max_length=128)
    size_bytes: int = Field(ge=0)


class SecretRef(StrictModel):
    """Credential reference; literal credentials are intentionally unsupported."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    env: str

    @field_validator("env")
    @classmethod
    def validate_env(cls, value: str) -> str:
        return validate_secret_env(value)


class TextPart(StrictModel):
    type: Literal["text"] = "text"
    text: str


class ImageURL(StrictModel):
    url: str
    detail: Literal["auto", "low", "high"] | None = None

    @field_validator("url")
    @classmethod
    def validate_inline_image(cls, value: str) -> str:
        return validate_inline_image_url(value)


class ImagePart(StrictModel):
    type: Literal["image_url"] = "image_url"
    image_url: ImageURL


ContentPart = Annotated[TextPart | ImagePart, Field(discriminator="type")]


class Message(StrictModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | tuple[ContentPart, ...]
    name: str | None = None
    tool_call_id: str | None = None


class CaseVisible(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    track_ids: tuple[str, ...] = Field(min_length=1)
    messages: tuple[Message, ...] = Field(min_length=1)
    modality: Literal["text", "image", "document", "audio", "video"] = "text"
    tags: tuple[str, ...] = ()
    trajectory_id: str | None = None

    _id = field_validator("id")(validate_portable_id)

    @field_validator("track_ids")
    @classmethod
    def validate_track_ids(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("case track ids must be unique")
        canonical = tuple(track_id for track_id in TRACK_IDS if track_id in value)
        if value != canonical:
            raise ValueError("case track ids must be known and use canonical order")
        return value

    @model_validator(mode="after")
    def validate_track_applicability(self) -> CaseVisible:
        if self.modality == "text" and "multimodal" in self.track_ids:
            raise ValueError("text cases cannot plan multimodal evidence")
        return self


class CaseGrading(StrictModel):
    """Hidden labels loaded only after policy/model execution."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    case_id: str
    expected_route: str | None = None
    expected_answer: str | None = None
    preferred_arm_id: str | None = None
    expected_tools: tuple[str, ...] = ()
    should_block: bool | None = None
    weight: float = Field(default=1.0, gt=0)

    _case_id = field_validator("case_id")(validate_portable_id)


class VisibleCaseSet(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    cases: tuple[CaseVisible, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_cases(self) -> VisibleCaseSet:
        ids = [case.id for case in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("visible case ids must be unique")
        return self


class GradingCaseSet(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    cases: tuple[CaseGrading, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_cases(self) -> GradingCaseSet:
        ids = [case.case_id for case in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("grading case ids must be unique")
        return self


class WorkloadSnapshot(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    visible_cases: ArtifactRef
    grading_cases: ArtifactRef

    _id = field_validator("id")(validate_portable_id)

    @model_validator(mode="after")
    def physically_separated(self) -> WorkloadSnapshot:
        if self.visible_cases.digest == self.grading_cases.digest:
            raise ValueError("visible and grading cases must be separate artifacts")
        return self


class HTTPServiceEndpoint(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    url: str
    api_key: SecretRef | None = None
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return validate_http_origin(value, label="endpoint URL")


class ModelArm(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    model: str = Field(min_length=1)
    endpoint: HTTPServiceEndpoint | None = None
    input_cost_per_million_tokens_usd: float = Field(default=0, ge=0)
    output_cost_per_million_tokens_usd: float = Field(default=0, ge=0)

    _id = field_validator("id")(validate_portable_id)


class PoolDefinition(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    arm_ids: tuple[str, ...] = ()

    _id = field_validator("id")(validate_portable_id)

    @field_validator("arm_ids")
    @classmethod
    def unique_arms(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("pool arm ids must be unique")
        return value


class PolicySnapshot(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    entrypoint_model: str = Field(min_length=1)
    recipe_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    _id = field_validator("id")(validate_portable_id)


class BindingSnapshot(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    policy_id: str
    pool_id: str

    _id = field_validator("id")(validate_portable_id)


class RunEnvironment(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    target_id: str
    platform: str = Field(min_length=1)
    hardware_class: str = Field(min_length=1)
    backend_topology_digest: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    route_eval: HTTPServiceEndpoint | None = None
    routed_chat: HTTPServiceEndpoint | None = None
    agent_task_ledger: HTTPServiceEndpoint | None = None
    fault_recovery_ledger: HTTPServiceEndpoint | None = None
    hard_policy_ledger: HTTPServiceEndpoint | None = None
    production_experiment_ledger: HTTPServiceEndpoint | None = None
    replay: HTTPServiceEndpoint | None = None
    currency: Literal["USD"] = "USD"

    _id = field_validator("id")(validate_portable_id)


class EvaluationTargetArm(StrictModel):
    """Server-owned public model identity and pricing, never connectivity."""

    id: str
    model: str = Field(min_length=1, max_length=512)
    provider_model_id_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    input_cost_per_million_tokens_usd: float = Field(
        ge=0, strict=True, allow_inf_nan=False
    )
    output_cost_per_million_tokens_usd: float = Field(
        ge=0, strict=True, allow_inf_nan=False
    )
    capabilities: tuple[str, ...] = ()
    modalities: tuple[Literal["text", "image", "document", "audio", "video"], ...] = ()
    context_window_tokens: int | None = Field(default=None, gt=0)
    parameter_size: str | None = Field(default=None, min_length=1, max_length=64)
    runtime_revision: str | None = Field(default=None, min_length=1, max_length=160)
    config_digest: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")

    _id = field_validator("id")(validate_portable_id)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if not value or value.strip() != value:
            raise ValueError("model must be non-empty and already trimmed")
        return value

    @field_validator("capabilities", "modalities")
    @classmethod
    def unique_capability_values(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("model arm capability values must be unique")
        if any(not item or item.strip() != item for item in value):
            raise ValueError(
                "model arm capability values must be non-empty and already trimmed"
            )
        return value


class SupportModelIdentity(StrictModel):
    """Server-frozen executable identity for a selector-only model."""

    model: str = Field(min_length=1, max_length=512)
    provider_model_id_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    config_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    runtime_revision: str | None = Field(default=None, min_length=1, max_length=160)
    backend_topology_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("support model must already be trimmed")
        return value

    @field_validator("runtime_revision")
    @classmethod
    def validate_runtime_revision(cls, value: str | None) -> str | None:
        if value is not None and value.strip() != value:
            raise ValueError("support runtime revision must already be trimmed")
        return value


class MixtureDecisionBinding(StrictModel):
    """Frozen candidate boundary for one decision in a selected Recipe."""

    name: str = Field(min_length=1, max_length=160)
    algorithm: str = Field(min_length=1, max_length=160)
    arm_ids: tuple[str, ...] = Field(min_length=1)

    @field_validator("name", "algorithm")
    @classmethod
    def validate_trimmed_value(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("mixture decision values must already be trimmed")
        return value

    @field_validator("arm_ids")
    @classmethod
    def validate_arm_ids(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("mixture decision arm ids must be unique")
        if value != tuple(sorted(value)):
            raise ValueError("mixture decision arm ids must use lexical order")
        for arm_id in value:
            validate_portable_id(arm_id)
        return value


class CatalogMixture(StrictModel):
    """Connectivity-free public summary of one frozen Mixture-of-Models."""

    id: str
    entrypoint_model: str = Field(min_length=1, max_length=512)
    aliases: tuple[str, ...] = Field(min_length=1)
    recipe_name: str = Field(min_length=1, max_length=160)
    recipe_description: str = Field(max_length=4000)
    recipe_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    pool_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    selector_policy_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    selector_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    adaptation_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    binding_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    model_arms: tuple[EvaluationTargetArm, ...] = Field(min_length=1)
    support_models: tuple[SupportModelIdentity, ...] = ()
    fallback_arm_id: str | None = None
    decisions: tuple[MixtureDecisionBinding, ...] = ()

    _id = field_validator("id")(validate_portable_id)

    @field_validator(
        "entrypoint_model",
        "recipe_name",
        "recipe_description",
    )
    @classmethod
    def validate_trimmed_text(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("mixture text fields must already be trimmed")
        return value

    @field_validator("aliases")
    @classmethod
    def validate_model_names(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("mixture model names must be unique")
        if any(
            not item
            or item.strip() != item
            or len(item.encode("utf-8")) > _MAX_MIXTURE_ALIAS_BYTES
            for item in value
        ):
            raise ValueError("mixture model names must be non-empty trimmed values")
        return value

    @model_validator(mode="after")
    def validate_frozen_subject(self) -> CatalogMixture:
        self._validate_primary_identity()
        arm_ids, owners = self._validate_model_arms()
        self._validate_support_models(owners)
        self._validate_decisions(arm_ids)
        self._validate_snapshot_digests()
        return self

    def _validate_primary_identity(self) -> None:
        if self.id != mixture_target_id(self.recipe_name):
            raise ValueError("mixture id must bind its recipe name")
        if self.entrypoint_model not in self.aliases:
            raise ValueError("mixture aliases must include the selected entrypoint")

    def _validate_model_arms(self) -> tuple[list[str], dict[str, str]]:
        arm_ids = [arm.id for arm in self.model_arms]
        if len(arm_ids) != len(set(arm_ids)):
            raise ValueError("mixture arm ids must be unique")
        arm_models = [arm.model for arm in self.model_arms]
        if len(arm_models) != len(set(arm_models)):
            raise ValueError("mixture arm models must be unique")
        owners: dict[str, str] = {}
        for arm in self.model_arms:
            for selector in {arm.id, arm.model}:
                owner = owners.setdefault(selector, arm.id)
                if owner != arm.id:
                    raise ValueError("mixture arm ids and models must be unambiguous")
        if arm_models != sorted(arm_models):
            raise ValueError("mixture model arms must be ordered by logical model")
        return arm_ids, owners

    def _validate_support_models(self, arm_owners: dict[str, str]) -> None:
        support_names = tuple(model.model for model in self.support_models)
        if len(support_names) != len(set(support_names)):
            raise ValueError("mixture support model identities must be unique")
        if set(support_names).intersection(arm_owners):
            raise ValueError(
                "mixture support models must remain outside the model pool"
            )
        if support_names != tuple(sorted(support_names)):
            raise ValueError("mixture support models must use lexical order")

    def _validate_decisions(self, arm_ids: list[str]) -> None:
        if self.fallback_arm_id is not None and self.fallback_arm_id not in arm_ids:
            raise ValueError("mixture fallback arm must belong to the model pool")
        decision_names = [decision.name for decision in self.decisions]
        if len(decision_names) != len(set(decision_names)):
            raise ValueError("mixture decision names must be unique")
        declared = set(arm_ids)
        if any(
            not set(decision.arm_ids).issubset(declared) for decision in self.decisions
        ):
            raise ValueError("mixture decisions may reference only declared arms")
        if any(not is_portable_id(decision.algorithm) for decision in self.decisions):
            raise ValueError("mixture decision algorithms must be portable identifiers")

    def _validate_snapshot_digests(self) -> None:
        if self.pool_digest != model_pool_snapshot_digest(self.model_arms):
            raise ValueError("mixture pool digest must bind its model arms")
        if self.selector_digest != selector_snapshot_digest(
            self.selector_policy_digest, self.support_models
        ):
            raise ValueError(
                "mixture selector digest must bind policy and support models"
            )


class ManifestMixture(CatalogMixture):
    """Server-sealed execution subject embedded in a live run manifest."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION

    def public_summary(self) -> CatalogMixture:
        return CatalogMixture.model_validate(
            self.model_dump(mode="python", exclude={"schema_version"})
        )


class EvaluationTarget(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    kind: str = Field(min_length=1, max_length=64)
    router_api_url: str | None = None
    envoy_url: str | None = None
    router_api_key: SecretRef | None = None
    envoy_api_key: SecretRef | None = None
    agent_task_ledger: HTTPServiceEndpoint | None = None
    fault_recovery_ledger: HTTPServiceEndpoint | None = None
    hard_policy_ledger: HTTPServiceEndpoint | None = None
    production_experiment_ledger: HTTPServiceEndpoint | None = None
    backend_topology_digest: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    mixture: ManifestMixture | None = None

    _id = field_validator("id")(validate_portable_id)

    @field_validator("router_api_url", "envoy_url")
    @classmethod
    def validate_optional_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_http_origin(value, label="target URL")

    @model_validator(mode="after")
    def validate_runtime_connectivity(self) -> EvaluationTarget:
        if self.mixture is not None and (
            self.id != self.mixture.id or self.kind != "mixture-of-models"
        ):
            raise ValueError(
                "a frozen mixture target must use its server-owned id and kind"
            )
        if self.router_api_key is not None and self.router_api_url is None:
            raise ValueError("router_api_key requires router_api_url")
        if self.envoy_api_key is not None and self.envoy_url is None:
            raise ValueError("envoy_api_key requires envoy_url")
        credential_envs = [
            ref.env
            for ref in (
                self.router_api_key,
                self.envoy_api_key,
                (
                    self.agent_task_ledger.api_key
                    if self.agent_task_ledger is not None
                    else None
                ),
                (
                    self.fault_recovery_ledger.api_key
                    if self.fault_recovery_ledger is not None
                    else None
                ),
                (
                    self.hard_policy_ledger.api_key
                    if self.hard_policy_ledger is not None
                    else None
                ),
                (
                    self.production_experiment_ledger.api_key
                    if self.production_experiment_ledger is not None
                    else None
                ),
            )
            if ref is not None
        ]
        if len(credential_envs) != len(set(credential_envs)):
            raise ValueError(
                "evaluation credentials require distinct environment variables"
            )
        return self


class CapacitySLO(StrictModel):
    """Frozen service-level objective for a repeated live load profile.

    The throughput requirement applies at and above ``required_concurrency``.
    Scaling efficiency is the observed throughput growth factor divided by the
    concurrency growth factor between adjacent sweep levels.
    """

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    required_concurrency: int = Field(ge=1, le=128)
    max_latency_p95_ms: float = Field(gt=0, allow_inf_nan=False)
    max_error_rate: float = Field(ge=0, lt=1, allow_inf_nan=False)
    min_throughput_rps: float = Field(gt=0, allow_inf_nan=False)
    min_throughput_scaling_efficiency: float = Field(gt=0, le=1, allow_inf_nan=False)


class CapacityLoadProtocol(StrictModel):
    """Frozen repeated closed-loop measurement protocol for a live load claim."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    kind: Literal[CAPACITY_LOAD_KIND] = CAPACITY_LOAD_KIND
    concurrency_levels: tuple[int, ...] = Field(min_length=2, max_length=8)
    warmup_request_multiplier: int = Field(
        ge=MIN_CAPACITY_WARMUP_MULTIPLIER,
        le=MAX_CAPACITY_WARMUP_MULTIPLIER,
    )
    measurement_requests_per_repetition: int = Field(
        ge=MIN_CAPACITY_MEASUREMENT_REQUESTS,
        le=MAX_CAPACITY_MEASUREMENT_REQUESTS,
    )
    repetitions_per_level: int = Field(
        ge=MIN_CAPACITY_REPETITIONS,
        le=MAX_CAPACITY_REPETITIONS,
    )
    confidence_level: Literal[CAPACITY_LOAD_CONFIDENCE_LEVEL] = (
        CAPACITY_LOAD_CONFIDENCE_LEVEL
    )
    max_throughput_cv: float = Field(
        gt=0, le=MAX_CAPACITY_STABILITY_CV, allow_inf_nan=False
    )
    max_latency_p95_cv: float = Field(
        gt=0, le=MAX_CAPACITY_STABILITY_CV, allow_inf_nan=False
    )

    @model_validator(mode="after")
    def validate_load_ladder(self) -> CapacityLoadProtocol:
        if self.concurrency_levels != capacity_concurrency_levels(
            self.concurrency_levels[-1]
        ):
            raise ValueError(
                "capacity concurrency_levels must use the geometric platform ladder"
            )
        return self


def default_capacity_load_protocol(maximum: int) -> CapacityLoadProtocol:
    return CapacityLoadProtocol.model_validate(
        default_capacity_load_protocol_fields(maximum)
    )


class RunManifest(StrictModel):
    """Fixed public worker manifest shared with the Dashboard backend."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    manifest_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    run_id: str
    name: str
    description: str
    mode: Literal["replay", "live"]
    target: EvaluationTarget
    change_profile: ChangeProfile
    gate_contract_version: Literal[GATE_CONTRACT_VERSION]
    suite_ids: tuple[str, ...] = Field(min_length=1)
    suite_revisions: dict[str, str] = Field(min_length=1)
    suite_executors: dict[str, str] = Field(min_length=1)
    track_ids: tuple[str, ...] = Field(min_length=1)
    sample_limit: int = Field(gt=0, le=100000)
    concurrency: int = Field(ge=1, le=128)
    capacity_slo: CapacitySLO | None = None
    capacity_load_protocol: CapacityLoadProtocol | None = None
    seed: int = Field(ge=0, le=2**32 - 1)
    baseline_run_id: str | None = None
    created_at: datetime
    code_revision: str = Field(pattern=r"^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$")
    policy_snapshot_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    config_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    redaction_policy: str = Field(min_length=1, max_length=160)

    _run_id = field_validator("run_id")(validate_canonical_uuid)
    _name = field_validator("name")(validate_run_name)
    _description = field_validator("description")(validate_run_description)

    @classmethod
    def from_semantic_fields(cls, **fields: object) -> Self:
        if "manifest_digest" in fields:
            raise ValueError("manifest_digest is derived from semantic fields")
        semantic_fields = {"schema_version": SCHEMA_VERSION, **fields}
        return cls.model_validate(seal_manifest_fields(semantic_fields))

    def with_semantic_updates(self, **updates: object) -> Self:
        if "manifest_digest" in updates:
            raise ValueError("manifest_digest is derived from semantic fields")
        fields = self.model_dump(mode="python", exclude={"manifest_digest"})
        fields.update(updates)
        return type(self).model_validate(seal_manifest_fields(fields))

    @field_validator("baseline_run_id")
    @classmethod
    def validate_baseline_run_id(cls, value: str | None) -> str | None:
        return validate_canonical_uuid(value) if value is not None else None

    @field_validator("track_ids")
    @classmethod
    def validate_tracks(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        unknown = sorted(set(value) - set(TRACK_IDS))
        if unknown:
            raise ValueError(f"unknown track ids: {', '.join(unknown)}")
        if len(value) != len(set(value)):
            raise ValueError("track ids must be unique")
        canonical = tuple(track_id for track_id in TRACK_IDS if track_id in value)
        if value != canonical:
            raise ValueError("track ids must use canonical catalog order")
        return value

    @field_validator("suite_ids")
    @classmethod
    def validate_suites(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("suite ids must be unique")
        for suite_id in value:
            validate_portable_id(suite_id)
        builtin = set(value).intersection(BUILTIN_SUITE_IDS)
        if builtin:
            if len(builtin) != len(value):
                raise ValueError("builtin and installed suite ids cannot be mixed")
            canonical = tuple(
                suite_id for suite_id in BUILTIN_SUITE_IDS if suite_id in value
            )
            if value != canonical:
                raise ValueError("builtin suite ids must use canonical catalog order")
        elif value != tuple(sorted(value)):
            raise ValueError("installed suite ids must use lexical canonical order")
        return value

    @model_validator(mode="after")
    def validate_frozen_manifest_structure(self) -> RunManifest:
        self._validate_suite_bindings()
        self._validate_mixture_binding()
        self._validate_capacity_binding()
        require_manifest_digest(self)
        return self

    def _validate_suite_bindings(self) -> None:
        if set(self.suite_revisions) != set(self.suite_ids) or any(
            not is_valid_suite_revision(revision)
            for revision in self.suite_revisions.values()
        ):
            raise ValueError(
                "suite_revisions must contain one non-empty immutable identity per suite_id"
            )
        if set(self.suite_executors) != set(self.suite_ids) or any(
            not executor_id.strip()
            or len(executor_id) > _MAX_SUITE_EXECUTOR_ID_LENGTH
            or not is_portable_id(executor_id)
            for executor_id in self.suite_executors.values()
        ):
            raise ValueError(
                "suite_executors must contain one portable identity per suite_id"
            )
        if len(set(self.suite_executors.values())) != 1:
            raise ValueError("one evaluation run cannot mix executor implementations")

    def _validate_mixture_binding(self) -> None:
        mixture = self.target.mixture
        is_mom_replay = self.mode == "replay" and self.suite_executors == {
            "live-mom-core": "mom-cohort-replay.v1"
        }
        if mixture is not None:
            if self.policy_snapshot_digest != mixture.recipe_digest:
                raise ValueError(
                    "policy_snapshot_digest must equal the selected mixture recipe digest"
                )
            if len(mixture.model_arms) < _MINIMUM_MIXTURE_ARM_COUNT:
                raise ValueError(
                    "Mixture-of-Models evaluation requires at least two arms"
                )
        elif self.mode == "live":
            raise ValueError("live evaluation requires a frozen target mixture")
        if self.mode == "replay" and mixture is not None and not is_mom_replay:
            raise ValueError(
                "only the frozen MoM campaign cohort may replay a Mixture target"
            )

    def _validate_capacity_binding(self) -> None:
        capacity_selected = "capacity" in self.track_ids
        if capacity_selected and self.mode == "live":
            if self.concurrency < _MINIMUM_LIVE_CAPACITY_CONCURRENCY:
                raise ValueError(
                    "live capacity track requires concurrency of at least 2"
                )
            if self.capacity_slo is None:
                raise ValueError("live capacity track requires capacity_slo")
            if self.capacity_load_protocol is None:
                raise ValueError("live capacity track requires capacity_load_protocol")
            if self.capacity_slo.required_concurrency > self.concurrency:
                raise ValueError(
                    "capacity_slo required_concurrency cannot exceed run concurrency"
                )
            if self.capacity_load_protocol.concurrency_levels[-1] != self.concurrency:
                raise ValueError(
                    "capacity_load_protocol must terminate at run concurrency"
                )
        elif self.capacity_slo is not None or self.capacity_load_protocol is not None:
            raise ValueError(
                "capacity_slo and capacity_load_protocol are valid only for a live capacity track"
            )


class ExecutorMetadata(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    track_id: str
    executor_id: str
    mode: Literal["replay", "live"]

    @field_validator("track_id")
    @classmethod
    def validate_track(cls, value: str) -> str:
        if value not in TRACK_IDS:
            raise ValueError("unknown track id")
        return value


class ResolvedRunSnapshot(StrictModel):
    """Content-addressed run graph resolved from the fixed public manifest."""

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    manifest_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    workload: WorkloadSnapshot
    policy: PolicySnapshot
    binding: BindingSnapshot
    pool: PoolDefinition
    arms: tuple[EvaluationTargetArm, ...]
    environment: RunEnvironment
    fixture_ref: ArtifactRef | None = None
    discovered_entrypoints: tuple[str, ...] = ()
    executors: tuple[ExecutorMetadata, ...]
