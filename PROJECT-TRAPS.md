# Project Traps

- Invoke sandbox tests as `uv run --project sandbox --extra test --frozen python -m pytest -q sandbox/tests` when reusing a moved checkout; an existing `sandbox/.venv/bin/pytest` can retain its old absolute Python shebang and otherwise run the system interpreter without `t3_sandbox_gateway` (`sandbox/.venv/bin/pytest`).
