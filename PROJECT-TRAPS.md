# Project Traps

- Do not let `provision-agent-rack-config.mjs` replace a deployed canonical
  `allowedWorkspaces` list with its `/workspace` fallback. The provisioner runs
  at every T3 start, so an omitted environment value used to block Mac SMB
  audit repos despite a correct mounted policy file. Preserve a valid existing
  list unless `T3_AGENT_RACK_ALLOWED_WORKSPACES` explicitly supplies an
  override (`scripts/provision-agent-rack-config.mjs`).

- Invoke sandbox tests as `uv run --project sandbox --extra test --frozen python -m pytest -q sandbox/tests` when reusing a moved checkout; an existing `sandbox/.venv/bin/pytest` can retain its old absolute Python shebang and otherwise run the system interpreter without `t3_sandbox_gateway` (`sandbox/.venv/bin/pytest`). Run Ruff with the CI's explicit `--config sandbox/pyproject.toml` as well: root-level config discovery classifies first-party test imports differently and can pass locally before CI rejects the same import block.
- Do not emulate Electron browser trust with a user-agent, mode flag, or retained 24-hour desktop bootstrap token: official headless T3 always requires a session, while Electron receives a privileged bootstrap grant out of band. Use the short-lived container-local control-plane exchange in `scripts/auth-proxy.mjs`, preserve T3's normal browser cookie, and keep the revoked-session recovery test in `tests/auth-proxy.test.mjs`.
- Do not assume native harness MCP subprocesses inherit the parent T3 environment: Codex can sanitize custom variables before starting `t3-sandbox-mcp`, which closes the initialize handshake when URL or token is absent. The bridge must default to the internal gateway and read the mounted token file itself; MCP `structuredContent` must also remain a record, never a top-level array (`scripts/t3-sandbox-mcp.mjs`).
- Do not require a repository devcontainer base image to predeclare a non-root `USER`: common valid configs such as `debian:bookworm` remain root after feature installation. Create the fixed unprivileged `t3sandbox` runtime user in the gateway wrapper when neither image nor config selects a user, but continue rejecting an explicitly requested root user (`sandbox/src/t3_sandbox_gateway/devcontainer.py`).
- Do not collapse a failed devcontainer lifecycle hook into a bare exit code: package-manager/configuration errors then look like gateway outages and force agents to rediscover the cause. Return bounded stderr/stdout with the authenticated creation error while still destroying the failed upstream sandbox (`sandbox/src/t3_sandbox_gateway/service.py`).
- Do not require the fixed sandbox UID to own Git metadata on a group-writable network share, and do not set `safe.directory=*`. NFS/SMB can preserve a different `.git` owner while the worktree remains intentionally writable through its supplemental group. Inject command-scope Git config for exactly the gateway-authorized workspace in `SandboxService._environment` (`sandbox/src/t3_sandbox_gateway/service.py`).
- Do not use Node's built-in `fetch` for synchronous devcontainer creation: Undici applies a roughly five-minute response-header timeout independently of the MCP tool timeout, so a valid cold build finishes after the client has already reported `fetch failed` and leaves the created worker behind. Use the native HTTP request path with the explicit sandbox-create timeout (`scripts/t3-sandbox-mcp.mjs`).
- Do not rely on agents to call `sandbox_renew` during long tasks: an otherwise healthy worker can reach its fixed creation TTL while a command is starting. Renew centrally before each validated execution for at least the configured idle lifetime and the command timeout plus safety margin; status/list calls must not keep unused workers alive (`sandbox/src/t3_sandbox_gateway/service.py`).
- Do not derive the T3 parent image version from a feature commit's SHA tag or a stale repository pin. Every image build must resolve `t3@latest` and reject explicit older versions; commit `7415ccb` reverted T3 from `0.0.31` to `0.0.28` and removed the persisted-Claude fallback, causing persisted `runtime_mode=auto` state to restart-loop (`Dockerfile`, `.github/workflows/container.yml`, `scripts/claude-launcher.sh`).
- Do not treat ASD-STE100 skill installation as enforcement: the mandatory global policy must load independently of skill discovery and sandbox settings, including in OpenCode's global `AGENTS.md` (`scripts/provision-ste100-policy.py`, `agent-assets/policies/asd-ste100-mandatory.md`).
- Do not expect Cursor to discover the global ASD-STE100 skill or rule files: inject the mandatory policy once through the ACP wrapper and combine it independently with the conditional sandbox policy (`scripts/cursor-sandbox-wrapper.mjs`).
- Do not provision only the interactive T3 home: the autonomous issue worker mirrors config into a separate home and must install its policy and skill after that mirror (`scripts/issue-worker-entrypoint.sh`).
- Do not update an ASD-STE100 vendor file without updating the pinned commit, complete file list, and every SHA-256 together; vendored upstream files must remain byte-identical and local behavior belongs in the overlay (`vendor/asd-ste100/LOCK.json`, `agent-assets/skills/asd-ste100/`).
- Do not derive ASD-STE100 assets only from the provisioner's repository layout. The image copies
  the script and `agent-assets` side by side under `/opt/t3-docker`, so source discovery must support
  both layouts and a test must execute the flattened image layout (`scripts/provision-ste100-policy.py`).
- Do not start the managed OpenCode server with a bare `opencode` command. Use
   `T3_OPENCODE_BINARY_PATH` so an immutable deployment can select the image binary and cannot be
   shadowed by a stale persistent npm installation (`scripts/entrypoint.sh`).
- Do not classify `GitVcsDriver.fetchRemoteForStatus` errors in the main T3 log as sandbox command failures. T3 polls every registered `/workspace` repository independently, and network-backed Git metadata or an invalid `refs/stash` can make the background fetch fail. Check `.git/locks` older than 1 day, `git fsck --no-dangling`, and `git cat-file -e refs/stash SHA` before assuming network or auth failure. The fix is in `cleanup_stale_git_locks()` (`scripts/entrypoint.sh`, commit `a9af947`).
- Do not edit byte-exact vendored skill files to satisfy whitespace checks. Add a path-scoped `-whitespace` attribute, and keep the recorded upstream hashes unchanged (`.gitattributes`, `vendor/promo-video-script/LOCK.json`).
- Do not assume agent-rack's two home boundaries behave alike in the t3code container. Stock
  `agent-rack install --target codex` resolves the config home via the codex CLI, so it honors
  `CODEX_HOME=/data/codex` (verified: registration lands in `$CODEX_HOME/config.toml`), while
  stock `agent-rack cp --target codex` ignores `CODEX_HOME` and writes `$HOME/.codex/skills`,
  and stock `agent-rack install --target opencode` always writes `$XDG_CONFIG_HOME/opencode/opencode.json`.
  Share one config file through the globally exported `AGENT_RACK_CONFIG` and copy claude's
  config copy inside `HOME=/data/claude-home`; never rely on default-path resolution across
  different harness HOMEs (`scripts/provision-agent-rack.sh`, `scripts/entrypoint.sh`).
- Do not let a provisioning script silently skip because a probe command always exits 0:
  `opencode mcp list` exits 0 even with zero servers, so registration probes must check output
  (`opencode mcp list | grep -q agent-rack`), not the exit code, while `codex mcp get agent-rack`
  and `claude mcp get agent-rack` do exit nonzero when the server is missing
  (`scripts/provision-agent-rack.sh`).
- Do not give a coding sandbox a GitHub login or tell an agent to use the control-container shell
  for GitHub work. Sandboxes deliberately lack credentials; use the bounded `t3-github` MCP for
  user-authorized current-branch pushes and Actions inspection/watch/logs, so the token stays in
  the control container and agents have one explicit route (`scripts/t3-github-mcp.mjs`,
  `scripts/t3-sandbox-instructions.md`). A successful `gh auth status` alone does not configure
  Git HTTPS: the control-container startup must run `gh auth setup-git`, and the bounded MCP push
  must terminate its child process after a fixed timeout (`scripts/entrypoint.sh`,
  `scripts/t3-github-mcp.mjs`).

- Do not send result-dependent work through stock `agent_session_create`: it is detached, cannot wake a completed parent turn, and `SessionManager.shutdown()` cancels its child processes on an OpenCode/agent-rack restart. Keep the parent inside `agent_run`/the version-gated `agent_run_parallel` join; provision the canonical patch before MCP registration and fail closed if it cannot apply (`scripts/provision-agent-rack.sh`, `scripts/entrypoint.sh`).

- Register the container Claude Onyx MCP with `HOME=/data/claude-home` and the literal header `Authorization: Bearer ${ONYX_TOKEN}`. Do not use the default T3 home or place the bearer value in the image or repository, because Claude stores user MCP settings under the active home (`stacks/t3code/post_deploy.yml`).

- Do not assume the provider config source contains the shared Onyx root rule. Reconcile `/config/onyx-context.md` into each enabled harness-native root at startup, while preserving existing unmarked content; otherwise stale Codex and Claude `AGENTS.md`/`CLAUDE.md` files can run without the mandatory Onyx workflow (`scripts/provision-harness-instructions.py`).

- Do not treat Mac-only Claude hook paths as portable container configuration. After provider sync, remove unavailable absolute `/Users/...` hook commands from the writable Claude settings copy; otherwise every CLI probe can report non-blocking SessionStart or SessionEnd errors even when MCP servers are healthy (`scripts/provision-harness-instructions.py`).

- Do not vendor the versioned agent-rack join patch into `docker-t3-code`. Infra owns that single source of truth and mounts it before production startup; the isolated image-only CI runtime probe has no policy volume and must set `T3_AGENT_RACK=0`, while Ansible post-deploy verifies the enabled production path (`.github/workflows/container.yml`, `stacks/t3code/pre_deploy.yml`).

- Do not preserve legacy native Claude tier routing beside the agent-rack root policy. A `CLAUDE.md`
  that still recommends `opus-critical-reviewer` and parallel Claude subagents can make Claude call
  its built-in `Agent` tool instead of the required fixed agent-rack profile, even when agent-rack is
  installed and its policy block is present. Strip both conflicting routing sections, quarantine
  the native agent definitions and legacy routing commands, and explicitly prohibit the built-in
  `Agent` tool in the reconciled policy (`scripts/provision-harness-instructions.py`,
  `~/.claude/CLAUDE.md`).

- Do not map T3-generated container worktrees to `/workspace/.t3`. `T3CODE_HOME=/data/t3`
  stores them below `/data/t3/worktrees`; `/workspace` is only the mounted developer repository
  root. Keep `/data/t3/worktrees` and `/Users/thomas/.t3/worktrees` in the universal agent-rack
  allowlist, but never allow either complete T3 state root because it also contains authentication
  and session state (`docker-compose.yml`, `README.md`, `scripts/provision-agent-rack-config.mjs`).

- Do not vendor or re-implement the agent-rack harness limits in the image. Infra owns
  `agent-rack-harness-limits.mjs` and mounts it beside the join patch; `provision-agent-rack.sh`
  runs it last, after `provision-harness-mcp.sh` rewrites the Codex and OpenCode MCP configs, so
  the 3-hour agent-rack timeout and the native-subagent deny rules are not overwritten
  (`scripts/provision-agent-rack.sh`, `scripts/entrypoint.sh`).

- Deploy all three Infra-owned agent-rack reliability assets before startup and retain write ownership only for the four patched installed JS files. The runtime patch must fail closed if assets or version anchors differ. Claude workers need `/data/claude-home`; Onyx requires explicit `ONYX_TOKEN` inheritance because stock environment sanitization removes it (`Dockerfile`, `scripts/provision-agent-rack.sh`, canonical `agent-rack-worker-capabilities.mjs`).
