"""Stable identifiers shared by evaluation contracts and adapters."""

from __future__ import annotations

SCHEMA_VERSION = "evaluation.v1"
ENGINE_VERSION = "1"

TRACK_IDS = (
    "routing",
    "model_pool",
    "joint",
    "agentic",
    "multimodal",
    "preference",
    "safety",
    "capacity",
)

BUILTIN_SUITE_IDS = (
    "evaluation-smoke",
    "live-mom-core",
    "live-agent-tasks",
    "live-fault-recovery",
    "live-multimodal",
    "live-hard-policy",
    "live-production-experiment",
    "live-capacity",
)

RUN_STATUSES = (
    "pending",
    "running",
    "sealing",
    "completed",
    "failed",
    "cancelled",
)

ARTIFACT_NAMES = frozenset(
    {
        "run-manifest.json",
        "status.json",
        "events.jsonl",
        "cases.jsonl",
        "grading-cases.jsonl",
        "records.jsonl",
        "metrics.json",
        "gates.json",
        "report.json",
        "report.md",
        "report.html",
        "lineage.json",
        "provenance.json",
        "failure-cases.jsonl",
        "failure-summary.json",
        "routing-traces.jsonl",
        "capacity-profile.json",
        "checksums.sha256",
        "private-checksums.sha256",
    }
)
