"""Typed boundary shared by every evaluation evidence executor."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from pydantic import field_serializer, model_validator

from cli.evaluation.contracts import (
    BindingSnapshot,
    EvaluationTargetArm,
    GradingCaseSet,
    PolicySnapshot,
    PoolDefinition,
    RunEnvironment,
    StrictModel,
    VisibleCaseSet,
)
from cli.evaluation.evidence import ReplayFixture
from cli.evaluation.suite_contract import SUITE_CONTRACT_VERSION

FIXTURE_REPLAY_EXECUTOR_ID = "fixture-replay.v1"
MOM_REPLAY_EXECUTOR_ID = "mom-cohort-replay.v1"
LIVE_RUNTIME_EXECUTOR_ID = "live-runtime.v1"
NORMALIZED_REPLAY_EXECUTOR_ID = "normalized-suite-replay.v1"
NORMALIZED_LIVE_EXECUTOR_ID = "normalized-suite-live.v1"


class NormalizedIdentity(StrictModel):
    suite_id: str
    opaque_id: str
    source_id: str


class NormalizedSuiteIdentities(StrictModel):
    """Private, typed source-to-opaque lineage for normalized suites."""

    schema_version: Literal[SUITE_CONTRACT_VERSION] = SUITE_CONTRACT_VERSION
    suite_revisions: Mapping[str, str]
    case_identities: tuple[NormalizedIdentity, ...]
    arm_identities: tuple[NormalizedIdentity, ...]
    action_identities: tuple[NormalizedIdentity, ...]

    @model_validator(mode="after")
    def freeze_and_validate(self) -> NormalizedSuiteIdentities:
        revisions = MappingProxyType(dict(self.suite_revisions))
        if not revisions or any(not revision for revision in revisions.values()):
            raise ValueError("normalized identity lineage requires suite revisions")
        for identities in (
            self.case_identities,
            self.arm_identities,
            self.action_identities,
        ):
            keys = [(row.suite_id, row.source_id) for row in identities]
            opaque_ids = [row.opaque_id for row in identities]
            if any(row.suite_id not in revisions for row in identities):
                raise ValueError("normalized identity references an unknown suite")
            if len(keys) != len(set(keys)) or len(opaque_ids) != len(set(opaque_ids)):
                raise ValueError("normalized identities must be unique")
        object.__setattr__(self, "suite_revisions", revisions)
        return self

    @field_serializer("suite_revisions")
    def serialize_suite_revisions(self, value: Mapping[str, str]) -> dict[str, str]:
        return dict(value)


@dataclass(frozen=True)
class EvaluationInputs:
    """Complete, executor-independent inputs captured for one run."""

    visible: VisibleCaseSet
    grading: GradingCaseSet
    fixture: ReplayFixture | None
    policy: PolicySnapshot
    pool: PoolDefinition
    arms: tuple[EvaluationTargetArm, ...]
    binding: BindingSnapshot
    environment: RunEnvironment
    suite_revisions: Mapping[str, str]
    suite_executors: Mapping[str, str]
    executor_ids: Mapping[str, str]
    private_identity_map: NormalizedSuiteIdentities | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "suite_revisions", MappingProxyType(dict(self.suite_revisions))
        )
        object.__setattr__(
            self, "suite_executors", MappingProxyType(dict(self.suite_executors))
        )
        object.__setattr__(
            self, "executor_ids", MappingProxyType(dict(self.executor_ids))
        )
        visible_ids = tuple(case.id for case in self.visible.cases)
        grading_ids = tuple(case.case_id for case in self.grading.cases)
        if visible_ids != grading_ids:
            raise ValueError("visible and grading cases must have identical ordering")
        if self.fixture is not None:
            fixture_ids = tuple(case.case_id for case in self.fixture.cases)
            if visible_ids != fixture_ids:
                raise ValueError(
                    "visible, grading, and replay cases must have identical ordering"
                )
        if not self.suite_revisions:
            raise ValueError("evaluation inputs require immutable suite revisions")
        if set(self.suite_executors) != set(self.suite_revisions):
            raise ValueError(
                "evaluation inputs require one executor identity per suite revision"
            )
        if not self.executor_ids or any(
            not value for value in self.executor_ids.values()
        ):
            raise ValueError("evaluation inputs require an executor id for every track")
