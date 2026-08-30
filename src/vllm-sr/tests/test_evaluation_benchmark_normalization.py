from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest
from benchmark_normalization_fixtures import BUILDERS, write_native_fixture
from cli.commands.eval import eval
from cli.evaluation.benchmark_normalization import normalize_benchmark_suite
from cli.evaluation.benchmark_normalization_io import NormalizationError
from cli.evaluation.benchmark_normalization_registry import (
    get_benchmark_normalizer,
    get_benchmark_normalizers,
)
from cli.evaluation.benchmark_registry import get_benchmark_adapter
from cli.evaluation.builtin_executors import DEFAULT_EXECUTOR_REGISTRY
from cli.evaluation.executor_contracts import BUILTIN_NORMALIZED_SUITE_EXECUTORS
from cli.evaluation.normalized_suite_executor import execute_normalized_suites
from cli.evaluation.suite_catalog import NormalizedSuiteCatalog
from cli.evaluation.suite_contract import BenchmarkSourceReceipt
from cli.evaluation.suite_store import NormalizedSuiteStore
from click.testing import CliRunner

EXECUTABLE_ADAPTERS = tuple(sorted(BUILDERS))
BLOCKED_ADAPTERS = ("routejudge-orbit", "routereval")


def _receipt(adapter_id: str) -> BenchmarkSourceReceipt:
    descriptor = get_benchmark_adapter(adapter_id)
    has_dataset = descriptor.dataset_revision is not None
    return BenchmarkSourceReceipt(
        adapter_id=adapter_id,
        expected_source_revision=descriptor.source_revision,
        observed_source_revision=descriptor.source_revision,
        expected_dataset_revision=descriptor.dataset_revision,
        observed_dataset_revision=descriptor.dataset_revision,
        source_clean=True,
        dataset_clean=True if has_dataset else None,
        verified=True,
    )


def _patch_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "cli.evaluation.benchmark_normalization.require_verified_benchmark_source",
        lambda descriptor, _root: _receipt(descriptor.id),
    )
    monkeypatch.setattr(
        "cli.evaluation.suite_store_install.require_verified_benchmark_source",
        lambda descriptor, _root: _receipt(descriptor.id),
    )


def test_normalizer_inventory_is_explicit_for_all_thirteen_adapters() -> None:
    descriptors = get_benchmark_normalizers()
    assert len(descriptors) == 13
    assert len({item.adapter_id for item in descriptors}) == 13
    assert {item.adapter_id for item in descriptors if item.executable} == set(BUILDERS)
    assert {item.adapter_id for item in descriptors if not item.executable} == set(
        BLOCKED_ADAPTERS
    )
    for descriptor in descriptors:
        if descriptor.executable:
            assert descriptor.required_artifacts
            assert descriptor.native_metric_mappings
            assert descriptor.blocker is None
        else:
            assert descriptor.blocker
            assert not descriptor.track_ids
            assert not descriptor.required_artifacts


@pytest.mark.parametrize("adapter_id", EXECUTABLE_ADAPTERS)
def test_every_executable_adapter_normalizes_installs_and_executes(
    adapter_id: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    export_root = tmp_path / "native"
    source_root = tmp_path / "sources"
    output_root = tmp_path / "normalized"
    source_root.mkdir()
    write_native_fixture(adapter_id, export_root)

    result = normalize_benchmark_suite(
        adapter_id=adapter_id,
        source_root=source_root,
        export_root=export_root,
        output_root=output_root,
        suite_id=f"{adapter_id}-fixture",
    )

    assert result.request.adapter_id == adapter_id
    assert result.request.track_ids == get_benchmark_normalizer(adapter_id).track_ids
    assert result.request.normalization_origin == "registered_parser_import"
    assert result.request_path.is_file()
    assert result.bundle_path.is_dir()
    if stat.S_IMODE(result.request_path.stat().st_mode) != 0o600:
        pytest.skip("temporary filesystem does not preserve POSIX private modes")
    assert json.loads(result.request_path.read_text(encoding="utf-8"))["id"] == (
        f"{adapter_id}-fixture"
    )

    store = NormalizedSuiteStore(tmp_path / "suite-store")
    manifest = store.install(
        result.request,
        result.bundle_path,
        source_root=source_root,
        native_export_root=export_root,
    )
    assert manifest.qualification_receipt.evidence_level == "E0"
    qualification = manifest.qualification_receipt.qualification
    assert qualification.status == "exploratory_import"
    assert qualification.origin == "registered_parser_import"
    assert qualification.parser_verified is True
    assert qualification.native_execution_attested is False
    assert qualification.promotion_eligible is False
    assert manifest.qualification_receipt.qualified_gate_ids == ()
    catalog = NormalizedSuiteCatalog(
        store,
        DEFAULT_EXECUTOR_REGISTRY,
        BUILTIN_NORMALIZED_SUITE_EXECUTORS,
    ).get(manifest.id)
    live_g4_methods = tuple(
        method
        for method in catalog.methods
        if method.id == "declared-shift.server-live.v1"
    )
    if manifest.artifacts.perturbations is not None and "routing" in manifest.track_ids:
        assert len(live_g4_methods) == 1
        assert live_g4_methods[0].qualified_gate_ids == ("G4",)
        assert live_g4_methods[0].evidence_source == "server_brokered_live"
    else:
        assert live_g4_methods == ()
    execution = execute_normalized_suites(
        store=store,
        manifests=(manifest,),
        track_ids=manifest.track_ids,
        sample_limit=10,
        seed=42,
        executor_id="normalized-suite-replay.v1",
        target_id="benchmark-source",
    )
    assert execution.records
    assert all(record.status != "unavailable" for record in execution.records)


def test_parser_verified_install_replays_and_binds_the_supplied_native_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    source_root = tmp_path / "sources"
    export_root = tmp_path / "native"
    source_root.mkdir()
    write_native_fixture("routerarena", export_root)
    result = normalize_benchmark_suite(
        adapter_id="routerarena",
        source_root=source_root,
        export_root=export_root,
        output_root=tmp_path / "normalized",
        suite_id="routerarena-origin-bound",
    )
    store = NormalizedSuiteStore(tmp_path / "suite-store")

    with pytest.raises(ValueError, match="frozen native export root"):
        store.install(
            result.request,
            result.bundle_path,
            source_root=source_root,
        )

    native_rows = json.loads(
        (export_root / "predictions.json").read_text(encoding="utf-8")
    )
    native_rows[0]["accuracy"] = 0 if native_rows[0]["accuracy"] else 1
    (export_root / "predictions.json").write_text(
        json.dumps(native_rows), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="exact registered normalizer output"):
        store.install(
            result.request,
            result.bundle_path,
            source_root=source_root,
            native_export_root=export_root,
        )


@pytest.mark.parametrize("adapter_id", BLOCKED_ADAPTERS)
def test_unsafe_upstream_artifacts_are_not_runnable(
    adapter_id: str,
    tmp_path: Path,
) -> None:
    descriptor = get_benchmark_normalizer(adapter_id)
    assert descriptor.executable is False
    with pytest.raises(NormalizationError, match="non-executable"):
        normalize_benchmark_suite(
            adapter_id=adapter_id,
            source_root=tmp_path,
            export_root=tmp_path,
            output_root=tmp_path / "output",
            suite_id="blocked-fixture",
        )


def test_native_schema_rejects_unknown_fields_and_partial_dense_matrix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    export_root = tmp_path / "native"
    write_native_fixture("routerarena", export_root)
    path = export_root / "predictions.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    rows[0]["guessed_metric"] = 1
    path.write_text(json.dumps(rows), encoding="utf-8")
    with pytest.raises(NormalizationError, match="unexpected guessed_metric"):
        normalize_benchmark_suite(
            adapter_id="routerarena",
            source_root=tmp_path,
            export_root=export_root,
            output_root=tmp_path / "output",
            suite_id="strict-fixture",
        )

    rows[0].pop("guessed_metric")
    path.write_text(json.dumps(rows[:1]), encoding="utf-8")
    with pytest.raises(NormalizationError, match="at least two models"):
        normalize_benchmark_suite(
            adapter_id="routerarena",
            source_root=tmp_path,
            export_root=export_root,
            output_root=tmp_path / "output",
            suite_id="strict-fixture",
        )


def test_native_reader_rejects_missing_symlinked_and_duplicate_key_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    export_root = tmp_path / "native"
    write_native_fixture("routerbench", export_root)
    (export_root / "models.json").unlink()
    with pytest.raises(NormalizationError, match="missing"):
        normalize_benchmark_suite(
            adapter_id="routerbench",
            source_root=tmp_path,
            export_root=export_root,
            output_root=tmp_path / "missing-output",
            suite_id="missing-fixture",
        )

    outside = tmp_path / "outside-models.json"
    outside.write_text('{"models":["model-a","model-b"]}', encoding="utf-8")
    (export_root / "models.json").symlink_to(outside)
    with pytest.raises(NormalizationError, match=r"outside|non-symlink"):
        normalize_benchmark_suite(
            adapter_id="routerbench",
            source_root=tmp_path,
            export_root=export_root,
            output_root=tmp_path / "symlink-output",
            suite_id="symlink-fixture",
        )

    duplicate_root = tmp_path / "duplicate"
    duplicate_root.mkdir()
    (duplicate_root / "predictions.json").write_text(
        '[{"global index":"case","prompt":"q","prediction":"a",'
        '"generated_result":{},"cost":0,"cost":1,"accuracy":1}]',
        encoding="utf-8",
    )
    with pytest.raises(NormalizationError, match="repeats key 'cost'"):
        normalize_benchmark_suite(
            adapter_id="routerarena",
            source_root=tmp_path,
            export_root=duplicate_root,
            output_root=tmp_path / "duplicate-output",
            suite_id="duplicate-fixture",
        )


def test_suite_normalize_cli_materializes_current_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    source_root = tmp_path / "sources"
    export_root = tmp_path / "native"
    output_root = tmp_path / "normalized"
    source_root.mkdir()
    write_native_fixture("routerarena", export_root)
    runner = CliRunner()
    result = runner.invoke(
        eval,
        [
            "suite-normalize",
            "--adapter",
            "routerarena",
            "--suite-id",
            "routerarena.cli.fixture",
            "--source-root",
            str(source_root),
            "--export-root",
            str(export_root),
            "--output",
            str(output_root),
        ],
    )
    assert result.exit_code == 0, result.output
    payload: dict[str, Any] = json.loads(result.output)
    assert payload["suite_id"] == "routerarena.cli.fixture"
    assert (output_root / "request.json").is_file()
    assert (output_root / "bundle/grading/outcomes.jsonl").is_file()
    install = runner.invoke(
        eval,
        [
            "suite-install",
            "--request",
            str(output_root / "request.json"),
            "--bundle",
            str(output_root / "bundle"),
            "--source-root",
            str(source_root),
            "--export-root",
            str(export_root),
            "--suite-store",
            str(tmp_path / "suite-store"),
        ],
    )
    assert install.exit_code == 0, install.output
    installed = json.loads(install.output)
    assert installed["qualification_receipt"]["evidence_level"] == "E0"
    assert installed["qualification_receipt"]["qualification"] == {
        "schema_version": "evaluation-suite-qualification.v2",
        "status": "exploratory_import",
        "origin": "registered_parser_import",
        "parser_verified": True,
        "native_execution_attested": False,
        "promotion_eligible": False,
    }


def test_normalizer_cli_runnable_surface_excludes_blocked_adapters() -> None:
    result = CliRunner().invoke(eval, ["normalizers", "--runnable-only"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    adapter_ids = {item["adapter_id"] for item in payload["normalizers"]}
    assert adapter_ids == set(BUILDERS)
    assert adapter_ids.isdisjoint(BLOCKED_ADAPTERS)


def test_normalization_output_is_immutable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_source(monkeypatch)
    export_root = tmp_path / "native"
    output_root = tmp_path / "normalized"
    write_native_fixture("routerarena", export_root)
    kwargs = {
        "adapter_id": "routerarena",
        "source_root": tmp_path,
        "export_root": export_root,
        "output_root": output_root,
        "suite_id": "immutable-fixture",
    }
    normalize_benchmark_suite(**kwargs)
    with pytest.raises(NormalizationError, match="immutable"):
        normalize_benchmark_suite(**kwargs)
