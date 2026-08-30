"""Render a complete, self-contained HTML evaluation decision record."""

from __future__ import annotations

from html import escape

from cli.evaluation.reporting import EvaluationReport


def _e(value: object | None) -> str:
    return escape("unavailable" if value is None else str(value), quote=True)


def _number(value: float | None, *, signed: bool = False) -> str:
    if value is None:
        return "unavailable"
    return f"{value:+.6g}" if signed else f"{value:.6g}"


def _table(caption: str, headers: tuple[str, ...], rows: list[str]) -> str:
    headings = "".join(f'<th scope="col">{_e(header)}</th>' for header in headers)
    return (
        '<div class="table-wrap"><table>'
        f'<caption class="sr-only">{_e(caption)}</caption>'
        f"<thead><tr>{headings}</tr></thead><tbody>{''.join(rows)}</tbody>"
        "</table></div>"
    )


def _summary(report: EvaluationReport) -> str:
    coverage = report.summary.coverage
    values = (
        (
            "Coverage",
            f"{coverage.evaluated}/{coverage.total}",
            f"{coverage.fraction:.1%}",
        ),
        ("Required gates passed", str(report.summary.passed_gates), "G0-G9"),
        ("Failed gates", str(report.summary.failed_gates), "decision blockers"),
        (
            "Needs evidence",
            str(report.summary.unavailable_gates),
            "unavailable is not pass",
        ),
    )
    cards = "".join(
        '<div class="stat">'
        f'<span class="label">{_e(label)}</span><strong>{_e(value)}</strong>'
        f"<small>{_e(detail)}</small></div>"
        for label, value, detail in values
    )
    return f'<section aria-labelledby="summary-title"><div class="stats">{cards}</div></section>'


def _tracks(report: EvaluationReport) -> str:
    rows = []
    for track in report.tracks:
        coverage = track.coverage
        rows.append(
            "<tr>"
            f'<th scope="row"><strong>{_e(track.track_id)}</strong></th>'
            f'<td><span class="badge {track.status}">{_e(track.status)}</span></td>'
            f"<td>{_e(track.evidence_level)}</td>"
            f"<td>{coverage.evaluated}/{coverage.total} ({coverage.fraction:.1%})</td>"
            f"<td>{_e(track.summary)}</td>"
            "</tr>"
        )
    return _table(
        "Track evidence and coverage",
        ("Track", "Status", "Evidence", "Coverage", "Summary"),
        rows,
    )


def _metrics(report: EvaluationReport) -> str:
    rows = []
    for metric in report.metrics:
        interval = (
            "unavailable"
            if metric.confidence_interval is None
            else (
                f"[{metric.confidence_interval[0]:.6g}, "
                f"{metric.confidence_interval[1]:.6g}]"
            )
        )
        comparison = "unavailable"
        if metric.baseline_value is not None:
            comparison = (
                f"{metric.baseline_value:.6g} / {_number(metric.delta, signed=True)}"
            )
        rows.append(
            "<tr>"
            f'<th scope="row"><strong>{_e(metric.name)}</strong><code>{_e(metric.id)}</code></th>'
            f"<td>{_e(metric.track_id)}</td>"
            f'<td class="numeric">{_e(_number(metric.value))}</td>'
            f'<td class="numeric">{_e(interval)}</td>'
            f'<td class="numeric">{_e(comparison)}</td>'
            f"<td>{_e(metric.unit)}</td>"
            f'<td class="numeric">{metric.sample_count or 0}</td>'
            "</tr>"
        )
    return _table(
        "Evaluation metrics with uncertainty and baseline deltas",
        ("Metric", "Track", "Value", "95% CI", "Baseline / delta", "Unit", "N"),
        rows,
    )


def _threshold(report_gate: object) -> str:
    threshold = getattr(report_gate, "threshold", None)
    if threshold is None:
        return "unavailable"
    unit = f" {threshold.unit}" if threshold.unit else ""
    return f"{threshold.operator} {threshold.value:.6g}{unit}"


def _gates(report: EvaluationReport) -> str:
    rows = []
    for gate in report.gates:
        coverage = "unavailable"
        if gate.coverage is not None:
            coverage = (
                f"{gate.coverage.evaluated}/{gate.coverage.total} "
                f"({gate.coverage.fraction:.1%}); N={gate.sample_count or 0}"
            )
        rows.append(
            "<tr>"
            f'<th scope="row"><strong>{_e(gate.id)} · {_e(gate.name)}</strong>'
            f"<small>{_e(gate.owner)}</small></th>"
            f'<td><span class="badge {gate.verdict}">{_e(gate.verdict)}</span>'
            f"<small>{_e(gate.disposition)}</small></td>"
            f"<td>{_e(gate.evidence_level)}</td>"
            f'<td class="numeric">{_e(_number(gate.observed))}</td>'
            f'<td class="numeric">{_e(_threshold(gate))}</td>'
            f"<td>{_e(coverage)}</td>"
            f'<td class="rationale">{_e(gate.rationale)}</td>'
            "</tr>"
        )
    return _table(
        "G0 through G9 release-gate decisions",
        (
            "Gate",
            "Verdict / disposition",
            "Evidence",
            "Observed",
            "Threshold",
            "Coverage",
            "Rationale",
        ),
        rows,
    )


def _costs(report: EvaluationReport) -> str:
    rows = []
    for name, ledger in (
        ("Runtime", report.costs.runtime),
        ("Evaluation overhead", report.costs.evaluation_overhead),
        ("Capacity TCO", report.costs.capacity_tco),
    ):
        rows.append(
            "<tr>"
            f'<th scope="row">{_e(name)}</th>'
            f'<td class="numeric">{_e(_number(ledger.amount))}</td>'
            f'<td class="numeric">{(ledger.input_tokens or 0) + (ledger.output_tokens or 0)}</td>'
            f'<td class="numeric">{_e(_number(ledger.gpu_seconds))}</td>'
            f'<td class="numeric">{_e(_number(ledger.energy_kwh))}</td>'
            "</tr>"
        )
    return _table(
        "Runtime, evaluation overhead, and capacity cost ledgers",
        ("Ledger", "USD", "Tokens", "GPU seconds", "Energy (kWh)"),
        rows,
    )


def _actions(report: EvaluationReport) -> str:
    items = "".join(f"<li>{_e(item)}</li>" for item in report.recommendations)
    return f'<ol class="actions">{items}</ol>'


def _lineage(report: EvaluationReport) -> str:
    provenance = report.provenance
    rows = (
        ("Generated", provenance.generated_at.isoformat()),
        ("Code", provenance.code_revision),
        ("Workload", provenance.workload_snapshot_digest),
        ("Policy", provenance.policy_snapshot_digest),
        ("Binding", provenance.binding_snapshot_digest),
        ("Pool", provenance.pool_snapshot_digest),
        ("Environment", provenance.environment_snapshot_digest),
        ("Target", provenance.target_id),
        ("Seed", provenance.seed),
        ("Redaction", provenance.redaction_policy),
    )
    definition_list = "".join(
        f"<div><dt>{_e(name)}</dt><dd><code>{_e(value)}</code></dd></div>"
        for name, value in rows
    )
    revisions = provenance.benchmark_revisions or {}
    revision_items = (
        "".join(
            f"<li><strong>{_e(name)}</strong><code>{_e(revision)}</code></li>"
            for name, revision in sorted(revisions.items())
        )
        or "<li>unavailable</li>"
    )
    return (
        f'<dl class="lineage">{definition_list}</dl>'
        "<h3>Benchmark revisions</h3>"
        f'<ul class="revision-list">{revision_items}</ul>'
    )


def _artifacts(report: EvaluationReport) -> str:
    rows = [
        "<tr>"
        f'<th scope="row"><code>{_e(artifact.name)}</code></th>'
        f"<td>{_e(artifact.kind)}</td>"
        f"<td>{_e(artifact.media_type)}</td>"
        f'<td class="numeric">{_e(artifact.size_bytes)}</td>'
        f"<td><code>{_e(artifact.digest)}</code></td>"
        "</tr>"
        for artifact in report.artifacts
    ]
    return _table(
        "Public, content-addressed evaluation artifacts",
        ("Artifact", "Kind", "Media type", "Bytes", "Digest"),
        rows,
    )


_STYLE = """
:root{color-scheme:dark;--bg:#09090a;--panel:#111113;--raised:#18181b;--line:#2a2a2f;
--line-strong:#3a3a42;--text:#f4f4f5;--muted:#a1a1aa;--quiet:#71717a;--accent:#ef3340;
--good:#49d17d;--warn:#f3ba4b;--bad:#ff6b72;font-family:Inter,ui-sans-serif,system-ui,
-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;
background:radial-gradient(circle at 80% -20%,#301117 0,transparent 28rem),var(--bg);color:var(--text);
font-size:14px;line-height:1.55}main{width:min(1440px,100%);margin:0 auto;padding:42px 28px 64px}
.hero{padding:28px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:14px;
background:linear-gradient(135deg,rgba(255,255,255,.035),transparent 55%),var(--panel)}
.eyebrow,.label{display:block;color:var(--quiet);font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,
monospace;letter-spacing:.11em;text-transform:uppercase}h1{margin:10px 0 8px;font-size:clamp(28px,4vw,46px);
line-height:1.04;letter-spacing:-.045em}h2{margin:0 0 14px;font-size:21px;letter-spacing:-.025em}
h3{margin:22px 0 10px;font-size:15px}.hero p{max-width:820px;margin:0;color:var(--muted)}
.hero-meta{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}.badge,.chip{display:inline-flex;align-items:center;
min-height:27px;padding:4px 9px;border:1px solid var(--line-strong);border-radius:999px;background:var(--raised);
color:var(--muted);font-size:11px;font-weight:750;text-transform:capitalize}.badge.pass,.badge.completed{border-color:#176f3b;
background:#0d2d1c;color:#75ef9f}.badge.fail,.badge.failed{border-color:#8d242d;background:#351216;color:#ff8e94}
.badge.unavailable{border-color:#785800;background:#2b2108;color:#ffd16c}.badge.not_applicable,.badge.skipped{
color:var(--quiet)}.section{margin-top:18px;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.section-copy{margin:-6px 0 16px;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
gap:1px;margin-top:18px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--line)}
.stat{display:grid;gap:7px;padding:17px;background:var(--panel)}.stat strong{font-size:25px;letter-spacing:-.035em}
.stat small,small{display:block;color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;min-width:780px;border-collapse:collapse;background:var(--panel)}th,td{padding:12px 13px;border-bottom:1px solid var(--line);
vertical-align:top;text-align:left}thead th{position:sticky;top:0;z-index:1;background:var(--raised);color:var(--quiet);
font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;text-transform:uppercase}
tbody tr:last-child>*{border-bottom:0}tbody tr:hover>*{background:rgba(255,255,255,.018)}tbody th{min-width:190px}
tbody th strong{display:block;margin-bottom:4px}code{display:block;max-width:460px;color:#c6c6cf;font:11px/1.5 ui-monospace,
SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}
.rationale{min-width:310px;color:var(--muted)}.actions{display:grid;gap:9px;margin:0;padding-left:22px}.actions li{padding:10px 12px;
border-left:2px solid var(--line-strong);background:rgba(255,255,255,.018);color:#d4d4d8}.lineage{display:grid;
grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;overflow:hidden;margin:0;border:1px solid var(--line);
border-radius:10px;background:var(--line)}.lineage div{padding:12px;background:var(--panel)}dt{color:var(--quiet);font-size:11px}
dd{margin:4px 0 0}.revision-list{display:grid;gap:7px;margin:0;padding:0;list-style:none}.revision-list li{display:grid;
grid-template-columns:minmax(130px,.3fr) 1fr;gap:12px;padding:9px 11px;border:1px solid var(--line);border-radius:8px}
.decision-note{margin:14px 0 0;padding:11px 13px;border:1px solid #675006;border-radius:9px;background:#211a08;
color:#f5ce70}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);
white-space:nowrap;border:0}@media(max-width:800px){main{padding:18px 12px 40px}.hero,.section{padding:17px}.stats{
grid-template-columns:repeat(2,minmax(0,1fr))}.lineage{grid-template-columns:1fr}}@media(max-width:480px){.stats{
grid-template-columns:1fr}.revision-list li{grid-template-columns:1fr}}@media print{:root{color-scheme:light;--bg:#fff;--panel:#fff;
--raised:#f5f5f6;--line:#d4d4d8;--line-strong:#a1a1aa;--text:#18181b;--muted:#52525b;--quiet:#71717a}
body{background:#fff}main{width:100%;padding:0}.hero,.section{break-inside:avoid;box-shadow:none}.table-wrap{overflow:visible}
table{min-width:0;font-size:10px}thead th{position:static}.badge{background:#fff!important;color:#18181b!important}}
"""


def render_html(report: EvaluationReport) -> str:
    """Render every decision-relevant public field as an accessible report."""

    gate_contract = report.gates[0].contract_version if report.gates else "unavailable"
    verdict = report.summary.verdict
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Evaluation · {_e(report.run.name)}</title><style>{_STYLE}</style>"
        '</head><body><main><header class="hero">'
        '<span class="eyebrow">vLLM Semantic Router · Evaluation decision record</span>'
        f"<h1>{_e(report.run.name)}</h1><p>{_e(report.run.description)}</p>"
        '<div class="hero-meta">'
        f'<span class="badge {verdict}">{_e(verdict)}</span>'
        f'<span class="chip">{_e(report.run.mode)}</span>'
        f'<span class="chip">{_e(report.run.evidence_level)} evidence</span>'
        f'<span class="chip">{_e(report.run.change_profile)}</span>'
        f'<span class="chip">{_e(gate_contract)}</span>'
        f'<span class="chip">run {_e(report.run.id)}</span></div>'
        '<p class="decision-note">Promotion is decided only by required gates. '
        "Missing evidence remains unavailable and never becomes a pass. A parser-verified "
        "normalized import still remains E0 until a server-owned receipt attests the upstream "
        "native benchmark run.</p></header>"
        f"{_summary(report)}"
        '<section class="section" aria-labelledby="tracks-title"><h2 id="tracks-title">Track evidence</h2>'
        '<p class="section-copy">Per-track strength uses the weakest qualified source and keeps missing cells in coverage.</p>'
        f"{_tracks(report)}</section>"
        '<section class="section" aria-labelledby="metrics-title"><h2 id="metrics-title">Metrics</h2>'
        '<p class="section-copy">Direction, uncertainty, sample count, and paired baselines stay attached to each measure.</p>'
        f"{_metrics(report)}</section>"
        '<section class="section" aria-labelledby="gates-title"><h2 id="gates-title">Release gates</h2>'
        '<p class="section-copy">Observed values and frozen thresholds expose the exact reason for every G0-G9 verdict.</p>'
        f"{_gates(report)}</section>"
        '<section class="section" aria-labelledby="costs-title"><h2 id="costs-title">Three cost ledgers</h2>'
        '<p class="section-copy">Runtime, evaluation overhead, and capacity TCO are intentionally not collapsed into one number.</p>'
        f"{_costs(report)}</section>"
        '<section class="section" aria-labelledby="actions-title"><h2 id="actions-title">Architecture actions</h2>'
        f"{_actions(report)}</section>"
        '<section class="section" aria-labelledby="lineage-title"><h2 id="lineage-title">Evidence lineage</h2>'
        f"{_lineage(report)}</section>"
        '<section class="section" aria-labelledby="artifacts-title"><h2 id="artifacts-title">Public artifacts</h2>'
        '<p class="section-copy">Private prompts, grading labels, credentials, and target addresses are not published here.</p>'
        f"{_artifacts(report)}</section></main></body></html>\n"
    )
