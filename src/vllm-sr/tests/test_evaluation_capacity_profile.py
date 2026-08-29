from __future__ import annotations

from cli.evaluation.capacity_profile import build_capacity_profile
from cli.evaluation.evidence import ExecutionRecord


def _capacity_record(index: int, runtime_cost: float) -> ExecutionRecord:
    return ExecutionRecord(
        id=f"capacity-{index}",
        track_id="capacity",
        case_id=f"case-{index}",
        attempt_id=f"attempt-{index}",
        status="succeeded",
        success=True,
        concurrency=1,
        runtime_cost=runtime_cost,
    )


def test_capacity_cost_uses_cross_runtime_ordered_binary64_sum() -> None:
    costs = (1e16, 1.0, 1.0)
    expected = 0.0
    for value in costs:
        expected += value

    profile = build_capacity_profile(
        [_capacity_record(index, value) for index, value in enumerate(costs)]
    )

    assert profile["levels"][0]["runtime_cost_usd"] == expected
