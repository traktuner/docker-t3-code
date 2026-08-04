# Dockerized T3 Code

This container runs the official T3 Code headless server. All T3 Code upstream provider CLIs are baked into the image: Codex, Claude Code, Cursor Agent, Grok Build, and OpenCode. The image also includes common agentic-coding tools such as `git`, `gh`, `ssh`, `rg`, `fd`, `jq`, `yq`, `uv`, `bun`, `pnpm`, `yarn`, `prettier`, `typescript`, `shellcheck`, `sqlite3`, `psql`, `mysql`, `redis-cli`, `lsof`, and `strace`.

## What It Does

- Starts the pinned `/usr/local/bin/t3` exclusively as the official `t3 serve --mode web` server.
- Can place a small same-container HTTP/WebSocket proxy in front of that server so an already edge-authenticated browser receives a standard T3 browser session without a visible pairing step. No Electron process, replacement T3 server, or `app.t3.codes` dependency is involved.
- Exposes only container port `3773` to the Docker network. The existing external Traefik route is responsible for reaching it; Compose publishes no host port.
- Keeps T3 pinned in the image. Provider CLIs are installed in the image and are not updated at runtime unless explicitly enabled.
- Renders T3 provider settings from `config/t3code.toml` and environment variables.
- Preserves unknown T3 settings and future provider instances while updating the fields managed by the container.
- Lets the official server add `/workspace` as a T3 project through `--auto-bootstrap-project-from-cwd` when enabled.
- Stores API keys as T3 secret files under `data/t3/userdata/secrets`, not in `settings.json`.
- Can run a managed container-local OpenCode server and point T3 at it through `serverUrl`; this is the preferred path for custom OpenCode configs such as Proton Lumo.

## Quick Start

```bash
cp config/t3code.example.toml config/t3code.toml
cp .env.example .env
docker compose up --build
```

Open the existing Cloudflare-Access-protected URL routed by Traefik to
`t3code:3773`. Use that URL directly; `app.t3.codes` is not part of this
deployment.

## GitHub Container Registry

The workflow in `.github/workflows/container.yml` builds and publishes `linux/amd64` and `linux/arm64` images to:

```text
ghcr.io/<owner>/<repo>
```

It runs on pushes to `main`/`master`, manual dispatch, and a daily schedule. Pull requests build only `linux/amd64` and do not push. A scheduled run checks the stable `t3` npm version against published image tags and exits without tests, provider lookups, or image publishing when that T3 version is already present. A newly released T3 version triggers the normal validated build; provider CLI and toolchain releases alone never trigger an image rebuild. Pushes use the repository-pinned `T3_VERSION`, while a scheduled T3 release build uses the detected stable T3 version. BuildKit's GitHub Actions cache is exported in `mode=max`; the heavy provider-CLI layer is independent of `T3_VERSION`, so a T3 upgrade only invalidates the small T3 install layer.

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

For example, the first image build for pinned `t3@0.0.28` is tagged `0.0.28-1`.

After publishing, set this in `.env` if you want Compose to use the pushed image tag instead of a local name:

```bash
T3_IMAGE=ghcr.io/<owner>/<repo>:latest
```

T3 never self-updates at container startup. Provider CLI runtime updates are
disabled by default with `T3_UPDATE_CODEX=0`, `T3_UPDATE_CLAUDE=0`,
`T3_UPDATE_CURSOR=0`, `T3_UPDATE_GROK=0`, and `T3_UPDATE_OPENCODE=0`.

## Direct Browser Access

The browser connects through the existing chain:

```text
Browser -> Cloudflare Access/Keycloak -> Traefik -> t3code:3773
  -> optional browser-session proxy -> official t3 serve
```

Cloudflare Access protects the edge and keeps the existing Keycloak login. To
remove T3's otherwise mandatory browser pairing screen behind that trusted
edge, enable:

```dotenv
T3_AUTH_PROXY=1
T3_AUTH_PROXY_INTERNAL_HOST=127.0.0.1
T3_AUTH_PROXY_INTERNAL_PORT=13773
T3_AUTH_PROXY_ADMIN_TTL=2m
```

The proxy intercepts only T3's session check. When no valid browser session
exists, it asks the container-local T3 control plane for a two-minute
administrative credential, creates a one-time browser credential, immediately
revokes the administrative credential, and returns T3's normal HttpOnly browser
cookie. HTTP and WebSocket traffic otherwise pass through unchanged. It does
not retain or expose Electron's 24-hour desktop bootstrap secret.

T3 prevents its current browser session from being revoked through the access
UI and implements "revoke other clients" as all sessions except the current
one. If a browser cookie is nevertheless revoked externally, the next session
check repeats the short-lived local exchange and recovers automatically.

Enabling this makes Cloudflare Access/Keycloak the human authentication
boundary for the T3 URL. Do not expose port `3773` through a route that bypasses
that boundary. Standard HTTP Upgrade forwarding is sufficient for WebSockets.

## Compose Layouts

`docker-compose.yml` is the small local default.

`docker-compose.example.yml` is the fuller workstation example:

- runs non-root via `T3_UID:T3_GID`
- can add `T3_WORKSPACE_GID` as a supplementary group for NFS/SMB-backed workspaces
- exposes container port `3773` to the Docker network without publishing a host port
- bind-mounts workspace, T3 state, Codex home, Claude home, and generic tool home
- keeps npm global installs/cache in Docker volumes because they can be recreated

For your AGENTS.md, CLAUDE.md, Skill files, watchdogs, and repo-local prompt material, prefer setting:

```bash
T3_WORKSPACE_HOST=/path/to/developer
```

That exposes the whole developer tree at `/workspace` while provider state stays under `/data`.
At startup, repositories found below that workspace are registered individually as Git safe
directories. `T3_GIT_REPOSITORY_SCAN_DEPTH` controls the scan depth and defaults to `8`.

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
the current official Docker CE CLI and Compose plugin, Ansible, common build/debug tools plus FFmpeg, ImageMagick, libvips, ExifTool, MediaInfo,
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
T3_ISSUE_WORKER_MODEL=proton/lumo-max
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
T3_OPENCODE_DEFAULT_MODEL=proton/lumo-max
T3_OPENCODE_CUSTOM_MODELS=proton/lumo-lite,proton/lumo-max
T3_OPENCODE_MODEL_ORDER=proton/lumo-max,proton/lumo-lite
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
T3_OPENCODE_MCP_PRESETS=context7,github
```

Supported presets are `context7`, `github`, `sentry`, and `grep`. Context7 uses its remote server, avoiding an `npx` install on every OpenCode start, and accepts optional `CONTEXT7_API_KEY`. `github` is only provisioned when `GITHUB_PERSONAL_ACCESS_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` is present, and uses `oauth:false` plus a bearer header. `sentry` uses its local token-backed server when `SENTRY_ACCESS_TOKEN` is present and remote OAuth otherwise.


When the GitHub preset is enabled without an environment token, the trusted T3 parent reuses its persisted `t3-auth gh login`. The same local `t3-github-mcp` bridge is registered for OpenCode, Codex, Claude Code, Cursor Agent, and Grok Build. It forwards MCP tool discovery and calls to GitHub's remote MCP while keeping the bearer token in the parent process; disposable sandbox workers never receive that credential. Managed instructions tell every harness to use the `github` MCP instead of authenticated `gh` commands in the sandbox.

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
T3_PROVIDER_MODEL_PREFERENCES_JSON='{"opencode":{"hiddenModels":["provider/model-a"],"modelOrder":["proton/lumo-max"]}}'
```

## Persistence

- `/workspace` is only the host-mounted developer workspace. In production the
  Docker host mounts the existing NFS share and bind-mounts it here; the
  container does not mount NFS and never recursively changes workspace
  ownership.
- `/data/t3` is the dedicated persistent T3 base directory for server state,
  SQLite, attachments, worktrees, logs, pairing, and sessions.
- `/data/home`, `/data/codex`, and `/data/claude-home` are dedicated persistent
  provider homes. They retain OpenCode configuration, Codex/Claude login state,
  SSH data, and related user configuration independently of T3 state.
- `.env` and real files under `config/` are intentionally ignored by git and Docker build context; only `config/*.example.*` belongs in the repository.
- `t3code-npm-global` and `t3code-npm-cache` are replaceable provider-update
  volumes. The pinned T3 binary is always executed from `/usr/local/bin` in the
  image and cannot be shadowed by stale runtime state.

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
docker exec -it t3code opencode auth login
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

Run each required interactive provider login once after the persistent home
volumes are mounted. Credentials remain in those volumes; do not bake them into
the image, commit them, or copy them into logs.

## Upgrading the Pinned T3 Version

The tested pin is `0.0.28`. An upgrade is intentional rather than automatic:

1. Change `T3_VERSION` together in `Dockerfile`, `.env.example`, and the
   workflow `env`.
2. Run `npx --yes t3@<version> serve --help` and verify the Node engine,
   `--host`, `--port`, `--base-dir`, bootstrap flag, and positional workspace
   contract.
3. Re-run the full source checks, Compose validation, image build, and in-image
   CLI/version checks before publishing a new image.

Do not enable a runtime `t3@latest` install. A manual workflow override is
acceptable only after the same version-specific checks.

## Deployment Boundary

Cloudflare Access authenticates the edge through the existing Keycloak login.
When `T3_AUTH_PROXY=0`, T3 pairing remains an independent second authentication
layer. When `T3_AUTH_PROXY=1`, the edge authentication is the human
authentication boundary and the proxy translates it into a standard T3
session. A
deployment is not proven until a separately authorized live smoke test covers:

```text
Cloudflare Access -> Keycloak -> Traefik -> WSS -> T3 session
  -> Codex -> Claude Code -> OpenCode
```

This repository build does not deploy or alter Cloudflare, Keycloak, Traefik,
TrueNAS, NFS, or production containers.
