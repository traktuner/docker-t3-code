# Dockerized T3 Code

This container runs the current `t3` web/headless server. All T3 Code upstream provider CLIs are baked into the image: Codex, Claude Code, Cursor Agent, Grok Build, OpenCode, and a bootstrap T3 CLI. Only T3 itself updates at runtime by default.

## What It Does

- Starts `t3 serve` in the container on `0.0.0.0:3773`; Docker controls external exposure through `T3_BIND_ADDRESS`.
- Can expose T3 through an optional auth proxy. The proxy uses T3's native local auth control plane to create a short-lived one-time pairing credential and immediately exchanges it for a browser-session cookie, so trusted reverse-proxy deployments can open directly without the pairing screen.
- Installs or updates `t3` at container startup when enabled. Provider CLIs are installed in the image and are not updated at runtime unless explicitly enabled.
- Renders T3 provider settings from `config/t3code.toml` and environment variables.
- Adds `/workspace` as a T3 project at startup when `auto_bootstrap_project_from_cwd` is enabled.
- Stores API keys as T3 secret files under `data/t3/userdata/secrets`, not in `settings.json`.
- Can run a managed container-local OpenCode server and point T3 at it through `serverUrl`; this is the preferred path for custom OpenCode configs such as Proton Lumo.

## Quick Start

```bash
cp config/t3code.example.toml config/t3code.toml
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3773](http://localhost:3773).

By default the host port is bound to `127.0.0.1`. For direct phone access on a trusted LAN set `T3_BIND_ADDRESS=0.0.0.0`, or keep it loopback-only behind a private reverse proxy.

## GitHub Container Registry

The workflow in `.github/workflows/container.yml` builds `linux/amd64` and `linux/arm64` images and publishes them to:

```text
ghcr.io/<owner>/<repo>
```

It runs on pushes to `main`/`master`, manual dispatch, and a daily schedule. Pull requests build without pushing. Scheduled builds read the stable npm `t3` dist-tag and only publish when no image tag exists for that T3 version yet.

Published tags include:

```text
latest
main
sha-<git-sha>
<t3-version>-<image-build-number>
```

For example, when npm `t3@latest` is `0.0.28`, the first image build for that upstream version is tagged `0.0.28-1`.

After publishing, set this in `.env` if you want Compose to use the pushed image tag instead of a local name:

```bash
T3_IMAGE=ghcr.io/<owner>/<repo>:latest
```

T3 itself still updates inside the running container: `T3_UPDATE_T3=1` is enabled by default and installs `t3@latest` into `/data/npm-global` on startup. Provider CLI runtime updates are disabled by default with `T3_UPDATE_CODEX=0`, `T3_UPDATE_CLAUDE=0`, `T3_UPDATE_CURSOR=0`, `T3_UPDATE_GROK=0`, and `T3_UPDATE_OPENCODE=0`.

## Direct Browser Access

T3's native `t3 serve` mode expects remote browsers to pair. For a trusted deployment behind your own private reverse proxy, enable the container auth proxy:

```bash
T3_AUTH_PROXY=1
T3_AUTH_PROXY_INTERNAL_HOST=127.0.0.1
T3_AUTH_PROXY_INTERNAL_PORT=13773
T3_AUTH_PROXY_ADMIN_TTL=2m
```

With this mode, T3 listens only on the internal host/port and the proxy listens on `T3_SERVER_PORT`. The proxy does not patch T3 and does not use an `unsafe-no-auth` flag; it creates a short-lived local admin bearer session, uses T3's own pairing-token API to mint an administrative browser pairing credential, and immediately consumes that credential for the browser cookie.

## Compose Layouts

`docker-compose.yml` is the small local default.

`docker-compose.example.yml` is the fuller workstation example:

- runs non-root via `T3_UID:T3_GID`
- maps port `${T3_BIND_ADDRESS}:${T3_PORT}:${T3_SERVER_PORT}`
- bind-mounts workspace, T3 state, Codex home, Claude home, and generic tool home
- keeps npm global installs/cache in Docker volumes because they can be recreated

For your AGENTS.md, CLAUDE.md, Skill files, watchdogs, and repo-local prompt material, prefer setting:

```bash
T3_WORKSPACE_HOST=/Users/thomas/Developer
```

That exposes the whole developer tree at `/workspace` while provider state stays under `/data`.

## Secrets

Put keys in `.env` or your shell environment:

```bash
LUMO_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
OPENCODE_API_KEY=...
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
T3_OPENCODE_DEFAULT_MODEL=lumo/auto
T3_OPENCODE_CUSTOM_MODELS=lumo/auto
LUMO_API_KEY=...
```

## Persistence

- `data/` contains T3 state, provider auth/config homes, logs, and generated secrets.
- `workspace/` is the default project directory shown to T3.
- `config/t3code.toml` and `.env` are intentionally ignored by git.
- In `docker-compose.example.yml`, `t3code-npm-global` and `t3code-npm-cache` are Docker volumes. Removing them only forces T3/provider CLI reinstall on next start.

On Linux, make bind-mounted directories writable by the configured non-root UID/GID:

```bash
mkdir -p data/t3 data/home data/codex data/claude-home workspace config
chown -R "$(id -u):$(id -g)" data workspace
```

Then put the numeric output of `id -u` and `id -g` into `T3_UID` and `T3_GID` in `.env`.

## Provider Notes

- Codex uses `CODEX_HOME path = /data/codex`.
- Claude Code uses `HOME = /data/claude-home` for the provider process.
- Cursor Agent is installed from the official Cursor installer. Its binary is exposed as both `agent` and `cursor-agent`; T3's default Cursor binary path remains `agent`.
- Grok Build is installed from the official xAI installer. Only the `grok` binary is exposed in `/usr/local/bin` so it does not shadow Cursor's `agent` command.
- OpenCode can either be spawned by T3 or started by the container wrapper as a managed local server. Use the managed server mode when you need an explicit OpenCode config file, because T3's native OpenCode spawn path controls the spawned server environment.
- T3's native provider update checks are disabled by default through `enableProviderUpdateChecks=false` (`T3_ENABLE_PROVIDER_UPDATE_CHECKS=0`), so provider update notices and one-click update prompts should stay hidden. Re-enable them only if you intentionally want T3 to check agent CLI versions.

Every provider path and toggle can be driven by environment variables. For uncommon provider env vars, use JSON arrays:

```bash
T3_OPENCODE_ENV_JSON='[{"name":"MY_PROVIDER_KEY","from_env":"MY_PROVIDER_KEY","sensitive":true}]'
```

Interactive auth remains possible:

```bash
docker exec -it t3code codex login
docker exec -it t3code env HOME=/data/claude-home claude auth login
docker exec -it t3code agent login
docker exec -it t3code grok login
docker exec -it t3code opencode auth login
```
