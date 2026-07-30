# Project Traps

- Invoke sandbox tests as `uv run --project sandbox --extra test --frozen python -m pytest -q sandbox/tests` when reusing a moved checkout; an existing `sandbox/.venv/bin/pytest` can retain its old absolute Python shebang and otherwise run the system interpreter without `t3_sandbox_gateway` (`sandbox/.venv/bin/pytest`).
- Do not emulate Electron browser trust with a user-agent, mode flag, or retained 24-hour desktop bootstrap token: official headless T3 always requires a session, while Electron receives a privileged bootstrap grant out of band. Use the short-lived container-local control-plane exchange in `scripts/auth-proxy.mjs`, preserve T3's normal browser cookie, and keep the revoked-session recovery test in `tests/auth-proxy.test.mjs`.
