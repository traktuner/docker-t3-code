#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
managed_opencode_pid=""
t3_pid=""
auth_proxy_pid=""
mkdir -p \
  "$(dirname "$RUNTIME_ENV")" \
  /data/t3 \
  /data/home \
  /data/npm-global \
  /data/npm-cache \
  /data/codex \
  /data/claude-home

if [[ -z "${T3_SANDBOX_TOKEN:-}" && -n "${T3_SANDBOX_TOKEN_FILE:-}" ]]; then
  if [[ ! -r "$T3_SANDBOX_TOKEN_FILE" ]]; then
    echo "T3_SANDBOX_TOKEN_FILE is not readable: $T3_SANDBOX_TOKEN_FILE" >&2
    exit 1
  fi
  T3_SANDBOX_TOKEN="$(<"$T3_SANDBOX_TOKEN_FILE")"
  export T3_SANDBOX_TOKEN
fi

python3 /opt/t3-docker/render-config.py "${T3CODE_CONFIG_PATH:-/config/t3code.toml}" "$RUNTIME_ENV"
# shellcheck disable=SC1090
source "$RUNTIME_ENV"

export T3CODE_HOME
export HOME="${HOME:-/data/home}"
export CODEX_HOME="${CODEX_HOME:-/data/codex}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/data/npm-global}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/data/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export PATH="/opt/t3-docker/runtime-bin:$NPM_CONFIG_PREFIX/bin:$HOME/.local/bin:$HOME/.grok/bin:$PATH"
mkdir -p \
  "$HOME" \
  "$CODEX_HOME" \
  "${T3_CLAUDE_HOME_PATH:-/data/claude-home}" \
  "${GROK_CONFIG_DIR:-$HOME/.grok}" \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME" \
  "$OPENCODE_CONFIG_DIR"

persist_runtime_env_value() {
  local name="$1"
  local value="$2"
  printf '%s=%q\n' "$name" "$value" >> "$RUNTIME_ENV"
}

configure_git_safe_directories() {
  local workspace="${T3_WORKDIR:-/workspace}"
  local max_depth="${T3_GIT_REPOSITORY_SCAN_DEPTH:-8}"
  local git_marker repository

  [[ -d "$workspace" ]] || return 0
  if [[ ! "$max_depth" =~ ^[1-9][0-9]*$ ]]; then
    echo "T3_GIT_REPOSITORY_SCAN_DEPTH must be a positive integer." >&2
    exit 1
  fi

  while IFS= read -r -d '' git_marker; do
    repository="$(dirname "$git_marker")"
    if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fqx -- "$repository"; then
      git config --global --add safe.directory "$repository"
      echo "Trusted Git repository in mounted workspace: $repository"
    fi
  done < <(
    find "$workspace" -xdev -mindepth 1 -maxdepth "$max_depth" \
      \( -type d -o -type f \) -name .git -print0 2>/dev/null
  )
}

hydrate_github_auth_for_opencode() {
  local presets="${T3_OPENCODE_MCP_PRESETS:-}"
  local gh_host token

  # Keep provider credentials out of disposable sandbox workers. Only hydrate
  # the trusted parent process when the GitHub MCP was explicitly requested.
  presets="${presets//[[:space:]]/}"
  if [[ ",${presets,,}," != *",github,"* ]]; then
    return 0
  fi
  if [[ -n "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" || -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" ]]; then
    return 0
  fi
  command -v gh >/dev/null 2>&1 || return 0

  gh_host="${GH_HOST:-${GITHUB_HOST:-github.com}}"
  token="$(gh auth token --hostname "$gh_host" 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    export GITHUB_PERSONAL_ACCESS_TOKEN="$token"
    echo "Using the persisted gh login for the parent OpenCode GitHub MCP."
  fi
}

preserve_opencode_mcp_config() {
  local target_dir="$1"
  local candidate="${T3_OPENCODE_CONFIG:-}"

  if [[ -z "$candidate" || ! -f "$candidate" ]]; then
    for candidate in "$target_dir/opencode.jsonc" "$target_dir/opencode.json"; do
      [[ -f "$candidate" ]] && break
    done
  fi
  if [[ ! -f "$candidate" || -n "${T3_OPENCODE_MCP_PRESERVE_FILE:-}" ]]; then
    return 0
  fi

  T3_OPENCODE_MCP_PRESERVE_FILE="$(mktemp /tmp/t3-docker/opencode-mcp-preserve.XXXXXX.jsonc)"
  T3_OPENCODE_MCP_PRESERVE_FILE_GENERATED=1
  cp "$candidate" "$T3_OPENCODE_MCP_PRESERVE_FILE"
  export T3_OPENCODE_MCP_PRESERVE_FILE T3_OPENCODE_MCP_PRESERVE_FILE_GENERATED
}

provision_opencode_config_dir() {
  local source="${T3_OPENCODE_CONFIG_DIR_SOURCE:-}"
  local target="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
  local sync_mode="${T3_OPENCODE_CONFIG_SYNC_MODE:-preserve-mcp}"
  local -a rsync_args=(
    -a
    --exclude='node_modules/'
    --exclude='*.bak*'
    --exclude='*~'
    --exclude='.DS_Store'
  )

  sync_mode="$(printf '%s' "$sync_mode" | tr '[:upper:]_' '[:lower:]-' | tr -d '[:space:]')"
  if [[ "$sync_mode" == "preserve-mcp" ]]; then
    preserve_opencode_mcp_config "$target"
  fi

  if [[ -z "$source" ]]; then
    return 0
  fi

  if [[ ! -d "$source" ]]; then
    echo "T3_OPENCODE_CONFIG_DIR_SOURCE points to a missing directory: $source" >&2
    exit 1
  fi

  mkdir -p "$target"
  case "$sync_mode" in
    none)
      echo "Skipping OpenCode config sync because T3_OPENCODE_CONFIG_SYNC_MODE=none"
      ;;
    seed)
      echo "Seeding missing OpenCode config files from $source to $target"
      rsync "${rsync_args[@]}" --ignore-existing "$source"/ "$target"/
      ;;
    merge)
      echo "Merging OpenCode config from $source to $target"
      rsync "${rsync_args[@]}" "$source"/ "$target"/
      ;;
    mirror)
      echo "Mirroring OpenCode config from $source to $target"
      rsync "${rsync_args[@]}" --delete "$source"/ "$target"/
      ;;
    preserve-mcp)
      echo "Mirroring OpenCode config from $source to $target while preserving runtime MCP registrations"
      rsync "${rsync_args[@]}" --delete "$source"/ "$target"/
      ;;
    *)
      echo "T3_OPENCODE_CONFIG_SYNC_MODE must be one of: preserve-mcp, mirror, merge, seed, none" >&2
      exit 1
      ;;
  esac

  if [[ -d "$target/tools" ]]; then
    find "$target/tools" -type f \( -name '*.sh' -o -name '*.py' \) -exec chmod u+x {} +
  fi

  if [[ ! -f "$target/package.json" ]]; then
    return 0
  fi

  local digest_input=("$target/package.json")
  if [[ -f "$target/package-lock.json" ]]; then
    digest_input+=("$target/package-lock.json")
  fi

  local stamp="$target/node_modules/.t3-config-deps.sha256"
  local digest
  digest="$(sha256sum "${digest_input[@]}" | sha256sum | awk '{print $1}')"

  if [[ -f "$stamp" && "$(cat "$stamp")" == "$digest" ]]; then
    return 0
  fi

  local had_deps=0
  if [[ -f "$stamp" ]]; then
    had_deps=1
  fi

  echo "Installing OpenCode config dependencies in $target"
  if ! npm install --prefix "$target" --omit=dev --no-audit --no-fund; then
    if [[ "$had_deps" == "1" ]]; then
      echo "Warning: failed to refresh OpenCode config dependencies; continuing with existing node_modules." >&2
      return 0
    fi
    exit 1
  fi

  mkdir -p "$(dirname "$stamp")"
  printf '%s\n' "$digest" > "$stamp"
}

provision_opencode_mcp() {
  local config_path="${T3_OPENCODE_CONFIG:-}"
  local config_source="${T3_OPENCODE_CONFIG_SOURCE_FILE:-}"
  local target_dir="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
  if [[ -z "$config_path" ]]; then
    config_path="$target_dir/opencode.jsonc"
  fi

  if [[ -n "$config_source" ]]; then
    if [[ ! -f "$config_source" ]]; then
      echo "T3_OPENCODE_CONFIG_SOURCE points to a missing file: $config_source" >&2
      exit 1
    fi
    if [[ "$config_source" != "$config_path" ]]; then
      mkdir -p "$(dirname "$config_path")"
      cp "$config_source" "$config_path"
      chmod u+rw "$config_path"
    fi
  fi

  if [[ -e "$config_path" && ! -w "$config_path" ]]; then
    local generated_config="$target_dir/opencode.jsonc"
    echo "OpenCode config $config_path is not writable; copying to $generated_config for Cloudflare MCP defaults."
    mkdir -p "$target_dir"
    if [[ "$config_path" != "$generated_config" ]]; then
      cp "$config_path" "$generated_config"
    fi
    config_path="$generated_config"
    export T3_OPENCODE_CONFIG="$generated_config"
    persist_runtime_env_value T3_OPENCODE_CONFIG "$generated_config"
  fi

  if [[ ! -e "$config_path" ]]; then
    mkdir -p "$(dirname "$config_path")"
    printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$config_path"
  fi

  local sandbox_instructions="${T3_HARNESS_SANDBOX_INSTRUCTIONS:-${T3_OPENCODE_SANDBOX_INSTRUCTIONS:-1}}"
  if [[ -n "${T3_SANDBOX_URL:-}" && "$sandbox_instructions" == "1" ]]; then
    local instructions_file="$target_dir/t3-sandbox-instructions.md"
    install -m 0600 /opt/t3-docker/t3-sandbox-instructions.md "$instructions_file"
    export T3_OPENCODE_SANDBOX_INSTRUCTIONS_FILE="$instructions_file"
  else
    unset T3_OPENCODE_SANDBOX_INSTRUCTIONS_FILE
  fi

  local sandbox_plugin="$target_dir/plugins/t3-sandbox-only.js"
  if [[ "${T3_OPENCODE_SANDBOX_ONLY:-0}" == "1" ]]; then
    mkdir -p "$(dirname "$sandbox_plugin")"
    install -m 0600 /opt/t3-docker/t3-sandbox-only-plugin.js "$sandbox_plugin"
  else
    rm -f "$sandbox_plugin"
  fi

  node /opt/t3-docker/provision-opencode-mcp.mjs "$config_path"

  if [[ "${T3_OPENCODE_MCP_PRESERVE_FILE_GENERATED:-0}" == "1" ]]; then
    rm -f "${T3_OPENCODE_MCP_PRESERVE_FILE:-}"
    unset T3_OPENCODE_MCP_PRESERVE_FILE T3_OPENCODE_MCP_PRESERVE_FILE_GENERATED
  fi
}

provision_optional_config_dir() {
  local label="$1"
  local source="$2"
  local target="$3"
  local enabled="${4:-1}"

  if [[ -z "$source" ]]; then
    return 0
  fi

  if [[ ! -d "$source" ]]; then
    if [[ "$enabled" != "1" ]]; then
      echo "${label} config source points to a missing directory but ${label} is disabled: $source" >&2
      return 0
    fi
    echo "${label} config source points to a missing directory: $source" >&2
    exit 1
  fi

  mkdir -p "$target"
  echo "Syncing ${label} config from $source to $target"
  rsync -a \
    --exclude='node_modules/' \
    --exclude='*.bak*' \
    --exclude='*~' \
    --exclude='.DS_Store' \
    "$source"/ "$target"/

  if [[ -d "$target/tools" ]]; then
    find "$target/tools" -type f \( -name '*.sh' -o -name '*.py' \) -exec chmod u+x {} +
  fi
}

provision_provider_config_dirs() {
  local codex_source="${T3_CODEX_CONFIG_DIR_SOURCE:-}"
  local claude_source="${T3_CLAUDE_CONFIG_DIR_SOURCE:-}"
  local grok_source="${T3_GROK_CONFIG_DIR_SOURCE:-}"

  if [[ -z "$codex_source" && -d /config/codex ]]; then
    codex_source=/config/codex
  fi
  if [[ -z "$claude_source" && -d /config/claude ]]; then
    claude_source=/config/claude
  fi
  if [[ -z "$grok_source" && -d /config/grok ]]; then
    grok_source=/config/grok
  fi

  provision_opencode_config_dir
  provision_opencode_mcp
  provision_optional_config_dir "Codex" "$codex_source" "${CODEX_HOME:-/data/codex}" "${T3_PROVIDER_CODEX:-1}"
  provision_optional_config_dir "Claude" "$claude_source" "${T3_CLAUDE_HOME_PATH:-/data/claude-home}/.claude" "${T3_PROVIDER_CLAUDE:-1}"
  provision_optional_config_dir "Grok" "$grok_source" "${GROK_CONFIG_DIR:-$HOME/.grok}" "${T3_PROVIDER_GROK:-1}"
  python3 /opt/t3-docker/provision-harness-instructions.py
}

install_npm_latest() {
  local enabled="$1"
  local package_name="$2"
  local label="$3"
  local binary_name="${4:-}"

  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  local current_version=""
  local latest_version=""
  local prefix manifest postinstall_script="${5:-}"
  for prefix in "$NPM_CONFIG_PREFIX" /usr/local; do
    manifest="$prefix/lib/node_modules/$package_name/package.json"
    if [[ -f "$manifest" ]]; then
      current_version="$(node -p 'require(process.argv[1]).version' "$manifest" 2>/dev/null || true)"
      if [[ -n "$current_version" ]]; then
        break
      fi
    fi
  done

  if ! latest_version="$(npm view "${package_name}@latest" version 2>/dev/null)" || [[ -z "$latest_version" ]]; then
    echo "Warning: could not resolve $label latest version; continuing with ${current_version:-the bundled binary}." >&2
    if [[ -n "$binary_name" ]] && command -v "$binary_name" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi

  if [[ "$current_version" == "$latest_version" ]]; then
    if [[ -z "$binary_name" ]] || "$binary_name" --version >/dev/null 2>&1; then
      echo "$label is current at $current_version"
      return 0
    fi
    echo "Repairing unusable $label package at current version $current_version"
  fi

  echo "Updating $label package: ${current_version:-not installed} -> $latest_version"
  local -a npm_args=(-g --no-audit --no-fund --dangerously-allow-all-scripts)
  [[ -z "$postinstall_script" ]] || npm_args+=(--include=optional)
  if npm install "${npm_args[@]}" "${package_name}@${latest_version}"; then
    if [[ -n "$postinstall_script" ]]; then
      node "$NPM_CONFIG_PREFIX/lib/node_modules/$package_name/$postinstall_script"
    fi
    if [[ -n "$binary_name" ]]; then
      "$binary_name" --version >/dev/null
    fi
    return 0
  fi

  echo "Warning: failed to update $label package. Falling back to the existing binary if available." >&2
  if [[ -n "$binary_name" ]] && command -v "$binary_name" >/dev/null 2>&1; then
    echo "Continuing with $label at $(command -v "$binary_name")"
    return 0
  fi

  echo "No usable $label binary found after failed update." >&2
  return 1
}

install_cursor_latest() {
  local enabled="$1"
  local installer
  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating Cursor Agent via official installer"
  installer="$(mktemp /tmp/t3-docker/cursor-install.XXXXXX.sh)"
  if curl -fsSL https://cursor.com/install -o "$installer" && HOME="$HOME" NO_COLOR=1 bash "$installer"; then
    rm -f "$installer"
    return 0
  fi
  rm -f "$installer"
  return 1
}

install_grok_latest() {
  local enabled="$1"
  local grok_bin_dir="${GROK_BIN_DIR:-$HOME/.grok/bin}"
  local installer
  if [[ "$enabled" != "1" ]]; then
    return 0
  fi

  echo "Updating Grok Build via official installer"
  installer="$(mktemp /tmp/t3-docker/grok-install.XXXXXX.sh)"
  if curl -fsSL https://x.ai/cli/install.sh -o "$installer" && HOME="$HOME" GROK_BIN_DIR="$grok_bin_dir" bash "$installer"; then
    rm -f "$installer"
  else
    rm -f "$installer"
    return 1
  fi
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
  local ready_url="${T3_OPENCODE_READY_URL:-http://${host}:${port}/global/health}"
  local -a server_env=(env)

  if [[ -n "$config" ]]; then
    server_env+=("OPENCODE_CONFIG=$config")
  fi

  echo "Starting managed OpenCode server on http://${host}:${port}"
  "${server_env[@]}" opencode serve "--hostname=${host}" "--port=${port}" &
  managed_opencode_pid="$!"

  for _ in $(seq 1 30); do
    if ! kill -0 "$managed_opencode_pid" 2>/dev/null; then
      echo "Managed OpenCode server exited before becoming ready." >&2
      wait "$managed_opencode_pid" || true
      exit 1
    fi

    if curl --connect-timeout 1 --max-time 2 -fsS "$ready_url" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.5
  done

  echo "Managed OpenCode server did not answer readiness probe; T3 will still try http://${host}:${port}." >&2
}

cleanup_children() {
  local name pid
  for name in managed_opencode_pid auth_proxy_pid t3_pid; do
    pid="${!name:-}"
    [[ -z "$pid" ]] || kill "$pid" >/dev/null 2>&1 || true
  done
  for name in managed_opencode_pid auth_proxy_pid t3_pid; do
    pid="${!name:-}"
    [[ -z "$pid" ]] || wait "$pid" >/dev/null 2>&1 || true
  done
}

wait_for_supervised_processes() {
  local exit_code=0
  wait -n "$@" || exit_code="$?"
  cleanup_children
  exit "$exit_code"
}

run_t3_headless() {
  local t3_binary=/usr/local/bin/t3
  local upstream_host="$T3_SERVER_HOST"
  local upstream_port="$T3_SERVER_PORT"
  if [[ "${T3_AUTH_PROXY:-0}" == "1" ]]; then
    upstream_host="${T3_AUTH_PROXY_INTERNAL_HOST:-127.0.0.1}"
    upstream_port="${T3_AUTH_PROXY_INTERNAL_PORT:-13773}"
  fi
  local -a args=(
    serve
    --mode web
    --host "$upstream_host"
    --port "$upstream_port"
    --base-dir "$T3CODE_HOME"
  )

  if [[ "${T3_AUTO_BOOTSTRAP_PROJECT_FROM_CWD:-1}" == "1" ]]; then
    args+=(--auto-bootstrap-project-from-cwd)
  fi
  args+=("$T3_WORKDIR")

  if [[ ! -x "$t3_binary" ]]; then
    echo "Pinned T3 binary is missing or not executable: $t3_binary" >&2
    exit 1
  fi

  echo "Starting official T3 headless server on http://${upstream_host}:${upstream_port} with base dir ${T3CODE_HOME} and workspace ${T3_WORKDIR}"
  if [[ "${T3_AUTH_PROXY:-0}" != "1" && -z "${managed_opencode_pid:-}" ]]; then
    exec "$t3_binary" "${args[@]}"
  fi

  "$t3_binary" "${args[@]}" &
  t3_pid="$!"
  if [[ "${T3_AUTH_PROXY:-0}" == "1" ]]; then
    for _ in $(seq 1 60); do
      if ! kill -0 "$t3_pid" 2>/dev/null; then
        echo "T3 exited before its internal endpoint became ready." >&2
        wait "$t3_pid" || true
        exit 1
      fi
      if curl --connect-timeout 1 --max-time 2 -fsS \
        "http://${upstream_host}:${upstream_port}/" >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
    if ! curl --connect-timeout 1 --max-time 2 -fsS \
      "http://${upstream_host}:${upstream_port}/" >/dev/null 2>&1; then
      echo "T3 internal endpoint did not become ready." >&2
      cleanup_children
      exit 1
    fi

    echo "Starting authenticated browser handoff on http://${T3_SERVER_HOST}:${T3_SERVER_PORT}"
    T3_AUTH_PROXY_LISTEN_HOST="$T3_SERVER_HOST" \
      T3_AUTH_PROXY_LISTEN_PORT="$T3_SERVER_PORT" \
      T3_AUTH_PROXY_UPSTREAM_HOST="$upstream_host" \
      T3_AUTH_PROXY_UPSTREAM_PORT="$upstream_port" \
      node /opt/t3-docker/auth-proxy.mjs &
    auth_proxy_pid="$!"
  fi

  trap cleanup_children TERM INT
  local -a supervised_pids=("$t3_pid")
  [[ -z "${auth_proxy_pid:-}" ]] || supervised_pids+=("$auth_proxy_pid")
  [[ -z "${managed_opencode_pid:-}" ]] || supervised_pids+=("$managed_opencode_pid")
  wait_for_supervised_processes "${supervised_pids[@]}"
}

hydrate_github_auth_for_opencode
provision_provider_config_dirs
if [[ "${T3_AUTO_UPDATE_EFFECTIVE:-1}" == "1" ]]; then
  install_npm_latest "${T3_UPDATE_CODEX:-0}" "@openai/codex" "Codex CLI" "codex"
  install_npm_latest "${T3_UPDATE_CLAUDE:-0}" "@anthropic-ai/claude-code" "Claude Code" "claude" "install.cjs"
  install_npm_latest "${T3_UPDATE_OPENCODE:-0}" "opencode-ai" "OpenCode" "opencode"
  install_cursor_latest "${T3_UPDATE_CURSOR:-0}"
  install_grok_latest "${T3_UPDATE_GROK:-0}"
fi

if ! /opt/t3-docker/provision-harness-mcp.sh; then
  echo "Warning: failed to provision one or more harness MCP registrations." >&2
fi

configure_git_safe_directories

start_managed_opencode_server

mkdir -p "$T3_WORKDIR"
cd "$T3_WORKDIR"

run_t3_headless
