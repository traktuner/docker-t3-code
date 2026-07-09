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
  local binary_name="${4:-}"

  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating $label package: $package_name@latest"
  if npm install -g --no-audit --no-fund --dangerously-allow-all-scripts "${package_name}@latest"; then
    return 0
  fi

  echo "Warning: failed to update $label package. Falling back to bundled image version if available." >&2
  if [[ -n "$binary_name" ]]; then
    npm uninstall -g "$package_name" >/dev/null 2>&1 || true
    if command -v "$binary_name" >/dev/null 2>&1; then
      echo "Continuing with bundled $label at $(command -v "$binary_name")"
      return 0
    fi
  fi

  echo "No usable bundled $label binary found after failed update." >&2
  return 1
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
  local ready_url="${T3_OPENCODE_READY_URL:-http://${host}:${port}/}"
  local -a server_env=(env)

  if [[ -n "$config" ]]; then
    server_env+=("OPENCODE_CONFIG=$config")
  fi

  echo "Starting managed OpenCode server on http://${host}:${port}"
  "${server_env[@]}" opencode serve "--hostname=${host}" "--port=${port}" &
  local opencode_pid="$!"

  for _ in $(seq 1 30); do
    if ! kill -0 "$opencode_pid" 2>/dev/null; then
      echo "Managed OpenCode server exited before becoming ready." >&2
      wait "$opencode_pid" || true
      exit 1
    fi

    if curl --connect-timeout 1 --max-time 2 -fsS "$ready_url" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.5
  done

  echo "Managed OpenCode server did not answer readiness probe; T3 will still try http://${host}:${port}." >&2
}

wait_for_http_ready() {
  local url="$1"
  local label="$2"
  local attempts="${3:-120}"

  for _ in $(seq 1 "$attempts"); do
    if curl --connect-timeout 1 --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  echo "$label did not become ready at $url." >&2
  return 1
}

run_t3_foreground() {
  local -a args=(
    serve
    --host "$T3_SERVER_HOST"
    --port "$T3_SERVER_PORT"
    --base-dir "$T3CODE_HOME"
  )

  args+=("$T3_WORKDIR")

  echo "Starting T3 Code on http://${T3_SERVER_HOST}:${T3_SERVER_PORT} with workdir ${T3_WORKDIR}"
  exec t3 "${args[@]}"
}

run_t3_with_auth_proxy() {
  local listen_host="$T3_SERVER_HOST"
  local listen_port="$T3_SERVER_PORT"
  local upstream_host="${T3_AUTH_PROXY_INTERNAL_HOST:-127.0.0.1}"
  local upstream_port="${T3_AUTH_PROXY_INTERNAL_PORT:-13773}"
  local -a args=(
    serve
    --host "$upstream_host"
    --port "$upstream_port"
    --base-dir "$T3CODE_HOME"
    "$T3_WORKDIR"
  )

  echo "Starting T3 Code internal backend on http://${upstream_host}:${upstream_port} with workdir ${T3_WORKDIR}"
  t3 "${args[@]}" &
  local t3_pid="$!"
  local proxy_pid=""

  cleanup_children() {
    if [[ -n "${t3_pid:-}" ]]; then
      kill "$t3_pid" >/dev/null 2>&1 || true
      wait "$t3_pid" >/dev/null 2>&1 || true
    fi
    if [[ -n "${proxy_pid:-}" ]]; then
      kill "$proxy_pid" >/dev/null 2>&1 || true
      wait "$proxy_pid" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_children TERM INT

  if ! wait_for_http_ready "http://${upstream_host}:${upstream_port}/api/auth/session" "T3 Code internal backend"; then
    cleanup_children
    exit 1
  fi

  echo "Starting T3 auth proxy on http://${listen_host}:${listen_port}"
  T3_AUTH_PROXY_LISTEN_HOST="$listen_host" \
    T3_AUTH_PROXY_LISTEN_PORT="$listen_port" \
    T3_AUTH_PROXY_UPSTREAM_HOST="$upstream_host" \
    T3_AUTH_PROXY_UPSTREAM_PORT="$upstream_port" \
    T3_AUTH_PROXY_ADMIN_TTL="${T3_AUTH_PROXY_ADMIN_TTL:-2m}" \
    node /opt/t3-docker/auth-proxy.mjs &
  proxy_pid="$!"

  wait -n "$t3_pid" "$proxy_pid"
  local exit_code="$?"
  cleanup_children
  exit "$exit_code"
}

if [[ "${T3_AUTO_UPDATE_EFFECTIVE:-1}" == "1" ]]; then
  install_npm_latest "${T3_UPDATE_T3:-1}" "t3" "T3 Code" "t3"
  install_npm_latest "${T3_UPDATE_CODEX:-0}" "@openai/codex" "Codex CLI" "codex"
  install_npm_latest "${T3_UPDATE_CLAUDE:-0}" "@anthropic-ai/claude-code" "Claude Code" "claude"
  install_npm_latest "${T3_UPDATE_OPENCODE:-0}" "opencode-ai" "OpenCode" "opencode"
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

if [[ "${T3_AUTH_PROXY:-0}" == "1" ]]; then
  run_t3_with_auth_proxy
else
  run_t3_foreground
fi
