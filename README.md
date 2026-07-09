# Dockerized T3 Code

This container runs the current `t3` web/headless server. All T3 Code upstream provider CLIs are baked into the image: Codex, Claude Code, Cursor Agent, Grok Build, OpenCode, and a bootstrap T3 CLI. The image also includes `git`, `ssh`, `rsync`, and the GitHub CLI (`gh`) for normal repository work from inside the container. Only T3 itself updates at runtime by default.

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
T3_WORKSPACE_GID=3001
```

Do not recursively chown the workspace to the container UID; that breaks SMB/NAS
ACL expectations.

## Secrets

Put keys in `.env` or your shell environment:

```bash
LUMO_API_KEY=...
OPENAI_API_KEY=...
CODEX_ACCESS_TOKEN=...
ANTHROPIC_API_KEY=...
CLAUDE_CODE_OAUTH_TOKEN=...
OPENCODE_API_KEY=...
XAI_API_KEY=...
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
T3_OPENCODE_CONFIG_SOURCE=/data/home/.config/opencode/opencode.jsonc
OPENCODE_CONFIG_DIR=/data/home/.config/opencode
T3_CODEX_CONFIG_DIR_SOURCE=/config/codex
T3_CLAUDE_CONFIG_DIR_SOURCE=/config/claude
T3_GROK_CONFIG_DIR_SOURCE=/config/grok
```

OpenCode syncs with `--delete` so the mounted config is authoritative. Codex, Claude, and Grok sync without delete so persisted login/session files are not removed. Keep secrets out of these directories when possible; use environment references such as `{env:LUMO_API_KEY}` in `opencode.jsonc`.

Cloudflare's official OpenCode MCP set is provisioned into the writable runtime OpenCode config by default:

```bash
T3_OPENCODE_CLOUDFLARE_MCP=1
```

This adds `cloudflare`, `cloudflare-docs`, `cloudflare-bindings`, `cloudflare-builds`, and `cloudflare-observability` when missing. Existing entries are left unchanged. Set `T3_OPENCODE_CLOUDFLARE_MCP=0` to opt out.

Additional OpenCode MCP servers can be provisioned generically by environment variable or mounted JSON file. The value can be either the direct `"mcp"` object or an object containing `"mcp"`:

```bash
T3_OPENCODE_MCP_SERVERS_JSON='{"my-remote-mcp":{"type":"remote","url":"https://example.com/mcp","enabled":true,"oauth":{}}}'
T3_OPENCODE_MCP_SERVERS_FILE=/config/opencode-mcp.json
```

Provisioning is merge-only: if a server name already exists in the runtime OpenCode config, the existing entry is left untouched. Mount `/config/opencode` when you want the whole OpenCode config to be authoritative.

T3 model pickers can be filtered without changing provider configs:

```bash
T3_OPENCODE_HIDDEN_MODELS=provider/model-a,provider/model-b
T3_CODEX_HIDDEN_MODELS=gpt-old-model
T3_PROVIDER_MODEL_PREFERENCES_JSON='{"opencode":{"hiddenModels":["provider/model-a"],"modelOrder":["proton/lumo-plus-v1"]}}'
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

- Codex uses `CODEX_HOME = /data/codex`. For included ChatGPT/Codex usage, use `t3-auth codex login` / `codex login --device-auth`. API-key auth is available but uses API billing.
- Claude Code uses `/data/claude-home` for the provider process. Use `ANTHROPIC_API_KEY` for API-billed automation, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for subscription-backed CI/container use.
- GitHub CLI auth lives under `/data/home/.config/gh`. Use `t3-auth gh login` for the browser/device flow, `t3-auth gh token` to persist `GH_TOKEN`/`GITHUB_TOKEN`, and `t3-auth gh setup-git` when you want `git` to use the GitHub CLI credential helper.
- Cursor Agent is installed from the official Cursor installer. Its binary is exposed as both `agent` and `cursor-agent`; T3's default Cursor binary path remains `agent`.
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
docker exec -it t3code agent login
docker exec -it t3code t3-auth grok login
docker exec -it t3code t3-auth gh login
docker exec -it t3code t3-auth gh setup-git
docker exec -it t3code t3-auth opencode mcp-list
```

For MCP OAuth from a Docker host, do not run a browser-based auth command through plain `docker exec` from your laptop when it redirects to `127.0.0.1`. That loopback address is the browser machine, not the container. Use the included SSH helper from your workstation instead:

```bash
bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 cloudflare
bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 cloudflare-bindings
```

The helper keeps the browser callback on local `127.0.0.1:19876` and forwards each callback connection through normal SSH command sessions into the container network namespace. It does not require `ssh -L` or `AllowTcpForwarding` on the Docker host.

For other MCP auth commands that use the same loopback callback pattern, pass the container command after `--` and set `T3_MCP_OAUTH_PORT` if the CLI uses a different callback port:

```bash
bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 -- t3-auth opencode mcp-auth cloudflare
T3_MCP_OAUTH_PORT=19876 bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 -- codex mcp login cloudflare
```

`scripts/t3code-opencode-mcp-auth-over-ssh.sh` remains as a compatibility wrapper for the OpenCode-specific name.

Use API keys only when you intentionally want API-billed usage:

```bash
docker exec -it t3code t3-auth codex api-key
docker exec -it t3code t3-auth claude env
docker exec -it t3code t3-auth grok env
docker exec -it t3code t3-auth gh token
```
