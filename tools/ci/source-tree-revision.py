#!/usr/bin/env python3
"""Resolve an immutable identity for the exact Git worktree source."""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
from pathlib import Path

_DIGEST_DOMAIN = b"vllm-sr-source-tree-v1\0"


def _git(root: Path, *args: str, env: dict[str, str] | None = None) -> bytes:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        env=env,
        check=True,
        capture_output=True,
    ).stdout


def _repository_root() -> Path:
    output = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return Path(output.strip()).resolve()


def _is_clean(root: Path) -> bool:
    return not _git(root, "status", "--porcelain", "--untracked-files=all")


def _index_entries(root: Path) -> list[tuple[bytes, bytes, bytes]]:
    descriptor, index_name = tempfile.mkstemp(prefix="vllm-sr-source-index-")
    os.close(descriptor)
    os.unlink(index_name)
    index_path = Path(index_name)
    env = os.environ | {"GIT_INDEX_FILE": str(index_path)}
    try:
        _git(root, "read-tree", "HEAD", env=env)
        _git(root, "add", "-A", "--", ".", env=env)
        output = _git(root, "ls-files", "--stage", "-z", env=env)
    finally:
        index_path.unlink(missing_ok=True)

    entries: list[tuple[bytes, bytes, bytes]] = []
    for raw_entry in output.split(b"\0"):
        if not raw_entry:
            continue
        metadata, path = raw_entry.split(b"\t", 1)
        mode, object_id, stage = metadata.split(b" ")
        if stage != b"0":
            raise RuntimeError("source tree contains an unresolved index entry")
        entries.append((mode, object_id, path))
    return entries


def _hash_index(root: Path, entries: list[tuple[bytes, bytes, bytes]]) -> str:
    digest = hashlib.sha256(_DIGEST_DOMAIN)
    batch = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    assert batch.stdin is not None and batch.stdout is not None
    try:
        for mode, object_id, path in entries:
            batch.stdin.write(object_id + b"\n")
            batch.stdin.flush()
            header = batch.stdout.readline().rstrip(b"\n")
            resolved_id, object_type, raw_size = header.split(b" ")
            if resolved_id != object_id:
                raise RuntimeError(
                    "Git object identity changed while hashing source tree"
                )
            size = int(raw_size)
            content = batch.stdout.read(size)
            if len(content) != size or batch.stdout.read(1) != b"\n":
                raise RuntimeError("Git returned an incomplete source object")
            digest.update(len(path).to_bytes(8, "big"))
            digest.update(path)
            digest.update(b"\0" + mode + b"\0" + object_type + b"\0")
            digest.update(size.to_bytes(8, "big"))
            digest.update(content)
    finally:
        batch.stdin.close()
        return_code = batch.wait()
        if return_code != 0:
            raise RuntimeError(f"git cat-file exited with status {return_code}")
    return f"sha256:{digest.hexdigest()}"


def source_revision(root: Path) -> str:
    if _is_clean(root):
        return _git(root, "rev-parse", "HEAD").decode().strip()
    return _hash_index(root, _index_entries(root))


def main() -> None:
    print(source_revision(_repository_root()))


if __name__ == "__main__":
    main()
