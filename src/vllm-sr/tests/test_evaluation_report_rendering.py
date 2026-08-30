from __future__ import annotations

from pathlib import Path

from cli.evaluation.report_render_html import render_html
from cli.evaluation.report_render_markdown import render_markdown
from cli.evaluation.reporting import EvaluationReport

_GOLDEN_REPORT = (
    Path(__file__).parents[1] / "cli" / "evaluation" / "golden" / "report.json"
)


def _report() -> EvaluationReport:
    return EvaluationReport.model_validate_json(_GOLDEN_REPORT.read_bytes())


def test_portable_reports_include_every_decision_surface() -> None:
    report = _report()

    markdown = render_markdown(report)
    html = render_html(report)

    for heading in (
        "Decision summary",
        "Track evidence",
        "Metrics",
        "Release gates",
        "Cost ledgers",
        "Architecture actions",
        "Evidence lineage",
        "Public artifacts",
    ):
        assert f"## {heading}" in markdown
    for heading in (
        "Track evidence",
        "Metrics",
        "Release gates",
        "Three cost ledgers",
        "Architecture actions",
        "Evidence lineage",
        "Public artifacts",
    ):
        assert f">{heading}</h2>" in html
    for gate_id in (f"G{index}" for index in range(10)):
        assert gate_id in markdown
        assert gate_id in html
    assert report.provenance.policy_snapshot_digest in markdown
    assert report.provenance.policy_snapshot_digest in html


def test_html_report_escapes_user_visible_run_fields() -> None:
    report = _report()
    hostile = '<script data-eval="x">alert(1)</script>'
    report = report.model_copy(
        update={
            "run": report.run.model_copy(
                update={"name": hostile, "description": hostile}
            )
        }
    )

    html = render_html(report)

    assert hostile not in html
    assert "&lt;script data-eval=&quot;x&quot;&gt;alert(1)&lt;/script&gt;" in html


def test_markdown_report_escapes_table_delimiters_and_newlines() -> None:
    report = _report()
    metric = report.metrics[0].model_copy(update={"name": "quality | routed\nnext"})
    report = report.model_copy(update={"metrics": (metric, *report.metrics[1:])})

    markdown = render_markdown(report)

    assert "quality \\| routed next" in markdown
