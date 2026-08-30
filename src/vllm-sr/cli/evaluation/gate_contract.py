"""Versioned release-gate applicability for Evaluation Plane runs.

The platform owns gate semantics and evidence sufficiency.  Product or recipe
owners own thresholds.  Keeping applicability separate from metric reducers
prevents a missing track from silently becoming a pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ChangeProfile = Literal[
    "schema_adapter",
    "recipe",
    "selector",
    "model_pool",
    "runtime_capacity",
    "agent_multimodal",
    "online_adaptation",
]
GateDisposition = Literal["required", "advisory", "not_applicable"]

GATE_CONTRACT_VERSION = "evaluation-release-gates.v2"
DEFAULT_CHANGE_PROFILE: ChangeProfile = "schema_adapter"


@dataclass(frozen=True)
class GateDefinition:
    id: str
    name: str
    description: str


@dataclass(frozen=True)
class ChangeProfileDefinition:
    id: ChangeProfile
    name: str
    description: str


CHANGE_PROFILE_DEFINITIONS = (
    ChangeProfileDefinition(
        "schema_adapter",
        "Schema / adapter",
        "Strict schema and adapter parity changes.",
    ),
    ChangeProfileDefinition(
        "recipe",
        "Routing recipe",
        "Recipe signal, decision, algorithm, and policy changes.",
    ),
    ChangeProfileDefinition(
        "selector",
        "Selector / binding",
        "Selector, projection, classifier, and binding changes.",
    ),
    ChangeProfileDefinition(
        "model_pool",
        "Model pool",
        "Logical arm composition, capability, quality, and price changes.",
    ),
    ChangeProfileDefinition(
        "runtime_capacity",
        "Runtime / capacity",
        "Serving runtime, placement, capacity, and transport changes.",
    ),
    ChangeProfileDefinition(
        "agent_multimodal",
        "Agent / multimodal",
        "Agent trajectory, tool, state, and multimodal changes.",
    ),
    ChangeProfileDefinition(
        "online_adaptation",
        "Online adaptation",
        "Online assignment, preference, feedback, and adaptive policy changes.",
    ),
)


GATE_DEFINITIONS = (
    GateDefinition(
        "G0",
        "Reproducibility",
        "Frozen manifests, snapshots, seeds, failures, and unbroken artifact lineage.",
    ),
    GateDefinition(
        "G1",
        "Static correctness",
        "Strict schemas, conformance, references, coverage, and deterministic replayability.",
    ),
    GateDefinition(
        "G2",
        "Hard policy",
        "Privacy, security, locality, authorization, modality, context, and tool invariants.",
    ),
    GateDefinition(
        "G3",
        "Offline value",
        "Server-controlled baseline/candidate value, absolute candidate safeguards, arm reliability, paired regret, and no-information-frontier improvement.",
    ),
    GateDefinition(
        "G4",
        "Declared-shift robustness",
        "Server-live execution of source-qualified pinned perturbation relations and their declared slices on the exact frozen corpus.",
    ),
    GateDefinition(
        "G5",
        "Live fidelity",
        "Qualified reference-to-fresh-live agreement for the unchanged candidate, with complete failure accounting.",
    ),
    GateDefinition(
        "G6",
        "Live fault-recovery continuity",
        "Server-brokered exact-step fault injection, paired baseline/treatment continuity, recovery latency, retry amplification, state isolation, and side effects.",
    ),
    GateDefinition(
        "G7",
        "Cost / latency / capacity",
        "Three cost ledgers, latency decomposition, saturation, SLO crossing, and headroom.",
    ),
    GateDefinition(
        "G8",
        "Shadow / canary",
        "Qualified assignment, divergence, guardrails, risk budget, and rollback evidence.",
    ),
    GateDefinition(
        "G9",
        "Online preference",
        "Participation, exposure, propensity, effective sample size, confidence, and segments.",
    ),
)


_R = "required"
_A = "advisory"
_N = "not_applicable"

# This is the default matrix from the evaluation proposal.  Conditional cells
# are conservatively advisory until an explicit product contract promotes them.
_APPLICABILITY: dict[ChangeProfile, tuple[GateDisposition, ...]] = {
    "schema_adapter": (_R, _R, _A, _A, _R, _A, _N, _A, _N, _N),
    "recipe": (_R, _R, _R, _R, _R, _R, _N, _R, _A, _N),
    "selector": (_R, _R, _R, _R, _R, _R, _A, _R, _R, _N),
    "model_pool": (_R, _R, _R, _R, _R, _R, _A, _R, _R, _N),
    "runtime_capacity": (_R, _R, _R, _A, _A, _R, _A, _R, _R, _N),
    # Agent/multimodal promotion does not use the text-only controlled-pair G3
    # protocol. Its live quality boundary is the exact-cohort multimodal G5
    # reference/fresh pair; agent continuity remains independently owned by G6.
    "agent_multimodal": (_R, _R, _R, _N, _R, _R, _R, _R, _R, _A),
    "online_adaptation": (_R, _R, _R, _R, _R, _R, _R, _R, _R, _R),
}


def gate_applicability(
    profile: ChangeProfile,
) -> tuple[tuple[GateDefinition, GateDisposition], ...]:
    """Return all G0-G9 gates; absence is never used as applicability."""

    dispositions = _APPLICABILITY[profile]
    return tuple(zip(GATE_DEFINITIONS, dispositions, strict=True))


def change_profiles() -> tuple[ChangeProfile, ...]:
    return tuple(profile.id for profile in CHANGE_PROFILE_DEFINITIONS)
