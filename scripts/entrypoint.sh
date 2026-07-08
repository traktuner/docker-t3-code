#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
mkdir -p "$(dirname "$RUNTIME_ENV")" /data/home /data/npm-global /data/npm-cache /data/codex

python3 /opt/t3-docker/render-config.py "${T3CODE_CONFIG_PATH:-/config/t3code.toml}" "$RUNTIME_ENV"
# shellcheck disable=SC1090
source "$RUNTIME_ENV"

export T3CODE_HOME
export HOME="${HOME:-/data/home}"
export CODEX_HOME="${CODEX_HOME:-/data/codex}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/data/npm-global}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/data/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export PATH="$NPM_CONFIG_PREFIX/bin:$HOME/.local/bin:$HOME/.grok/bin:$PATH"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

install_npm_latest() {
  local enabled="$1"
  local package_name="$2"
  local label="$3"

  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating $label package: $package_name@latest"
  npm install -g --no-audit --no-fund "${package_name}@latest"
}

install_cursor_latest() {
  local enabled="$1"
  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating Cursor Agent via official installer"
  HOME="$HOME" NO_COLOR=1 bash -c 'curl -fsSL https://cursor.com/install | bash'
}

install_grok_latest() {
  local enabled="$1"
  local grok_bin_dir="${GROK_BIN_DIR:-$HOME/.grok/bin}"
  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating Grok Build via official installer"
  HOME="$HOME" GROK_BIN_DIR="$grok_bin_dir" bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash'
  # Grok also installs an `agent` alias; keep Cursor's `agent` binary unambiguous for T3.
  rm -f "$grok_bin_dir/agent" "$grok_bin_dir/agent.exe"
}

start_managed_opencode_server() {
  if [[ "${T3_OPENCODE_MANAGED_SERVER:-0}" != "1" ]]; then
    return 0
  fi

  local host="${T3_OPENCODE_MANAGED_HOST:-127.0.0.1}"
  local port="${T3_OPENCODE_MANAGED_PORT:-4096}"
  local config="${T3_OPENCODE_CONFIG:-}"
  local -a server_env=(env)

  if [[ -n "$config" ]]; then
    server_env+=("OPENCODE_CONFIG=$config")
  fi

  echo "Starting managed OpenCode server on http://${host}:${port}"
  "${server_env[@]}" opencode serve "--hostname=${host}" "--port=${port}" &
  local opencode_pid="$!"

  for _ in $(seq 1 50); do
    if ! kill -0 "$opencode_pid" 2>/dev/null; then
      echo "Managed OpenCode server exited before becoming ready." >&2
      wait "$opencode_pid" || true
      exit 1
    fi

    if curl -fsS "http://${host}:${port}/" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.2
  done

  echo "Managed OpenCode server did not answer readiness probe; T3 will still try http://${host}:${port}." >&2
}

if [[ "${T3_AUTO_UPDATE_EFFECTIVE:-1}" == "1" ]]; then
  install_npm_latest "${T3_UPDATE_T3:-1}" "t3" "T3 Code"
  install_npm_latest "${T3_UPDATE_CODEX:-0}" "@openai/codex" "Codex CLI"
  install_npm_latest "${T3_UPDATE_CLAUDE:-0}" "@anthropic-ai/claude-code" "Claude Code"
  install_npm_latest "${T3_UPDATE_OPENCODE:-0}" "opencode-ai" "OpenCode"
  install_cursor_latest "${T3_UPDATE_CURSOR:-0}"
  install_grok_latest "${T3_UPDATE_GROK:-0}"
else
  if ! command -v t3 >/dev/null 2>&1; then
    echo "T3_AUTO_UPDATE=0 but t3 is not installed in $NPM_CONFIG_PREFIX/bin." >&2
    echo "Start once with T3_AUTO_UPDATE=1 or pre-populate the /data volume." >&2
    exit 1
  fi
fi

start_managed_opencode_server

mkdir -p "$T3_WORKDIR"
cd "$T3_WORKDIR"

if [[ "${T3_AUTO_BOOTSTRAP_PROJECT_FROM_CWD:-1}" == "1" ]]; then
  echo "Ensuring T3 project exists for ${T3_WORKDIR}"
  if ! project_output="$(t3 project add --base-dir "$T3CODE_HOME" "$T3_WORKDIR" 2>&1)"; then
    if [[ "$project_output" == *"already exists"* ]]; then
      echo "T3 project already exists for ${T3_WORKDIR}"
    else
      echo "$project_output" >&2
      exit 1
    fi
  elif [[ -n "$project_output" ]]; then
    echo "$project_output"
  fi
fi

args=(
  serve
  --host "$T3_SERVER_HOST"
  --port "$T3_SERVER_PORT"
  --base-dir "$T3CODE_HOME"
)

args+=("$T3_WORKDIR")

echo "Starting T3 Code on http://${T3_SERVER_HOST}:${T3_SERVER_PORT} with workdir ${T3_WORKDIR}"
exec t3 "${args[@]}"
