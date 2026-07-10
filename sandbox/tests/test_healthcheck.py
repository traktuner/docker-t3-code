from __future__ import annotations

import importlib.util
import os
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "opensandbox-healthcheck.py"
SPEC = importlib.util.spec_from_file_location("opensandbox_healthcheck", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    closed = False

    def close(self) -> None:
        self.closed = True


def failing_opener(*_args, **_kwargs):
    raise TimeoutError("busy")


def test_success_records_last_response(tmp_path: Path) -> None:
    stamp = tmp_path / "health-ok"
    response = Response()

    ok, _ = MODULE.healthy(
        "http://localhost/health",
        stamp,
        600,
        now=lambda: 1_000,
        opener=lambda *_args, **_kwargs: response,
    )

    assert ok
    assert stamp.is_file()
    assert response.closed


def test_recent_success_masks_expected_busy_period(tmp_path: Path) -> None:
    stamp = tmp_path / "health-ok"
    stamp.touch()
    os.utime(stamp, (900, 900))

    ok, message = MODULE.healthy(
        "http://localhost/health",
        stamp,
        600,
        now=lambda: 1_000,
        opener=failing_opener,
    )

    assert ok
    assert "last response was 100s ago" in message


def test_sustained_failure_becomes_unhealthy(tmp_path: Path) -> None:
    stamp = tmp_path / "health-ok"
    stamp.touch()
    os.utime(stamp, (100, 100))

    ok, message = MODULE.healthy(
        "http://localhost/health",
        stamp,
        600,
        now=lambda: 1_000,
        opener=failing_opener,
    )

    assert not ok
    assert "unresponsive for 900s" in message


def test_failure_before_first_success_is_unhealthy(tmp_path: Path) -> None:
    ok, message = MODULE.healthy(
        "http://localhost/health",
        tmp_path / "missing",
        600,
        opener=failing_opener,
    )

    assert not ok
    assert "has not responded yet" in message
