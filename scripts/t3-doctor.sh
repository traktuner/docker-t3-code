#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
fi
if [[ -z "${T3_SANDBOX_TOKEN:-}" && -r "${T3_SANDBOX_TOKEN_FILE:-}" ]]; then
  T3_SANDBOX_TOKEN="$(<"$T3_SANDBOX_TOKEN_FILE")"
fi

export HOME="${HOME:-/data/home}"
export CODEX_HOME="${CODEX_HOME:-/data/codex}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
export PATH="${NPM_CONFIG_PREFIX:-/data/npm-global}/bin:$HOME/.local/bin:$HOME/.grok/bin:$PATH"

failures=0
ok() { printf 'ok   %s\n' "$*"; }
warn() { printf 'warn %s\n' "$*"; }
fail() { printf 'fail %s\n' "$*"; failures=$((failures + 1)); }

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd: $(command -v "$cmd")"
  else
    warn "$cmd: missing"
  fi
}

check_writable() {
  local path="$1"
  mkdir -p "$path" 2>/dev/null || true
  if [[ -w "$path" ]]; then
    ok "writable: $path"
  else
    fail "not writable: $path"
  fi
}

check_env_presence() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    ok "env set: $name"
  else
    warn "env missing: $name"
  fi
}

version_line() {
  local cmd="$1"
  shift
  if command -v "$cmd" >/dev/null 2>&1; then
    local output
    output="$("$cmd" "$@" 2>&1 | head -n 1 || true)"
    printf '     %s %s\n' "$cmd" "$output"
  fi
}

printf 'T3 Docker doctor\n'
printf 'user: %s uid=%s gid=%s groups=%s\n' "$(id -un 2>/dev/null || true)" "$(id -u)" "$(id -g)" "$(id -G)"
printf 'image: t3=%s build=%s\n' "${T3_IMAGE_T3_VERSION:-unknown}" "${T3_IMAGE_BUILD_NUMBER:-unknown}"
printf 'home: HOME=%s CODEX_HOME=%s OPENCODE_CONFIG_DIR=%s\n' "$HOME" "$CODEX_HOME" "$OPENCODE_CONFIG_DIR"
printf '\n'

printf 'paths\n'
check_writable "$HOME"
check_writable "${T3CODE_HOME:-/data/t3}"
check_writable "${CODEX_HOME:-/data/codex}"
check_writable "${T3_CLAUDE_HOME_PATH:-/data/claude-home}"
check_writable "${GROK_CONFIG_DIR:-$HOME/.grok}"
check_writable "${T3_WORKDIR:-/workspace}"
printf '\n'

printf 'commands\n'
for cmd in t3 codex claude opencode agent cursor-agent grok gh git ssh rg fd jq yq python3 uv uvx node npm bun bunx pnpm yarn shellcheck sqlite3 psql mysql redis-cli curl rsync lsof strace; do
  check_cmd "$cmd"
done
printf '\n'

printf 'versions\n'
version_line t3 --version
version_line codex --version
version_line claude --version
version_line opencode --version
version_line grok --version
version_line gh --version
version_line git --version
version_line node --version
version_line npm --version
version_line uv --version
version_line bun --version
printf '\n'

printf 'auth env presence\n'
for name in LUMO_API_KEY CLOUDFLARE_API_TOKEN CF_API_TOKEN CONTEXT7_API_KEY SENTRY_ACCESS_TOKEN SENTRY_AUTH_TOKEN OPENAI_API_KEY CODEX_ACCESS_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CURSOR_API_KEY XAI_API_KEY GH_TOKEN GITHUB_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN; do
  check_env_presence "$name"
done
printf '\n'

printf 'opencode\n'
config="${T3_OPENCODE_CONFIG:-$OPENCODE_CONFIG_DIR/opencode.jsonc}"
if [[ -f "$config" ]]; then
  ok "config exists: $config"
else
  warn "config missing: $config"
fi
if [[ "${T3_OPENCODE_MANAGED_SERVER:-0}" == "1" ]]; then
  health_url="http://${T3_OPENCODE_MANAGED_HOST:-127.0.0.1}:${T3_OPENCODE_MANAGED_PORT:-4096}/global/health"
  if curl --connect-timeout 1 --max-time 3 -fsS "$health_url" >/dev/null 2>&1; then
    ok "managed OpenCode health: $health_url"
  else
    fail "managed OpenCode health failed: $health_url"
  fi
fi
if command -v opencode >/dev/null 2>&1; then
  timeout 15 opencode mcp list 2>&1 | sed 's/^/     /' || warn "opencode mcp list failed"
fi
printf '\n'

if [[ -n "${T3_SANDBOX_URL:-}" ]]; then
  sandbox_health="${T3_SANDBOX_URL%/}/health"
  if curl --connect-timeout 1 --max-time 3 -fsS "$sandbox_health" >/dev/null 2>&1; then
    ok "sandbox gateway health: $sandbox_health"
  else
    fail "sandbox gateway health failed: $sandbox_health"
  fi
  if [[ -n "${T3_SANDBOX_TOKEN:-}" ]] \
    && curl --connect-timeout 1 --max-time 3 -fsS \
      -H "Authorization: Bearer ${T3_SANDBOX_TOKEN}" \
      "${T3_SANDBOX_URL%/}/v1/sandboxes" >/dev/null 2>&1; then
    ok "sandbox gateway authentication"
  else
    fail "sandbox gateway authentication failed"
  fi
fi

printf 't3\n'
t3_url="http://127.0.0.1:${T3_SERVER_PORT:-3773}/"
if curl --connect-timeout 1 --max-time 3 -fsS "$t3_url" >/dev/null 2>&1; then
  ok "T3 server answers: $t3_url"
else
  fail "T3 server not answering at $t3_url"
fi

(( failures == 0 ))
