"""Public report contracts kept in lockstep with the Dashboard types."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from cli.evaluation.constants import SCHEMA_VERSION
from cli.evaluation.contracts import (
    CapacityLoadProtocol,
    CapacitySLO,
    CatalogMixture,
    StrictModel,
    validate_canonical_uuid,
    validate_run_description,
    validate_run_name,
)
from cli.evaluation.gate_contract import GATE_CONTRACT_VERSION, ChangeProfile

TrackID = Literal[
    "routing",
    "model_pool",
    "joint",
    "agentic",
    "multimodal",
    "preference",
    "safety",
    "capacity",
]
EvidenceLevel = Literal["E0", "E1", "E2", "E3", "E4", "E5"]
GateVerdict = Literal["pass", "fail", "unavailable", "waived", "not_applicable"]

_MAX_EVENT_MESSAGE_BYTES = 512
_MIN_CAPACITY_CONCURRENCY = 2


class EvaluationRunProgress(StrictModel):
    percent: float = Field(ge=0, le=100)
    completed: int = Field(ge=0)
    total: int = Field(ge=0)
    current_track_id: TrackID | None = None
    message: str | None = None

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str | None) -> str | None:
        if value is not None and (
            value.strip() != value
            or len(value.encode("utf-8")) > _MAX_EVENT_MESSAGE_BYTES
        ):
            raise ValueError("progress message must be trimmed and at most 512 bytes")
        return value


class EvaluationRun(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    id: str
    client_request_id: str
    name: str
    description: str
    status: Literal["pending", "running", "sealing", "completed", "failed", "cancelled"]
    mode: Literal["replay", "live"]
    evidence_level: EvidenceLevel
    target_id: str
    mixture: CatalogMixture | None = None
    change_profile: ChangeProfile
    suite_ids: tuple[str, ...]
    track_ids: tuple[TrackID, ...]
    sample_limit: int
    concurrency: int
    capacity_slo: CapacitySLO | None = None
    capacity_load_protocol: CapacityLoadProtocol | None = None
    seed: int
    baseline_run_id: str | None = None
    progress: EvaluationRunProgress
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None

    _id = field_validator("id", "client_request_id")(validate_canonical_uuid)
    _name = field_validator("name")(validate_run_name)
    _description = field_validator("description")(validate_run_description)

    @field_validator("baseline_run_id")
    @classmethod
    def validate_baseline_run_id(cls, value: str | None) -> str | None:
        return validate_canonical_uuid(value) if value is not None else None

    @model_validator(mode="after")
    def client_identity_matches_run(self) -> EvaluationRun:
        if self.client_request_id != self.id:
            raise ValueError("client_request_id must equal the run id")
        if self.mode == "live" and self.mixture is None:
            raise ValueError("live evaluation run requires its frozen mixture summary")
        if (
            self.mode == "replay"
            and self.mixture is not None
            and self.suite_ids != ("live-mom-core",)
        ):
            raise ValueError(
                "only the frozen MoM campaign cohort may replay a Mixture target"
            )
        capacity_selected = "capacity" in self.track_ids
        if self.mode == "live" and capacity_selected:
            if self.concurrency < _MIN_CAPACITY_CONCURRENCY:
                raise ValueError("live capacity run requires concurrency of at least 2")
            if self.capacity_slo is None:
                raise ValueError("live capacity run requires capacity_slo")
            if self.capacity_load_protocol is None:
                raise ValueError("live capacity run requires capacity_load_protocol")
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
                "capacity_slo and capacity_load_protocol are valid only for a live capacity run"
            )
        return self


class EvaluationCoverage(StrictModel):
    evaluated: int = Field(ge=0)
    total: int = Field(ge=0)
    fraction: float = Field(ge=0, le=1)
    unavailable: int | None = Field(default=None, ge=0)
    confidence_level: float | None = Field(default=None, gt=0, lt=1)
    confidence_interval: tuple[float, float] | None = None


class EvaluationMetric(StrictModel):
    id: str
    name: str
    track_id: TrackID | None = None
    value: float | None
    unit: str
    direction: Literal["higher_is_better", "lower_is_better", "target"] | None = None
    baseline_value: float | None = None
    delta: float | None = None
    confidence_interval: tuple[float, float] | None = None
    sample_count: int | None = Field(default=None, ge=0)


class GateThreshold(StrictModel):
    operator: str
    value: float
    unit: str | None = None


class EvaluationGate(StrictModel):
    id: str
    name: str
    description: str | None = None
    track_id: TrackID | None = None
    disposition: Literal["required", "advisory", "not_applicable", "waived"]
    verdict: GateVerdict
    change_profile: ChangeProfile
    contract_version: Literal[GATE_CONTRACT_VERSION]
    evidence_refs: tuple[str, ...] = Field(min_length=1)
    evidence_level: EvidenceLevel | None = None
    observed: float | None = None
    threshold: GateThreshold | None = None
    sample_count: int | None = Field(default=None, ge=0)
    coverage: EvaluationCoverage | None = None
    owner: str | None = Field(default=None, min_length=1, max_length=160)
    evaluated_at: datetime | None = None
    rationale: str | None = None

    @field_validator("evidence_refs")
    @classmethod
    def validate_evidence_refs(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)) or any(not item.strip() for item in value):
            raise ValueError("gate evidence refs must be unique and non-blank")
        return value


class EvaluationArtifact(StrictModel):
    id: str
    name: str
    kind: str
    uri: str | None = None
    digest: str | None = None
    media_type: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)


class EvaluationProvenance(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    generated_at: datetime
    code_revision: str | None = None
    benchmark_revisions: dict[str, str] | None = None
    workload_snapshot_digest: str | None = None
    policy_snapshot_digest: str | None = None
    binding_snapshot_digest: str | None = None
    pool_snapshot_digest: str | None = None
    environment_snapshot_digest: str | None = None
    target_id: str
    seed: int
    redaction_policy: str | None = None


class EvaluationCostAmount(StrictModel):
    amount: float | None = Field(default=None, ge=0)
    currency: str
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    gpu_seconds: float | None = Field(default=None, ge=0)
    energy_kwh: float | None = Field(default=None, ge=0)


class EvaluationCostLedgers(StrictModel):
    runtime: EvaluationCostAmount
    evaluation_overhead: EvaluationCostAmount
    capacity_tco: EvaluationCostAmount


class EvaluationTrackReport(StrictModel):
    track_id: TrackID
    status: Literal[
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "unavailable",
        "skipped",
    ]
    evidence_level: EvidenceLevel
    summary: str
    coverage: EvaluationCoverage
    metrics: tuple[EvaluationMetric, ...]
    gates: tuple[EvaluationGate, ...]
    artifacts: tuple[EvaluationArtifact, ...] = ()
    error: str | None = None


class EvaluationReportSummary(StrictModel):
    verdict: GateVerdict
    quality_score: float | None
    latency_p95_ms: float | None
    runtime_cost: float | None
    capacity_tco: float | None
    coverage: EvaluationCoverage
    passed_gates: int = Field(ge=0)
    failed_gates: int = Field(ge=0)
    unavailable_gates: int = Field(ge=0)


class EvaluationReport(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    run: EvaluationRun
    summary: EvaluationReportSummary
    tracks: tuple[EvaluationTrackReport, ...]
    metrics: tuple[EvaluationMetric, ...]
    gates: tuple[EvaluationGate, ...]
    costs: EvaluationCostLedgers
    recommendations: tuple[str, ...]
    provenance: EvaluationProvenance
    artifacts: tuple[EvaluationArtifact, ...]

    @model_validator(mode="after")
    def coherent_gate_contract(self) -> EvaluationReport:
        expected_ids = tuple(f"G{index}" for index in range(10))
        if tuple(gate.id for gate in self.gates) != expected_ids:
            raise ValueError("report must contain G0 through G9 exactly once in order")
        if any(gate.change_profile != self.run.change_profile for gate in self.gates):
            raise ValueError("report gates must match the run change profile")
        track_ids = tuple(track.track_id for track in self.tracks)
        if track_ids != self.run.track_ids:
            raise ValueError("report tracks must exactly match the run track order")
        expected_level = min(
            (track.evidence_level for track in self.tracks), default="E0"
        )
        if self.run.evidence_level != expected_level:
            raise ValueError("run evidence_level must equal the weakest selected track")
        return self


class EvaluationComparison(StrictModel):
    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    baseline_run_id: str
    candidate_run_id: str
    verdict: GateVerdict
    summary: str
    metrics: tuple[EvaluationMetric, ...]
    gates: tuple[EvaluationGate, ...]
    recommendations: tuple[str, ...]
    created_at: datetime | None = None


class TrackWorkerEventPayload(StrictModel):
    record_count: int = Field(ge=0, le=100_000_000)


class CompletedWorkerEventPayload(StrictModel):
    verdict: GateVerdict


WorkerEventPayload = TrackWorkerEventPayload | CompletedWorkerEventPayload
WorkerEventType = Literal[
    "snapshot",
    "progress",
    "track",
    "gate",
    "artifact",
    "completed",
    "failed",
    "cancelled",
]


class WorkerEvent(StrictModel):
    type: WorkerEventType
    message: str
    track_id: TrackID | None = None
    progress: EvaluationRunProgress | None = None
    payload: WorkerEventPayload | None = None

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if (
            not value
            or value.strip() != value
            or len(value.encode("utf-8")) > _MAX_EVENT_MESSAGE_BYTES
        ):
            raise ValueError("worker event message must be 1-512 trimmed bytes")
        return value

    @model_validator(mode="after")
    def payload_matches_event(self) -> WorkerEvent:
        if self.type == "track":
            if not isinstance(self.payload, TrackWorkerEventPayload):
                raise ValueError("track event requires only record_count payload")
        elif self.type == "completed":
            if not isinstance(self.payload, CompletedWorkerEventPayload):
                raise ValueError("completed event requires only verdict payload")
        elif self.payload is not None:
            raise ValueError(f"{self.type} event does not accept a payload")
        return self
