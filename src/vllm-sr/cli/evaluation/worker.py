"""Fixed process entry point used by the Dashboard evaluation backend."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cli.evaluation.canonical import canonical_json_bytes
from cli.evaluation.orchestrator import load_manifest, run_evaluation
from cli.evaluation.reporting import WorkerEvent
from cli.evaluation.store import LocalArtifactStore
from cli.evaluation.suite_store import NormalizedSuiteStore


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a fixed vLLM-SR evaluation manifest"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--suite-store", required=True, type=Path)
    parser.add_argument("--events-stdout", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)

    def emit(event: WorkerEvent) -> None:
        if not args.events_stdout:
            return
        sys.stdout.buffer.write(canonical_json_bytes(event) + b"\n")
        sys.stdout.buffer.flush()

    try:
        manifest = load_manifest(args.manifest)
        # Dashboard gives each worker a unique staging tree, so an in-process
        # lock is the only coordination boundary and no control file enters the
        # evidence bundle.
        store = LocalArtifactStore(args.store, process_private=True)
        suite_store = NormalizedSuiteStore.open_read_only(args.suite_store)
        run_evaluation(
            manifest,
            store,
            suite_store=suite_store,
            event_sink=emit,
            manage_control_state=False,
        )
    # The process boundary must turn every worker failure into a non-zero exit;
    # the Dashboard accepts only the fixed stdout protocol.
    except Exception as exc:
        print(f"evaluation worker failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
