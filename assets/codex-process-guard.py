"""Own one sandbox process group until its controller's stdin closes."""

import errno
import json
import os
import select
import shutil
import signal
import subprocess
import sys
import time


def main() -> int:
    request = json.loads(sys.stdin.buffer.readline())
    child = subprocess.Popen(
        request["argv"],
        cwd=request["cwd"],
        env=request["env"],
        stdin=subprocess.PIPE,
        start_new_session=True,
    )

    def terminate(*_args: object) -> None:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # macOS can reject a process-group signal during group teardown.
                # Still terminate/reap our exact child before releasing its files.
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                except PermissionError:
                    child.wait(timeout=1)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)

    def controller_closed(timeout: float) -> bool:
        try:
            ready, _, _ = select.select([sys.stdin], [], [], timeout)
            return bool(ready and not os.read(0, 1))
        except OSError as error:
            # libuv may implement child stdin with a socketpair, which can reset
            # when the writer dies instead of returning an ordinary pipe EOF.
            if error.errno in (errno.ECONNRESET, errno.EPIPE, errno.EBADF):
                return True
            raise

    abandoned = False
    try:
        assert child.stdin is not None
        try:
            child.stdin.write(request["prompt"].encode())
            child.stdin.close()
        except BrokenPipeError:
            pass
        deadline = time.monotonic() + request["timeoutMs"] / 1000 + 5
        while child.poll() is None:
            abandoned = abandoned or controller_closed(0.1)
            if time.monotonic() >= deadline or abandoned:
                terminate()
        return child.wait()
    finally:
        terminate()
        child.wait()
        # The child may exit between the loop's poll and the controller EOF.
        abandoned = abandoned or controller_closed(0)
        if abandoned:
            shutil.rmtree(request["cleanupRoot"], ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
