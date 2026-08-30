from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "source-tree-revision.py"
SPEC = importlib.util.spec_from_file_location("source_tree_revision", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

_SHA256_REVISION_LENGTH = len("sha256:") + 64


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    ).stdout.strip()


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "source"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.name", "Source Test")
    git(root, "config", "user.email", "source@example.com")
    (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (root / "tracked.txt").write_text("initial\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-qm", "initial")
    return root


def test_clean_tree_resolves_full_commit(tmp_path: Path) -> None:
    root = repository(tmp_path)
    assert MODULE.source_revision(root) == git(root, "rev-parse", "HEAD")


def test_dirty_tree_digest_is_stable_and_covers_source(tmp_path: Path) -> None:
    root = repository(tmp_path)
    (root / "tracked.txt").write_text("changed\n", encoding="utf-8")
    (root / "new.py").write_text("print('one')\n", encoding="utf-8")
    first = MODULE.source_revision(root)
    assert first.startswith("sha256:") and len(first) == _SHA256_REVISION_LENGTH
    assert MODULE.source_revision(root) == first

    (root / "ignored.txt").write_text("not source\n", encoding="utf-8")
    assert MODULE.source_revision(root) == first
    (root / "new.py").write_text("print('two')\n", encoding="utf-8")
    assert MODULE.source_revision(root) != first


def test_dirty_tree_digest_covers_executable_mode(tmp_path: Path) -> None:
    root = repository(tmp_path)
    script = root / "tool.sh"
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    before = MODULE.source_revision(root)
    os.chmod(script, 0o755)
    assert MODULE.source_revision(root) != before
