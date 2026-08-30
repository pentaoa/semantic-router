"""Path-safe local CAS and append-only run evidence store."""

from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import tempfile
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from cli.evaluation.canonical import (
    canonical_json_bytes,
    pretty_json_bytes,
    sha256_digest,
)
from cli.evaluation.constants import ARTIFACT_NAMES
from cli.evaluation.contracts import ArtifactRef, validate_canonical_uuid
from cli.evaluation.reporting import EvaluationRun

_PRIVATE_DIR_MODE = 0o700
_PRIVATE_FILE_MODE = 0o600


class StoreError(ValueError):
    """Evaluation artifact store rejected unsafe or corrupt data."""


class LocalArtifactStore:
    def __init__(self, root: str | Path, *, process_private: bool = False):
        expanded = Path(root).expanduser().absolute()
        if expanded.is_symlink():
            raise StoreError("artifact store root must not be a symlink")
        self.root = expanded.resolve()
        self._ensure_private_dir(self.root)
        object_root = self.root / "objects"
        self._ensure_private_dir(object_root)
        self.objects = self.root / "objects" / "sha256"
        self.runs = self.root / "runs"
        for directory in (self.objects, self.runs):
            self._ensure_private_dir(directory)
        self._process_private = process_private
        self._process_lock = threading.RLock()

    @classmethod
    def _ensure_private_dir(cls, path: Path) -> None:
        try:
            path.mkdir(parents=True, mode=_PRIVATE_DIR_MODE, exist_ok=True)
        except OSError as exc:
            raise StoreError(f"cannot create artifact store directory: {path}") from exc
        cls._reject_symlink(path)
        if not path.is_dir():
            raise StoreError(f"artifact store path is not a directory: {path}")
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode != _PRIVATE_DIR_MODE:
            raise StoreError(
                f"artifact store directory must have mode 0700, got {mode:04o}: {path}"
            )

    @staticmethod
    def _reject_symlink(path: Path) -> None:
        if path.is_symlink():
            raise StoreError(f"symlink is not allowed in artifact store: {path}")

    def _within_root(self, path: Path) -> Path:
        resolved = path.resolve(strict=False)
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise StoreError("artifact path escapes store root") from exc
        return path

    def _run_dir(self, run_id: str, *, create: bool = False) -> Path:
        try:
            validate_canonical_uuid(run_id)
        except ValueError as exc:
            raise StoreError("invalid run id") from exc

        path = self._within_root(self.runs / run_id)
        if create and not path.exists():
            path.mkdir(parents=False, mode=_PRIVATE_DIR_MODE, exist_ok=True)
        if path.exists():
            self._reject_symlink(path)
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode != _PRIVATE_DIR_MODE:
                raise StoreError(
                    f"run directory must have mode 0700, got {mode:04o}: {path}"
                )
        return path

    @staticmethod
    def _object_hex(digest: str) -> str:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise StoreError("invalid sha256 digest")
        return digest.removeprefix("sha256:")

    def _object_path(self, digest: str) -> Path:
        return self._within_root(self.objects / self._object_hex(digest))

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                if (
                    stat.S_IMODE(os.fstat(handle.fileno()).st_mode)
                    != _PRIVATE_FILE_MODE
                ):
                    raise StoreError(
                        "artifact temporary file was not created with mode 0600"
                    )
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(
                path.parent,
                os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextmanager
    def _exclusive_lock(self, path: Path, description: str) -> Iterator[None]:
        target = self._within_root(path)
        try:
            descriptor = os.open(
                target,
                os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
                _PRIVATE_FILE_MODE,
            )
        except OSError as exc:
            raise StoreError(f"{description} is unsafe") from exc
        locked = False
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise StoreError(f"{description} must be a regular file")
            if stat.S_IMODE(metadata.st_mode) != _PRIVATE_FILE_MODE:
                raise StoreError(f"{description} must have mode 0600")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            locked = True
            yield
        finally:
            if locked:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @contextmanager
    def _run_lock(self, run_id: str) -> Iterator[Path]:
        run_dir = self._run_dir(run_id, create=True)
        if self._process_private:
            with self._process_lock:
                yield run_dir
            return
        with self._exclusive_lock(run_dir / "artifacts.lock", "run artifact lock"):
            yield run_dir

    def put_bytes(self, data: bytes, media_type: str) -> ArtifactRef:
        digest = sha256_digest(data)
        target = self._object_path(digest)
        if target.exists():
            self._reject_symlink(target)
            if target.read_bytes() != data:
                raise StoreError(f"CAS object does not match digest {digest}")
        else:
            self._atomic_write(target, data)
        return ArtifactRef(digest=digest, media_type=media_type, size_bytes=len(data))

    def put_json(self, value: Any) -> ArtifactRef:
        return self.put_bytes(canonical_json_bytes(value), "application/json")

    def put_jsonl(self, values: Iterable[Any]) -> ArtifactRef:
        data = b"".join(canonical_json_bytes(value) + b"\n" for value in values)
        return self.put_bytes(data, "application/x-ndjson")

    def read_bytes(self, ref: ArtifactRef) -> bytes:
        path = self._object_path(ref.digest)
        if not path.exists():
            raise StoreError(f"missing CAS object {ref.digest}")
        self._reject_symlink(path)
        data = path.read_bytes()
        if len(data) != ref.size_bytes or sha256_digest(data) != ref.digest:
            raise StoreError(f"corrupt CAS object {ref.digest}")
        return data

    def read_json(self, ref: ArtifactRef) -> Any:
        return json.loads(self.read_bytes(ref))

    def write_run_bytes(self, run_id: str, name: str, data: bytes) -> ArtifactRef:
        if name not in ARTIFACT_NAMES:
            raise StoreError(f"unsupported run artifact name: {name}")
        with self._run_lock(run_id) as run_dir:
            target = self._within_root(run_dir / name)
            if target.exists() or target.is_symlink():
                self._reject_symlink(target)
            if target.exists() and name not in {"status.json", "events.jsonl"}:
                if target.read_bytes() != data:
                    raise StoreError(f"immutable run artifact already exists: {name}")
            else:
                self._atomic_write(target, data)
        media_type = (
            "application/x-ndjson" if name.endswith(".jsonl") else "application/json"
        )
        if name.endswith(".md"):
            media_type = "text/markdown"
        elif name.endswith(".html"):
            media_type = "text/html"
        elif name.endswith(".sha256"):
            media_type = "text/plain"
        return self.put_bytes(data, media_type)

    def write_run_json(self, run_id: str, name: str, value: Any) -> ArtifactRef:
        return self.write_run_bytes(run_id, name, pretty_json_bytes(value))

    def write_run_jsonl(
        self, run_id: str, name: str, values: Iterable[Any]
    ) -> ArtifactRef:
        data = b"".join(canonical_json_bytes(value) + b"\n" for value in values)
        return self.write_run_bytes(run_id, name, data)

    def append_event(self, run_id: str, value: Any) -> None:
        with self._run_lock(run_id) as run_dir:
            target = self._within_root(run_dir / "events.jsonl")
            if target.exists() or target.is_symlink():
                self._reject_symlink(target)
            data = canonical_json_bytes(value) + b"\n"
            descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
            )
            try:
                remaining = memoryview(data)
                while remaining:
                    written = os.write(descriptor, remaining)
                    if written <= 0:
                        raise StoreError("short write while appending evaluation event")
                    remaining = remaining[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def read_run_json(self, run_id: str, name: str) -> Any:
        return json.loads(self.read_run_bytes(run_id, name))

    def read_run_bytes(self, run_id: str, name: str) -> bytes:
        if name not in ARTIFACT_NAMES:
            raise StoreError(f"unsupported run artifact name: {name}")
        path = self._within_root(self._run_dir(run_id) / name)
        if not path.exists():
            raise StoreError(f"run artifact does not exist: {run_id}/{name}")
        self._reject_symlink(path)
        return path.read_bytes()

    def read_run_text(self, run_id: str, name: str) -> str:
        return self.read_run_bytes(run_id, name).decode("utf-8")

    def reference_run_artifact(self, run_id: str, name: str) -> ArtifactRef:
        """Import an already staged run file into CAS without rewriting it."""

        if name not in ARTIFACT_NAMES:
            raise StoreError(f"unsupported run artifact name: {name}")
        with self._run_lock(run_id) as run_dir:
            path = self._within_root(run_dir / name)
            if not path.exists():
                raise StoreError(f"run artifact does not exist: {run_id}/{name}")
            self._reject_symlink(path)
            data = path.read_bytes()
        media_type = "application/json"
        if name.endswith(".jsonl"):
            media_type = "application/x-ndjson"
        elif name.endswith(".md"):
            media_type = "text/markdown"
        elif name.endswith(".html"):
            media_type = "text/html"
        elif name.endswith(".sha256"):
            media_type = "text/plain"
        return self.put_bytes(data, media_type)

    def set_status(self, run_id: str, value: EvaluationRun) -> None:
        if not isinstance(value, EvaluationRun):
            raise TypeError("evaluation status must use the EvaluationRun contract")
        if value.id != run_id:
            raise StoreError("evaluation status identity must match its run directory")
        self.write_run_json(run_id, "status.json", value)
