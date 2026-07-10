from dataclasses import dataclass

from t3_sandbox_gateway.backend import _bounded_log


@dataclass
class Message:
    text: str


def test_bounded_log_keeps_short_output() -> None:
    assert _bounded_log([Message("hello"), Message(" world")], 4096) == "hello world"


def test_bounded_log_keeps_head_and_tail() -> None:
    output = _bounded_log([Message("start-" + ("x" * 5000) + "-failure")], 4096)

    assert output.startswith("start-")
    assert "output bytes omitted" in output
    assert output.endswith("-failure")
    assert len(output.encode()) <= 4096
