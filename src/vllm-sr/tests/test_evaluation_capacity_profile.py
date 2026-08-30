from __future__ import annotations

import pytest
from cli.evaluation.capacity_profile import CapacityProfile, build_capacity_profile
from cli.evaluation.contracts import (
    CapacityLoadProtocol,
    CapacitySLO,
    default_capacity_load_protocol,
)
from cli.evaluation.evidence import ExecutionRecord
from pydantic import ValidationError


def _slo(
    *,
    required_concurrency: int = 2,
    max_error_rate: float = 0.01,
) -> CapacitySLO:
    return CapacitySLO(
        required_concurrency=required_concurrency,
        max_latency_p95_ms=100,
        max_error_rate=max_error_rate,
        min_throughput_rps=10,
        min_throughput_scaling_efficiency=0.8,
    )


def _row(
    *,
    concurrency: int,
    phase: str,
    repetition: int,
    index: int,
    requests: int,
    throughput: float,
    success: bool = True,
    latency: float = 50,
    runtime_cost: float = 0,
) -> ExecutionRecord:
    attempt = f"capacity-c{concurrency}-{phase[0]}{repetition}-q{index}"
    return ExecutionRecord(
        id=attempt,
        track_id="capacity",
        case_id="case-1",
        attempt_id=attempt,
        status="succeeded" if success else "failed",
        success=success,
        concurrency=concurrency,
        latency_ms=latency,
        throughput_rps=throughput,
        load_elapsed_seconds=requests / throughput,
        load_phase=phase,  # type: ignore[arg-type]
        load_repetition=repetition,
        load_request_index=index,
        runtime_cost=runtime_cost,
        evidence_kind="capacity.closed-loop.v1",
    )


def _records(
    protocol: CapacityLoadProtocol,
    *,
    throughputs: dict[int, tuple[float, ...]] | None = None,
    failed_measurements: set[tuple[int, int, int]] = frozenset(),
    costs: tuple[float, ...] = (),
) -> list[ExecutionRecord]:
    rows: list[ExecutionRecord] = []
    cost_index = 0
    for concurrency in protocol.concurrency_levels:
        warmup_count = concurrency * protocol.warmup_request_multiplier
        for index in range(warmup_count):
            rows.append(
                _row(
                    concurrency=concurrency,
                    phase="warmup",
                    repetition=0,
                    index=index,
                    requests=warmup_count,
                    throughput=float(concurrency * 10),
                )
            )
        values = (
            throughputs[concurrency]
            if throughputs is not None
            else tuple(
                float(concurrency * 10) for _ in range(protocol.repetitions_per_level)
            )
        )
        for repetition, throughput in enumerate(values, 1):
            count = protocol.measurement_requests_per_repetition
            for index in range(count):
                cost = costs[cost_index] if cost_index < len(costs) else 0
                cost_index += 1
                rows.append(
                    _row(
                        concurrency=concurrency,
                        phase="measurement",
                        repetition=repetition,
                        index=index,
                        requests=count,
                        throughput=throughput,
                        success=(concurrency, repetition, index)
                        not in failed_measurements,
                        runtime_cost=cost,
                    )
                )
    return rows


def test_capacity_profile_qualifies_a_repeated_stable_slo_envelope() -> None:
    protocol = default_capacity_load_protocol(2)
    profile = build_capacity_profile(_records(protocol), _slo(), protocol)

    assert profile.assessment.verdict == "pass"
    assert profile.assessment.qualified_concurrency == 2
    assert profile.assessment.slo_headroom == 0
    assert profile.assessment.failure_reasons == ()
    assert profile.levels[1].measurement_requests == 300
    assert profile.levels[1].error_rate_upper_bound < 0.01
    assert profile.levels[1].throughput_scaling_efficiency == pytest.approx(1)
    assert all(level.qualified for level in profile.levels)


def test_capacity_profile_fails_at_the_scaling_saturation_boundary() -> None:
    protocol = default_capacity_load_protocol(2)
    profile = build_capacity_profile(
        _records(protocol, throughputs={1: (10, 10, 10), 2: (12, 12, 12)}),
        _slo(),
        protocol,
    )

    assert profile.assessment.verdict == "fail"
    assert profile.assessment.qualified_concurrency == 1
    assert profile.assessment.saturation_concurrency == 2
    assert profile.assessment.failure_reasons == ("throughput_scaling",)


def test_capacity_profile_uses_one_sided_error_bound_not_point_rate() -> None:
    protocol = default_capacity_load_protocol(2)
    profile = build_capacity_profile(
        _records(protocol, failed_measurements={(2, 1, 0)}),
        _slo(max_error_rate=0.01),
        protocol,
    )

    target = profile.levels[1]
    assert target.error_rate < 0.01
    assert target.error_rate_upper_bound > 0.01
    assert target.error_slo_passed is False
    assert profile.assessment.failure_reasons == ("error_rate_upper_bound",)


def test_capacity_profile_rejects_unstable_repetitions() -> None:
    protocol = default_capacity_load_protocol(2)
    profile = build_capacity_profile(
        _records(protocol, throughputs={1: (10, 10, 10), 2: (10, 20, 10)}),
        _slo(),
        protocol,
    )

    assert profile.levels[1].throughput_cv > protocol.max_throughput_cv
    assert profile.levels[1].throughput_stability_passed is False
    assert "throughput_stability" in profile.assessment.failure_reasons


def test_capacity_protocol_rejects_a_tiny_measurement_window() -> None:
    with pytest.raises(ValidationError, match="greater than or equal to 100"):
        CapacityLoadProtocol(
            concurrency_levels=(1, 2),
            warmup_request_multiplier=2,
            measurement_requests_per_repetition=2,
            repetitions_per_level=3,
            confidence_level=0.95,
            max_throughput_cv=0.2,
            max_latency_p95_cv=0.2,
        )


@pytest.mark.parametrize(
    ("path", "value", "message"),
    (
        (("assessment", "slo_headroom"), 9, "assessment does not match"),
        (("levels", 1, "qualified"), False, "decisions do not match"),
        (("levels", 1, "error_rate_upper_bound"), 0.0, "statistics do not match"),
        (("levels", 1, "repetitions", 1, "requests"), 99, "counts do not sum"),
    ),
)
def test_capacity_profile_rejects_tampered_derived_evidence(
    path: tuple[str | int, ...], value: object, message: str
) -> None:
    protocol = default_capacity_load_protocol(2)
    document = build_capacity_profile(_records(protocol), _slo(), protocol).model_dump(
        mode="json", exclude_none=False
    )
    target: object = document
    for key in path[:-1]:
        target = target[key]  # type: ignore[index]
    target[path[-1]] = value  # type: ignore[index]

    with pytest.raises(ValidationError, match=message):
        CapacityProfile.model_validate(document)


def test_capacity_cost_uses_record_ordered_binary64_sum() -> None:
    protocol = default_capacity_load_protocol(2)
    costs = (1e16, 1.0, 1.0)
    expected = 0.0
    for value in costs:
        expected += value

    profile = build_capacity_profile(
        _records(protocol, costs=costs),
        _slo(required_concurrency=1),
        protocol,
    )

    assert profile.levels[0].runtime_cost_usd == expected
