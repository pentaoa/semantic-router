"""Platform-owned bounds and deterministic planning for live capacity evidence."""

from __future__ import annotations

CAPACITY_LOAD_KIND = "closed-loop"
CAPACITY_LOAD_CONFIDENCE_LEVEL = 0.95
MIN_CAPACITY_WARMUP_MULTIPLIER = 2
MAX_CAPACITY_WARMUP_MULTIPLIER = 4
MIN_CAPACITY_MEASUREMENT_REQUESTS = 100
MAX_CAPACITY_MEASUREMENT_REQUESTS = 500
MIN_CAPACITY_REPETITIONS = 3
MAX_CAPACITY_REPETITIONS = 5
MAX_CAPACITY_STABILITY_CV = 0.20
MIN_CAPACITY_CONCURRENCY = 2
MAX_CAPACITY_CONCURRENCY = 128


def capacity_concurrency_levels(maximum: int) -> tuple[int, ...]:
    """Return the one admitted geometric load ladder ending at ``maximum``."""

    if not MIN_CAPACITY_CONCURRENCY <= maximum <= MAX_CAPACITY_CONCURRENCY:
        raise ValueError("capacity maximum concurrency must be between 2 and 128")
    levels = [1]
    level = 2
    while level < maximum:
        levels.append(level)
        level *= 2
    levels.append(maximum)
    return tuple(levels)


def default_capacity_load_protocol_fields(maximum: int) -> dict[str, object]:
    """Build the platform default without importing the Pydantic contract."""

    return {
        "kind": CAPACITY_LOAD_KIND,
        "concurrency_levels": capacity_concurrency_levels(maximum),
        "warmup_request_multiplier": MIN_CAPACITY_WARMUP_MULTIPLIER,
        "measurement_requests_per_repetition": MIN_CAPACITY_MEASUREMENT_REQUESTS,
        "repetitions_per_level": MIN_CAPACITY_REPETITIONS,
        "confidence_level": CAPACITY_LOAD_CONFIDENCE_LEVEL,
        "max_throughput_cv": MAX_CAPACITY_STABILITY_CV,
        "max_latency_p95_cv": MAX_CAPACITY_STABILITY_CV,
    }


def capacity_request_budget(
    concurrency_levels: tuple[int, ...],
    warmup_request_multiplier: int,
    measurement_requests_per_repetition: int,
    repetitions_per_level: int,
) -> int:
    """Return the exact brokered chat-call count for a frozen protocol."""

    warmup = sum(level * warmup_request_multiplier for level in concurrency_levels)
    measured = (
        len(concurrency_levels)
        * measurement_requests_per_repetition
        * repetitions_per_level
    )
    return warmup + measured
