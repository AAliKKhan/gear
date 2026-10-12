"""Read-only JSON gateway for a single sanitized Meta experience snapshot.

This I/O entrypoint is staged with frozen sources; retrieval policy stays in algorithms.
"""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path
from typing import Any

from gear.algorithms.experience import experience_query, experience_read
from gear.canonical import digest


def main() -> int:
    try:
        if len(sys.argv) not in (2, 3):
            raise ValueError("expected one frozen snapshot file; send query/read JSON on stdin")
        raw = Path(sys.argv[1]).read_bytes()
        if len(raw) > 12 * 1024 * 1024:
            raise ValueError("experience snapshot exceeds 12 MiB")
        snapshot = json.loads(raw)
        if (
            snapshot["version"] != 2
            or digest({key: value for key, value in snapshot.items() if key != "digest"})
            != snapshot["digest"]
        ):
            raise ValueError("experience snapshot identity mismatch")
        encoded = sys.stdin.buffer.read(65537)
        if len(encoded) > 65536:
            raise ValueError("experience request exceeds 64 KiB")
        request = json.loads(encoded)
        if not isinstance(request, dict) or set(request) - {
            "action",
            "query",
            "ref",
            "view",
            "limit",
            "cursor",
            "parent_id",
            "source_ref",
        }:
            raise ValueError("invalid experience request")
        action = request.pop("action", "query")
        if action == "trajectory":
            if len(sys.argv) != 3:
                raise ValueError("trajectory reader is unavailable for this operation")
            if set(request) - {"ref", "source_ref", "query"}:
                raise ValueError("invalid trajectory read parameters")
            gateway = json.loads(Path(sys.argv[2]).read_text())
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(40)
                connection.connect(gateway["socket"])
                envelope = {
                    "id": "experience",
                    "method": "trajectory.read",
                    "params": {**request, "token": gateway["token"]},
                }
                connection.sendall((json.dumps(envelope, separators=(",", ":")) + "\n").encode())
                reply = bytearray()
                while b"\n" not in reply:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise ValueError("trajectory reader disconnected")
                    reply.extend(chunk)
                    if len(reply) > 70 * 1024:
                        raise ValueError("trajectory reader exceeded its reply bound")
                response = json.loads(reply.split(b"\n", 1)[0])
                if "error" in response:
                    raise ValueError(response["error"]["code"])
                print(
                    json.dumps(
                        response["result"],
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                )
                return 0
        if action not in ("query", "read"):
            raise ValueError("expected query, read or trajectory")
        value: dict[str, Any] = {
            **request,
            "records": snapshot["records"],
            "snapshot_digest": snapshot["digest"],
        }
        result = (experience_query if action == "query" else experience_read)(value)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        return 0
    except (KeyError, TypeError, ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
