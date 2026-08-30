"""Browser-safe projection of private normalized suite manifests."""

from __future__ import annotations

from collections.abc import Mapping

from cli.evaluation.benchmark_normalization_registry import (
    get_benchmark_normalizer,
)
from cli.evaluation.benchmark_registry import get_benchmark_adapter
from cli.evaluation.catalog import CatalogMethod, CatalogSuite
from cli.evaluation.executor_contracts import Mode
from cli.evaluation.executor_registry import ExecutorRegistry
from cli.evaluation.normalized_suite_live_robustness import (
    declared_shift_source_is_eligible,
)
from cli.evaluation.suite_contract import BenchmarkSuiteManifest
from cli.evaluation.suite_store import NormalizedSuiteStore


class NormalizedSuiteCatalog:
    """Project suite metadata through explicit executor capability contracts."""

    def __init__(
        self,
        store: NormalizedSuiteStore,
        executor_registry: ExecutorRegistry,
        executor_ids: Mapping[Mode, str],
    ):
        if set(executor_ids) != {"replay", "live"}:
            raise ValueError(
                "normalized suite catalog requires explicit replay and live executors"
            )
        contracts = {
            mode: executor_registry.contract(executor_ids[mode])
            for mode in ("replay", "live")
        }
        for mode, contract in contracts.items():
            if contract.mode != mode or not contract.normalized_suite:
                raise ValueError(
                    f"executor {contract.id} cannot project normalized {mode} suites"
                )
        self._store = store
        self._contracts = contracts

    def get(self, suite_id: str) -> CatalogSuite:
        return self._project(self._store.get_suite_manifest(suite_id))

    def list(self) -> tuple[CatalogSuite, ...]:
        return tuple(
            self._project(manifest) for manifest in self._store.list_suite_manifests()
        )

    def _project(self, manifest: BenchmarkSuiteManifest) -> CatalogSuite:
        descriptor = get_benchmark_adapter(manifest.adapter_id)
        normalizer = get_benchmark_normalizer(manifest.adapter_id)
        replay = self._contracts["replay"]
        live = self._contracts["live"]
        executors: dict[Mode, str] = {"replay": replay.id}
        supports_live = bool(set(manifest.track_ids).intersection(live.track_ids))
        import_evidence = manifest.qualification_receipt.qualification
        parser_label = (
            "Registered parser output was re-derived exactly"
            if import_evidence.parser_verified
            else "User-provided normalized records passed the closed schema"
        )
        if supports_live:
            executors["live"] = live.id
        return CatalogSuite(
            id=manifest.id,
            name=manifest.name,
            description=(
                f"Pinned, normalized {descriptor.name} exploratory workload. "
                f"{parser_label}; upstream benchmark execution is not attested. "
                "Replay is E0 diagnostic evidence only, and raw cases, labels, "
                "outcomes, and artifact references stay private."
            ),
            track_ids=manifest.track_ids,
            modes=tuple(executors),
            evidence_level=manifest.qualification_receipt.evidence_level,
            executors=executors,
            case_count=manifest.case_count,
            revision=manifest.revision,
            tags=(
                "external",
                "pinned",
                "exploratory-e0",
                "normalized-replay",
                (
                    "parser-verified"
                    if import_evidence.parser_verified
                    else "user-provided-import"
                ),
                "native-run-unattested",
                *(("target-live",) if supports_live else ()),
                f"adapter:{manifest.adapter_id}",
                f"classification:{manifest.data_classification}",
                f"redistribution:{manifest.redistribution}",
            ),
            methods=_installed_catalog_methods(
                self._store,
                manifest,
                normalizer.export_schema_id,
            ),
        )


def _installed_catalog_methods(
    store: NormalizedSuiteStore,
    manifest: BenchmarkSuiteManifest,
    export_schema_id: str,
) -> tuple[CatalogMethod, ...]:
    methods = [
        CatalogMethod(
            id=f"{export_schema_id}.{track_id}",
            track_id=track_id,
            qualified_gate_ids=(),
            evidence_source="normalized_import",
            status="configured",
        )
        for track_id in manifest.track_ids
    ]
    if declared_shift_source_is_eligible(store, manifest):
        methods.append(
            CatalogMethod(
                id="declared-shift.server-live.v1",
                track_id="routing",
                qualified_gate_ids=("G4",),
                evidence_source="server_brokered_live",
                status="configured",
            )
        )
    return tuple(methods)
