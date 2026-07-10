# Dockerized T3 Code

This container runs the current `t3` web/headless server. All T3 Code upstream provider CLIs are baked into the image: Codex, Claude Code, Cursor Agent, Grok Build, OpenCode, and a bootstrap T3 CLI. The image also includes common agentic-coding tools such as `git`, `gh`, `ssh`, `rg`, `fd`, `jq`, `yq`, `uv`, `bun`, `pnpm`, `yarn`, `prettier`, `typescript`, `shellcheck`, `sqlite3`, `psql`, `mysql`, `redis-cli`, `lsof`, and `strace`. Only T3 itself updates at runtime by default.

## What It Does

- Starts `t3 serve` in the container on `0.0.0.0:3773`; Docker controls external exposure through `T3_BIND_ADDRESS`.
- Can expose T3 through an optional auth proxy. The proxy uses T3's native local auth control plane to create a short-lived one-time pairing credential and immediately exchanges it for a browser-session cookie, so trusted reverse-proxy deployments can open directly without the pairing screen.
- Installs or updates `t3` at container startup when enabled. Provider CLIs are installed in the image and are not updated at runtime unless explicitly enabled.
- Renders T3 provider settings from `config/t3code.toml` and environment variables.
- Preserves unknown T3 settings and future provider instances while updating the fields managed by the container.
- Adds `/workspace` as a T3 project at startup when `auto_bootstrap_project_from_cwd` is enabled.
- Stores API keys as T3 secret files under `data/t3/userdata/secrets`, not in `settings.json`.
- Can run a managed container-local OpenCode server and point T3 at it through `serverUrl`; this is the preferred path for custom OpenCode configs such as Proton Lumo.
- Can run an optional browser-based MCP auth helper at `/auth-tools` when `T3_AUTH_WEB_HELPER=1`.

## Quick Start

```bash
cp config/t3code.example.toml config/t3code.toml
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3773](http://localhost:3773).

By default the host port is bound to `127.0.0.1`. For direct phone access on a trusted LAN set `T3_BIND_ADDRESS=0.0.0.0`, or keep it loopback-only behind a private reverse proxy.

## GitHub Container Registry

The workflow in `.github/workflows/container.yml` builds and publishes `linux/amd64` and `linux/arm64` images to:

```text
ghcr.io/<owner>/<repo>
```

It runs on pushes to `main`/`master`, manual dispatch, and a daily schedule. Pull requests build only `linux/amd64` and do not push. Scheduled builds read the stable npm `t3` dist-tag and only publish when no image tag exists for that T3 version yet. BuildKit's GitHub Actions cache is exported in `mode=max`; the heavy provider-CLI layer is independent of `T3_VERSION`, so a new T3 stable only invalidates the small T3 install layer.

Python tests/linting, Node and shell syntax, generated OpenSandbox TOML, and all
Compose variants are validated before publishing. T3, agent-base, and gateway
builds use separate GitHub Actions and GHCR registry cache scopes. Cursor's
installer checksum, Grok's stable version, the npm toolchain, uv, and Bun are
resolved build inputs; installer scripts are checksummed. Heavy layers are
therefore reused until an upstream dependency actually changes.

Published tags include:

```text
latest
main
sha-<git-sha>
<t3-version>-<image-build-number>
```

The same run publishes the sandbox components with matching immutable tags:

```text
agent-base
agent-base-<t3-version>-<image-build-number>
sandbox-gateway
sandbox-gateway-<t3-version>-<image-build-number>
```

For example, when npm `t3@latest` is `0.0.28`, the first image build for that upstream version is tagged `0.0.28-1`.

After publishing, set this in `.env` if you want Compose to use the pushed image tag instead of a local name:

```bash
T3_IMAGE=ghcr.io/<owner>/<repo>:latest
```

T3 itself still updates inside the running container: `T3_UPDATE_T3=1` is enabled by default, checks the stable npm version on startup, and installs into `/data/npm-global` only when it is newer. Provider CLI runtime updates are disabled by default with `T3_UPDATE_CODEX=0`, `T3_UPDATE_CLAUDE=0`, `T3_UPDATE_CURSOR=0`, `T3_UPDATE_GROK=0`, and `T3_UPDATE_OPENCODE=0`.

## Direct Browser Access

T3's native `t3 serve` mode expects remote browsers to pair. For a trusted deployment behind your own private reverse proxy, enable the container auth proxy:

```bash
T3_AUTH_PROXY=1
T3_AUTH_PROXY_INTERNAL_HOST=127.0.0.1
T3_AUTH_PROXY_INTERNAL_PORT=13773
T3_AUTH_PROXY_ADMIN_TTL=2m
```

With this mode, T3 listens only on the internal host/port and the proxy listens on `T3_SERVER_PORT`. The proxy does not patch T3 and does not use an `unsafe-no-auth` flag; it creates a short-lived local admin bearer session, uses T3's own pairing-token API to mint an administrative browser pairing credential, and immediately consumes that credential for the browser cookie.

To make MCP OAuth less painful in a trusted deployment, enable the web helper:

```bash
T3_AUTH_WEB_HELPER=1
T3_AUTH_WEB_HELPER_HOST=0.0.0.0
T3_AUTH_WEB_HELPER_PORT=13774
```

With `T3_AUTH_PROXY=1`, open `/auth-tools` on the same T3 host. Without the proxy, Compose maps it to [http://localhost:3774/auth-tools](http://localhost:3774/auth-tools) by default. The helper starts `opencode mcp auth <server>` inside the container and lets you paste the failed browser callback URL back into the container. If `T3_AUTH_WEB_HELPER_TOKEN` is set, open `/auth-tools#token=<value>`; fragments are not sent to reverse-proxy access logs.

The helper only executes allowlisted argument arrays. Additional MCP clients can be added without changing the image:

```bash
T3_AUTH_WEB_HELPER_COMMANDS_JSON='{"opencode":["t3-auth","opencode","mcp-auth","{server}"],"custom":["custom-cli","mcp","auth","{server}"]}'
```

The browser can select a profile and server name but cannot supply an arbitrary command. Set a helper token whenever the endpoint is reachable beyond loopback.

## Compose Layouts

`docker-compose.yml` is the small local default.

`docker-compose.example.yml` is the fuller workstation example:

- runs non-root via `T3_UID:T3_GID`
- can add `T3_WORKSPACE_GID` as a supplementary group for NFS/SMB-backed workspaces
- maps port `${T3_BIND_ADDRESS}:${T3_PORT}:${T3_SERVER_PORT}`
- bind-mounts workspace, T3 state, Codex home, Claude home, and generic tool home
- keeps npm global installs/cache in Docker volumes because they can be recreated

For your AGENTS.md, CLAUDE.md, Skill files, watchdogs, and repo-local prompt material, prefer setting:

```bash
T3_WORKSPACE_HOST=/path/to/developer
```

That exposes the whole developer tree at `/workspace` while provider state stays under `/data`.

For a network-backed workspace that is writable through a share group, keep the
share ACLs on the storage server and set the supplemental group only:

```bash
T3_WORKSPACE_GID=<share-group-id>
```

Do not recursively chown the workspace to the container UID; that breaks SMB/NAS
ACL expectations.

## Ephemeral Coding Sandboxes

The optional stack under [`sandbox/`](sandbox/) keeps tool-heavy agent work out
of the T3 control container. T3, provider sessions, model keys, and MCP auth stay
in the main container. A private MCP bridge asks a policy gateway to create a
short-lived non-root OpenSandbox worker for exactly one Git worktree.

The worker starts from the published `agent-base` image and already contains
common build/debug tools plus FFmpeg, ImageMagick, libvips, ExifTool, MediaInfo,
Poppler, Tesseract OCR, Pandoc, Graphviz, SoX, HEIF/WebP tools, and lossless image
optimizers. Headless Chromium/Xvfb, QR decoding, fast search, native debugging,
coverage, benchmark, archive, and XML tools are also included. npm, uv/pip,
Cargo, and Go caches survive worker replacement; the worker itself is destroyed
at lease expiry. Trusted projects can provide a restricted `devcontainer.json`
for reproducible extra dependencies.

Set `T3_SANDBOX_URL`, `T3_SANDBOX_TOKEN_FILE`, and
`T3_SANDBOX_MCP_RECONCILE=1`. The entrypoint then idempotently registers the
same `t3-sandbox` MCP tools for enabled OpenCode, Codex, Claude, Cursor, and Grok
harnesses.

The container installs the same managed global rule for every enabled harness:
OpenCode uses its configured instruction file, Codex uses
`$CODEX_HOME/AGENTS.md`, Claude uses `~/.claude/CLAUDE.md`, and Grok uses
`$GROK_CONFIG_DIR/AGENTS.md`. Cursor only supports repository-level rule files,
so T3 uses a transparent ACP wrapper that adds the rule to the first prompt of
each Cursor session without touching the repository. Existing user rules are
preserved outside a marked managed block. Set
`T3_HARNESS_SANDBOX_INSTRUCTIONS=0` to disable this behavior globally. The old
`T3_OPENCODE_SANDBOX_INSTRUCTIONS` variable remains as a compatibility fallback.
Set
`T3_OPENCODE_SANDBOX_ONLY=1` to deny OpenCode's local filesystem, shell, edit,
and subagent tools while keeping sandbox, Xcode, and independently configured
remote MCP tools available. A managed `tool.execute.before` plugin enforces the
boundary even when a custom agent contains a broader `permission: allow` rule.
The plugin replaces OpenCode's built-in `bash` definition with a sandbox-backed
compatibility tool. A model may therefore call `bash` immediately, but that call
automatically creates or reuses the session sandbox and never executes in the
T3 control container. Other local tool definitions are marked unavailable and
remain hard-blocked.
This is enabled by default in the production infra example, but remains opt-in
in the generic Compose files.
See [`sandbox/README.md`](sandbox/README.md) for the lifecycle, security model,
Dev Container subset, and complete configuration.

## Remote Xcode Worker

Linux workers cannot run Xcode. The included Xcode bridge keeps T3 on the server
and forwards XcodeBuildMCP's stdio protocol over SSH to a Mac that sees the same
repository tree. No model or provider credentials are copied to the Mac.

On the Mac, enable Remote Login and install the pinned worker:

```bash
bash scripts/install-xcode-worker.sh --install-launch-agent
```

Configure `T3_XCODE_SSH_HOST` and the Mac path corresponding to `/workspace` in
`T3_XCODE_REMOTE_WORKSPACE_ROOT`, then establish the persistent dedicated SSH
key from the T3 container:

```bash
docker exec -it t3code t3-xcode-auth <mac-user>@<mac-host>
```

The installed public key uses OpenSSH `restrict` plus a forced command. It can
only start the Xcode worker below the configured remote workspace root; it
cannot open a shell or forward ports. Run `t3-xcode-auth` again after changing
the remote workspace, DerivedData root, or enabled workflows.

When both Xcode variables are present, all enabled provider harnesses receive an
`xcodebuild` MCP registration automatically. DerivedData defaults to a local Mac
directory through `T3_XCODE_DERIVED_DATA_ROOT`; it never needs to cross
the network workspace mount.

## Autonomous GitHub Issues

The optional `issue-worker` Compose profile runs OpenCode/Lumo independently of
the interactive T3 server. It polls GitHub for open issues carrying
`agent-ready`, creates an isolated checkout, delegates all commands and builds
to the existing T3 sandbox, and opens a draft pull request. It never merges.

The parent worker owns GitHub publication. Its fine-grained GitHub token is
removed from the OpenCode process environment, while the OpenCode agent has no
built-in shell or subagent permission. Repository-local OpenCode plugins and
config are disabled for unattended runs; root `AGENTS.md` and `CLAUDE.md` files
are passed explicitly, and the trusted global OpenCode config, skills, and
watchdogs are copied into a dedicated persistent worker home.
The worker's sandbox MCP is bound to its unique checkout and cannot inspect or
control sandboxes from interactive T3 sessions.

Create a fine-grained token limited to the repositories the worker may change
with `Contents`, `Issues`, and `Pull requests` set to read/write. Then configure:

```bash
T3_ISSUE_WORKER_GITHUB_TOKEN=github_pat_...
T3_ISSUE_WORKER_MODEL=proton/lumo-plus-v1
T3_SANDBOX_URL=http://t3-sandbox-gateway:8090
T3_SANDBOX_TOKEN=...
docker compose --profile issue-worker up -d
```

The token's user is the only allowed label actor by default. Set
`T3_ISSUE_WORKER_ALLOWED_ACTORS` to an explicit comma-separated list when more
maintainers may trigger jobs. `T3_ISSUE_WORKER_REPOSITORIES` can further narrow
the token-selected repository set. On startup, the worker idempotently creates
its lifecycle labels in those repositories:

- `agent-ready`
- `agent-running`
- `agent-pr-opened`
- `agent-complete`
- `agent-needs-human`

CI and workflow definitions are blocked by default, so the token does not need
GitHub's `Workflows` permission. Opting in with
`T3_ISSUE_WORKER_ALLOW_CI_CHANGES=1` also requires granting that permission and
should be limited to repositories with an equivalent CI security review.

Apply `agent-ready` to start work. A failed or ambiguous task retains its
checkout and local JSONL log for `T3_ISSUE_WORKER_KEEP_FAILED_DAYS`; a successful
checkout is removed only after the branch and draft PR exist remotely.

## Secrets

Put keys in `.env` or your shell environment:

```bash
LUMO_API_KEY=...
CLOUDFLARE_API_TOKEN=...
GITHUB_PERSONAL_ACCESS_TOKEN=...
OPENAI_API_KEY=...
CODEX_ACCESS_TOKEN=...
ANTHROPIC_API_KEY=...
CLAUDE_CODE_OAUTH_TOKEN=...
CURSOR_API_KEY=...
OPENCODE_API_KEY=...
XAI_API_KEY=...
CONTEXT7_API_KEY=...
SENTRY_ACCESS_TOKEN=...
```

Provider-specific variables can be added in `config/t3code.toml` with `[[providers.<name>.env]]`.

For Proton Lumo through OpenCode, use the included config example:

```bash
cp config/opencode.lumo.example.json config/opencode.lumo.json
T3_PROVIDER_CODEX=0
T3_PROVIDER_CLAUDE=0
T3_PROVIDER_CURSOR=0
T3_PROVIDER_GROK=0
T3_PROVIDER_OPENCODE=1
T3_OPENCODE_MANAGED_SERVER=1
T3_OPENCODE_CONFIG_SOURCE=/config/opencode.lumo.json
T3_OPENCODE_DEFAULT_MODEL=proton/lumo-plus-v1
T3_OPENCODE_CUSTOM_MODELS=proton/lumo-basic-v1,proton/lumo-plus-v1,proton/auto
T3_OPENCODE_MODEL_ORDER=proton/lumo-plus-v1,proton/lumo-basic-v1,proton/auto
LUMO_API_KEY=...
```

For full harness setups with rules, agents, commands, plugins, tools, and skills, mount directories under `/config` and let the entrypoint sync them into writable provider homes:

```bash
T3_OPENCODE_CONFIG_DIR_SOURCE=/config/opencode
T3_OPENCODE_CONFIG_SYNC_MODE=preserve-mcp
T3_OPENCODE_CONFIG_SOURCE=/data/home/.config/opencode/opencode.jsonc
OPENCODE_CONFIG_DIR=/data/home/.config/opencode
T3_CODEX_CONFIG_DIR_SOURCE=/config/codex
T3_CLAUDE_CONFIG_DIR_SOURCE=/config/claude
T3_GROK_CONFIG_DIR_SOURCE=/config/grok
```

OpenCode defaults to `T3_OPENCODE_CONFIG_SYNC_MODE=preserve-mcp`: the mounted config is mirrored into the writable runtime config, but MCP server registrations added later through OpenCode are restored after the sync. Use `mirror` when `/config/opencode` must be strictly authoritative, `seed` for first-start-only defaults, `merge` for overwrite-without-delete, or `none` to skip syncing. Codex, Claude, and Grok sync without delete so persisted login/session files are not removed. Keep secrets out of these directories when possible; use environment references such as `{env:LUMO_API_KEY}` in `opencode.jsonc`.

Cloudflare's official OpenCode MCP set is provisioned into the writable runtime OpenCode config by default:

```bash
T3_OPENCODE_CLOUDFLARE_MCP=1
T3_OPENCODE_CLOUDFLARE_AUTH=auto
```

The default `1`/`core` profile adds Cloudflare's unified, code-mode API server plus docs. This keeps the tool/context footprint small while covering the full Cloudflare API. Existing entries are left unchanged. Set `docs` for docs only, `all` for the additional legacy bindings/builds/observability endpoints, `api` for the core pair, `token` to require token auth, or `0`/`off` to opt out. With `T3_OPENCODE_CLOUDFLARE_AUTH=auto`, the `cloudflare` entry uses `Authorization: Bearer {env:CLOUDFLARE_API_TOKEN}` and `oauth:false` when `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN` is present; otherwise it keeps OAuth.

Lightweight MCP presets can be added without hand-editing OpenCode config:

```bash
T3_OPENCODE_MCP_PRESETS=context7
```

Supported presets are `context7`, `github`, `sentry`, and `grep`. Context7 uses its remote server, avoiding an `npx` install on every OpenCode start, and accepts optional `CONTEXT7_API_KEY`. `github` is only provisioned when `GITHUB_PERSONAL_ACCESS_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` is present, and uses `oauth:false` plus a bearer header. `sentry` uses its local token-backed server when `SENTRY_ACCESS_TOKEN` is present and remote OAuth otherwise.

Additional OpenCode MCP servers can be provisioned generically by environment variable or mounted JSON file. The value can be either the direct `"mcp"` object or an object containing `"mcp"`:

```bash
T3_OPENCODE_MCP_SERVERS_JSON='{"my-remote-mcp":{"type":"remote","url":"https://example.com/mcp","enabled":true,"oauth":{}}}'
T3_OPENCODE_MCP_SERVERS_FILE=/config/opencode-mcp.json
```

The same can be described in `config/t3code.toml` via `providers.opencode.mcp_servers_file`, `providers.opencode.mcp_servers_json`, or a `providers.opencode.mcp_servers` table.

Provisioning is merge-only: if a server name already exists in the runtime OpenCode config, the existing entry is left untouched. Writes are atomic. With `preserve-mcp`, runtime registrations are restored after an authoritative config sync without allowing defaults to overwrite them. Mount `/config/opencode` with `mirror` when you want the source directory to be strictly authoritative.

T3 model pickers can be filtered without changing provider configs:

```bash
T3_OPENCODE_HIDDEN_MODELS=provider/model-a,provider/model-b
T3_CODEX_HIDDEN_MODELS=gpt-old-model
T3_PROVIDER_MODEL_PREFERENCES_JSON='{"opencode":{"hiddenModels":["provider/model-a"],"modelOrder":["proton/lumo-plus-v1"]}}'
```

## Persistence

- `data/` contains T3 state, provider auth/config homes, MCP OAuth credentials, logs, and generated secrets.
- `workspace/` is the default project directory shown to T3.
- `.env` and real files under `config/` are intentionally ignored by git and Docker build context; only `config/*.example.*` belongs in the repository.
- In `docker-compose.example.yml`, `t3code-npm-global` and `t3code-npm-cache` are Docker volumes. Removing them only forces T3/provider CLI reinstall on next start.

On Linux, make bind-mounted directories writable by the configured non-root UID/GID:

```bash
mkdir -p data/t3 data/home data/codex data/claude-home workspace config
chown -R "$(id -u):$(id -g)" data workspace
```

Then put the numeric output of `id -u` and `id -g` into `T3_UID` and `T3_GID` in `.env`.

## Provider Notes

- Codex uses `CODEX_HOME = /data/codex`. For included ChatGPT/Codex usage, use `t3-auth codex login` / `codex login --device-auth`. API-key auth is available but uses API billing.
- Claude Code uses `/data/claude-home` for the provider process. Use `ANTHROPIC_API_KEY` for API-billed automation, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for subscription-backed CI/container use.
- GitHub CLI auth lives under `/data/home/.config/gh`. Use `t3-auth gh login` for the browser/device flow, `t3-auth gh token` to persist `GH_TOKEN`/`GITHUB_TOKEN`, and `t3-auth gh setup-git` when you want `git` to use the GitHub CLI credential helper.
- Cursor Agent is installed from the official Cursor installer. Its binary is exposed as both `agent` and `cursor-agent`; T3 starts it through `t3-cursor-agent`, which delegates to `T3_CURSOR_REAL_BINARY_PATH=agent` and injects the managed sandbox rule into ACP sessions.
- Grok Build is installed from the official xAI installer. Only the `grok` binary is exposed in `/usr/local/bin` so it does not shadow Cursor's `agent` command. For containers, use `XAI_API_KEY` or `grok login --device-auth`; persisted Grok config/session state lives in `/data/home/.grok`.
- OpenCode can either be spawned by T3 or started by the container wrapper as a managed local server. Use the managed server mode when you need an explicit OpenCode config file, because T3's native OpenCode spawn path controls the spawned server environment.
- T3's native provider update checks are disabled by default through `enableProviderUpdateChecks=false` (`T3_ENABLE_PROVIDER_UPDATE_CHECKS=0`), so provider update notices and one-click update prompts should stay hidden. Re-enable them only if you intentionally want T3 to check agent CLI versions.

Every provider path and toggle can be driven by environment variables. For uncommon provider env vars, use JSON arrays:

```bash
T3_OPENCODE_ENV_JSON='[{"name":"MY_PROVIDER_KEY","from_env":"MY_PROVIDER_KEY","sensitive":true}]'
```

Interactive auth remains possible:

```bash
docker exec -it t3code t3-auth codex login
docker exec -it t3code t3-auth claude login
docker exec -it t3code t3-auth cursor login
docker exec -it t3code t3-auth grok login
docker exec -it t3code t3-auth gh login
docker exec -it t3code t3-auth gh setup-git
docker exec -it t3code t3-auth opencode mcp-list
docker exec -it t3code t3-auth opencode mcp-auth-list
docker exec -it t3code t3-doctor
```

For MCP OAuth from a Docker host, do not run a browser-based auth command through plain `docker exec` from your laptop when it redirects to `127.0.0.1`. That loopback address is the browser machine, not the container. Use the included SSH helper from your workstation instead:

```bash
bash scripts/t3code-mcp-auth-over-ssh.sh docker-host cloudflare
bash scripts/t3code-mcp-auth-over-ssh.sh docker-host cloudflare-bindings
```

The helper keeps the browser callback on local `127.0.0.1:19876` and forwards each callback connection through normal SSH command sessions into the container network namespace. It does not require `ssh -L` or `AllowTcpForwarding` on the Docker host.

For other MCP auth commands that use the same loopback callback pattern, pass the container command after `--` and set `T3_MCP_OAUTH_PORT` if the CLI uses a different callback port:

```bash
bash scripts/t3code-mcp-auth-over-ssh.sh docker-host -- t3-auth opencode mcp-auth cloudflare
T3_MCP_OAUTH_PORT=19876 bash scripts/t3code-mcp-auth-over-ssh.sh docker-host -- codex mcp login cloudflare
```

`scripts/t3code-opencode-mcp-auth-over-ssh.sh` remains as a compatibility wrapper for the OpenCode-specific name.

Use API keys only when you intentionally want API-billed usage:

```bash
docker exec -it t3code t3-auth codex api-key
docker exec -it t3code t3-auth claude env
docker exec -it t3code t3-auth grok env
docker exec -it t3code t3-auth gh token
```
