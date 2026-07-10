#!/usr/bin/env python3
from __future__ import annotations

import os
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path


def healthy(
    url: str,
    stamp: Path,
    grace_seconds: int,
    *,
    now: Callable[[], float] = time.time,
    opener: Callable[..., object] = urllib.request.urlopen,
) -> tuple[bool, str]:
    try:
        response = opener(url, timeout=2)
        close = getattr(response, "close", None)
        if close is not None:
            close()
    except Exception as exc:  # noqa: BLE001 - health checks must handle transport failures
        try:
            age = max(0, int(now() - stamp.stat().st_mtime))
        except FileNotFoundError:
            return False, f"OpenSandbox health endpoint has not responded yet: {exc}"
        if age <= grace_seconds:
            return True, f"OpenSandbox API busy; last response was {age}s ago"
        return False, f"OpenSandbox API unresponsive for {age}s: {exc}"

    stamp.touch()
    return True, "OpenSandbox API responsive"


def main() -> int:
    grace_seconds = int(os.environ.get("T3_SANDBOX_HEALTH_GRACE_SECONDS", "600"))
    ok, message = healthy(
        os.environ.get("T3_SANDBOX_HEALTH_URL", "http://127.0.0.1:8080/health"),
        Path(os.environ.get("T3_SANDBOX_HEALTH_STAMP", "/tmp/opensandbox-health-ok")),
        grace_seconds,
    )
    if not ok:
        print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
