"""Content-addressed import payloads, with separate transport and materialization limits."""

from __future__ import annotations

import base64
import hashlib

from .source import BenchmarkError

MAX_UNIQUE_BYTES = 64 * 1024 * 1024
MAX_MATERIALIZED_BYTES = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 100_000


class Payload:
    def __init__(self):
        self.blobs: dict[str, str] = {}
        self.unique_bytes = 0
        self.materialized_bytes = 0
        self.entries = 0

    def add(self, path: str, content: bytes, executable: bool = False) -> dict:
        self.materialized_bytes += len(content)
        self.entries += 1
        if self.materialized_bytes > MAX_MATERIALIZED_BYTES or self.entries > MAX_ENTRIES:
            raise BenchmarkError("native payload exceeds 4 GiB or 100000 files", path)
        identity = "sha256:" + hashlib.sha256(content).hexdigest()
        if identity not in self.blobs:
            self.unique_bytes += len(content)
            if self.unique_bytes > MAX_UNIQUE_BYTES:
                raise BenchmarkError("unique payload content exceeds 64 MiB", path)
            self.blobs[identity] = base64.b64encode(content).decode("ascii")
        return {"path": path, "digest": identity, "size": len(content), "executable": executable}

    def text(self, path: str, content: str) -> dict:
        return self.add(path, content.encode("utf-8"))


def content_bytes(file: dict, blobs: dict[str, str]) -> bytes:
    try:
        encoded = blobs[file["digest"]]
        content = base64.b64decode(encoded, validate=True)
        if (
            len(content) != file["size"]
            or base64.b64encode(content).decode("ascii") != encoded
            or "sha256:" + hashlib.sha256(content).hexdigest() != file["digest"]
        ):
            raise ValueError("content changed")
        return content
    except (KeyError, TypeError, ValueError) as error:
        raise BenchmarkError(
            "frozen native resource digest or size mismatch", file.get("path")
        ) from error


def used_blobs(files: list[dict], blobs: dict[str, str]) -> dict[str, str]:
    """Exclude replaced source bytes from the executable payload identity."""
    return {identity: blobs[identity] for identity in sorted({file["digest"] for file in files})}
