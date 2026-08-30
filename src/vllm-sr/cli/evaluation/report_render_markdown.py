"""Render a complete, portable Markdown evaluation decision record."""

from __future__ import annotations

from collections.abc import Iterable

from cli.evaluation.reporting import EvaluationReport


def _cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def _number(value: float | None, *, signed: bool = False) -> str:
    if value is None:
        return "unavailable"
    return f"{value:+.6g}" if signed else f"{value:.6g}"


def _table(headers: tuple[str, ...], rows: Iterable[tuple[object, ...]]) -> list[str]:
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
    ]
    lines.extend(
        "| " + " | ".join(_cell(value) for value in row) + " |" for row in rows
    )
    return lines


def _summary(report: EvaluationReport) -> list[str]:
    coverage = report.summary.coverage
    return [
        "## Decision summary",
        "",
        *_table(
            ("Verdict", "Coverage", "Passed", "Failed", "Needs evidence"),
            (
                (
                    report.summary.verdict,
                    f"{coverage.evaluated}/{coverage.total} ({coverage.fraction:.1%})",
                    report.summary.passed_gates,
                    report.summary.failed_gates,
                    report.summary.unavailable_gates,
                ),
            ),
        ),
        "",
        "Promotion is decided only by required gates. An unavailable required gate withholds promotion; it is not a pass.",
    ]


def _tracks(report: EvaluationReport) -> list[str]:
    rows = (
        (
            track.track_id,
            track.status,
            track.evidence_level,
            f"{track.coverage.evaluated}/{track.coverage.total} ({track.coverage.fraction:.1%})",
            track.summary,
        )
        for track in report.tracks
    )
    return [
        "## Track evidence",
        "",
        *_table(("Track", "Status", "Evidence", "Coverage", "Summary"), rows),
    ]


def _metrics(report: EvaluationReport) -> list[str]:
    rows = []
    for metric in report.metrics:
        interval = (
            "unavailable"
            if metric.confidence_interval is None
            else f"[{metric.confidence_interval[0]:.6g}, {metric.confidence_interval[1]:.6g}]"
        )
        comparison = "unavailable"
        if metric.baseline_value is not None:
            comparison = (
                f"{metric.baseline_value:.6g} / {_number(metric.delta, signed=True)}"
            )
        rows.append(
            (
                metric.id,
                metric.name,
                metric.track_id or "-",
                _number(metric.value),
                interval,
                comparison,
                metric.unit,
                metric.sample_count or 0,
            )
        )
    return [
        "## Metrics",
        "",
        *_table(
            (
                "ID",
                "Metric",
                "Track",
                "Value",
                "95% CI",
                "Baseline / delta",
                "Unit",
                "N",
            ),
            rows,
        ),
    ]


def _gates(report: EvaluationReport) -> list[str]:
    rows = []
    for gate in report.gates:
        coverage = "unavailable"
        if gate.coverage is not None:
            coverage = (
                f"{gate.coverage.evaluated}/{gate.coverage.total} "
                f"({gate.coverage.fraction:.1%}); N={gate.sample_count or 0}"
            )
        threshold = "unavailable"
        if gate.threshold is not None:
            threshold = f"{gate.threshold.operator} {gate.threshold.value:.6g}" + (
                f" {gate.threshold.unit}" if gate.threshold.unit else ""
            )
        rows.append(
            (
                f"{gate.id} {gate.name}",
                f"{gate.disposition} / {gate.verdict}",
                gate.evidence_level or "-",
                _number(gate.observed),
                threshold,
                coverage,
                gate.owner or "-",
                gate.rationale or "",
            )
        )
    return [
        "## Release gates",
        "",
        *_table(
            (
                "Gate",
                "Disposition / verdict",
                "Evidence",
                "Observed",
                "Threshold",
                "Coverage",
                "Owner",
                "Rationale",
            ),
            rows,
        ),
    ]


def _costs(report: EvaluationReport) -> list[str]:
    rows = (
        (
            name,
            _number(ledger.amount),
            (ledger.input_tokens or 0) + (ledger.output_tokens or 0),
            _number(ledger.gpu_seconds),
            _number(ledger.energy_kwh),
        )
        for name, ledger in (
            ("runtime", report.costs.runtime),
            ("evaluation overhead", report.costs.evaluation_overhead),
            ("capacity TCO", report.costs.capacity_tco),
        )
    )
    return [
        "## Cost ledgers",
        "",
        *_table(("Ledger", "USD", "Tokens", "GPU seconds", "Energy (kWh)"), rows),
        "",
        "The three ledgers are intentionally separate; evaluation overhead and reserved capacity are not silently charged to runtime policy utility.",
    ]


def _provenance(report: EvaluationReport) -> list[str]:
    provenance = report.provenance
    lines = [
        "## Evidence lineage",
        "",
        f"- Generated: `{provenance.generated_at.isoformat()}`",
        f"- Code revision: `{provenance.code_revision or 'unavailable'}`",
        f"- Workload snapshot: `{provenance.workload_snapshot_digest or 'unavailable'}`",
        f"- Policy snapshot: `{provenance.policy_snapshot_digest or 'unavailable'}`",
        f"- Binding snapshot: `{provenance.binding_snapshot_digest or 'unavailable'}`",
        f"- Pool snapshot: `{provenance.pool_snapshot_digest or 'unavailable'}`",
        f"- Environment snapshot: `{provenance.environment_snapshot_digest or 'unavailable'}`",
        f"- Target: `{provenance.target_id or 'unavailable'}`",
        f"- Seed: `{provenance.seed}`",
        f"- Redaction policy: `{provenance.redaction_policy or 'unavailable'}`",
        "- Benchmark revisions:",
    ]
    if provenance.benchmark_revisions:
        lines.extend(
            f"  - `{suite_id}`: `{revision}`"
            for suite_id, revision in sorted(provenance.benchmark_revisions.items())
        )
    else:
        lines.append("  - unavailable")
    lines.extend(("", "## Public artifacts", ""))
    lines.extend(
        f"- `{artifact.name}` — `{artifact.digest or 'unavailable'}` ({artifact.media_type})"
        for artifact in report.artifacts
    )
    return lines


def render_markdown(report: EvaluationReport) -> str:
    """Render every decision-relevant public report field without private evidence."""

    gate_contract = report.gates[0].contract_version if report.gates else "unavailable"
    lines = [
        f"# Evaluation report: {report.run.name}",
        "",
        f"- Run: `{report.run.id}`",
        f"- Status: `{report.run.status}`",
        f"- Mode / evidence: `{report.run.mode}` / `{report.run.evidence_level}`",
        f"- Change profile: `{report.run.change_profile}`",
        f"- Target: `{report.run.target_id}`",
        f"- Gate contract: `{gate_contract}`",
        *(
            [
                "- E0 boundary: normalized imports may be parser-verified, but without "
                "a server-owned upstream native-run receipt they cannot qualify a release gate."
            ]
            if report.run.evidence_level == "E0"
            else []
        ),
        "",
    ]
    for section in (
        _summary(report),
        _tracks(report),
        _metrics(report),
        _gates(report),
        _costs(report),
        [
            "## Architecture actions",
            "",
            *(f"- {recommendation}" for recommendation in report.recommendations),
        ],
        _provenance(report),
    ):
        lines.extend(section)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
