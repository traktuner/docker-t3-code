#!/usr/bin/env bash
set -Eeuo pipefail

data_root="${T3_ISSUE_WORKER_DATA_ROOT:-/data/issue-worker}"
config_source="${T3_ISSUE_WORKER_OPENCODE_CONFIG_SOURCE:-/config/opencode}"
export HOME="${T3_ISSUE_WORKER_HOME:-$data_root/home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$data_root/npm-global}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$data_root/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export T3_SANDBOX_LOCK_WORKSPACE="${T3_SANDBOX_LOCK_WORKSPACE:-1}"
export PATH="$NPM_CONFIG_PREFIX/bin:$HOME/.local/bin:$PATH"

mkdir -p \
  "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" \
  "$OPENCODE_CONFIG_DIR" "$NPM_CONFIG_PREFIX" "$NPM_CONFIG_CACHE" \
  "$data_root/jobs" "$data_root/mirrors"

if [[ -z "${T3_ISSUE_WORKER_GITHUB_TOKEN:-}" && -n "${T3_ISSUE_WORKER_GITHUB_TOKEN_FILE:-}" ]]; then
  [[ -r "$T3_ISSUE_WORKER_GITHUB_TOKEN_FILE" ]] || {
    echo "T3_ISSUE_WORKER_GITHUB_TOKEN_FILE is not readable" >&2
    exit 1
  }
  T3_ISSUE_WORKER_GITHUB_TOKEN="$(<"$T3_ISSUE_WORKER_GITHUB_TOKEN_FILE")"
  export T3_ISSUE_WORKER_GITHUB_TOKEN
fi

if [[ -z "${T3_SANDBOX_TOKEN:-}" && -n "${T3_SANDBOX_TOKEN_FILE:-}" ]]; then
  [[ -r "$T3_SANDBOX_TOKEN_FILE" ]] || {
    echo "T3_SANDBOX_TOKEN_FILE is not readable" >&2
    exit 1
  }
  T3_SANDBOX_TOKEN="$(<"$T3_SANDBOX_TOKEN_FILE")"
  export T3_SANDBOX_TOKEN
fi

[[ -n "${T3_ISSUE_WORKER_GITHUB_TOKEN:-}" ]] || {
  echo "T3_ISSUE_WORKER_GITHUB_TOKEN or its file variant is required" >&2
  exit 1
}
[[ -n "${LUMO_API_KEY:-}" ]] || {
  echo "LUMO_API_KEY is required by the default issue-worker model" >&2
  exit 1
}
[[ -n "${T3_SANDBOX_URL:-}" && -n "${T3_SANDBOX_TOKEN:-}" ]] || {
  echo "T3_SANDBOX_URL and T3_SANDBOX_TOKEN (or its file variant) are required" >&2
  exit 1
}
[[ -d "$config_source" ]] || {
  echo "OpenCode config source is missing: $config_source" >&2
  exit 1
}

# Preserve config metadata without attempting owner/group changes as the non-root worker.
rsync -rlpt --delete \
  --exclude='node_modules/' \
  --exclude='*.bak*' \
  --exclude='*~' \
  --exclude='.DS_Store' \
  "$config_source"/ "$OPENCODE_CONFIG_DIR"/

install -D -m 0600 \
  /opt/t3-docker/github-issue-worker-agent.md \
  "$OPENCODE_CONFIG_DIR/agents/github-issue-worker.md"

if [[ -d "$OPENCODE_CONFIG_DIR/tools" ]]; then
  find "$OPENCODE_CONFIG_DIR/tools" -type f \( -name '*.sh' -o -name '*.py' \) -exec chmod u+x {} +
fi

if [[ -f "$OPENCODE_CONFIG_DIR/package.json" ]]; then
  digest_files=("$OPENCODE_CONFIG_DIR/package.json")
  [[ ! -f "$OPENCODE_CONFIG_DIR/package-lock.json" ]] || digest_files+=("$OPENCODE_CONFIG_DIR/package-lock.json")
  digest="$(sha256sum "${digest_files[@]}" | sha256sum | awk '{print $1}')"
  stamp="$OPENCODE_CONFIG_DIR/node_modules/.t3-issue-worker-deps.sha256"
  if [[ ! -f "$stamp" || "$(<"$stamp")" != "$digest" ]]; then
    env \
      -u T3_ISSUE_WORKER_GITHUB_TOKEN \
      -u T3_ISSUE_WORKER_GITHUB_TOKEN_FILE \
      -u LUMO_API_KEY \
      -u T3_SANDBOX_TOKEN \
      -u T3_SANDBOX_TOKEN_FILE \
      npm install --prefix "$OPENCODE_CONFIG_DIR" --omit=dev --no-audit --no-fund
    mkdir -p "$(dirname "$stamp")"
    printf '%s\n' "$digest" > "$stamp"
  fi
fi

config_path=""
for candidate in "$OPENCODE_CONFIG_DIR/opencode.jsonc" "$OPENCODE_CONFIG_DIR/opencode.json"; do
  if [[ -f "$candidate" ]]; then
    config_path="$candidate"
    break
  fi
done
if [[ -z "$config_path" ]]; then
  config_path="$OPENCODE_CONFIG_DIR/opencode.jsonc"
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$config_path"
fi

export T3_OPENCODE_CONFIG="$config_path"
export T3_OPENCODE_CLOUDFLARE_MCP=off
export T3_OPENCODE_MCP_PRESETS=""
export T3_SANDBOX_MCP_RECONCILE=1
node /opt/t3-docker/provision-opencode-mcp.mjs "$config_path"

if [[ -n "${T3_SANDBOX_URL:-}" ]]; then
  until curl -fsS --max-time 3 "${T3_SANDBOX_URL%/}/health" >/dev/null; do
    echo "Waiting for the T3 sandbox gateway..."
    sleep 5
  done
fi

exec node /opt/t3-docker/github-issue-worker.mjs "$@"
