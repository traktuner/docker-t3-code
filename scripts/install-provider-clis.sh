#!/usr/bin/env bash
set -Eeuo pipefail

tmp_dirs=()
cleanup() {
  for dir in "${tmp_dirs[@]}"; do
    rm -rf "$dir"
  done
}
trap cleanup EXIT

install_npm_packages() {
  local npm_cache="${T3_DOCKER_NPM_CACHE_DIR:-/tmp/npm-cache}"
  export NPM_CONFIG_CACHE="$npm_cache"
  export npm_config_cache="$npm_cache"

  npm install -g --prefix /usr/local --no-audit --no-fund --dangerously-allow-all-scripts --include=optional \
    "$@"

  if [[ "${T3_DOCKER_KEEP_NPM_CACHE:-0}" != "1" ]]; then
    npm cache clean --force
    rm -rf "$npm_cache"
  fi
}

install_t3_cli() {
  install_npm_packages "t3@${T3_VERSION:-latest}"
}

install_npm_provider_clis() {
  install_npm_packages \
    "@openai/codex@${CODEX_VERSION:-latest}" \
    "@anthropic-ai/claude-code@${CLAUDE_VERSION:-latest}" \
    "opencode-ai@${OPENCODE_VERSION:-latest}"

  local claude_dir=/usr/local/lib/node_modules/@anthropic-ai/claude-code
  local claude_binary="$claude_dir/bin/claude.exe"
  node "$claude_dir/install.cjs"
  if [[ ! -x "$claude_binary" || "$(stat -c '%s' "$claude_binary")" -lt 4096 ]]; then
    echo "Claude native binary was not installed in the image." >&2
    exit 1
  fi
}

verify_installer() {
  local installer="$1"
  local expected_sha256="$2"
  local name="$3"

  if [[ -z "$expected_sha256" ]]; then
    return
  fi
  printf '%s  %s\n' "$expected_sha256" "$installer" | sha256sum --check --status || {
    echo "$name installer checksum does not match the build input" >&2
    exit 1
  }
}

install_cursor_agent() {
  local cursor_home cursor_bin cursor_dir installer
  cursor_home="$(mktemp -d)"
  tmp_dirs+=("$cursor_home")
  installer="$cursor_home/install.sh"

  curl -fsSL https://cursor.com/install -o "$installer"
  verify_installer "$installer" "${CURSOR_INSTALLER_SHA256:-}" "Cursor Agent"
  HOME="$cursor_home" NO_COLOR=1 bash "$installer"

  cursor_bin="$(readlink -f "$cursor_home/.local/bin/cursor-agent")"
  cursor_dir="$(dirname "$cursor_bin")"
  rm -rf /usr/local/share/cursor-agent/current
  mkdir -p /usr/local/share/cursor-agent
  cp -a "$cursor_dir" /usr/local/share/cursor-agent/current
  ln -sf /usr/local/share/cursor-agent/current/cursor-agent /usr/local/bin/agent
  ln -sf /usr/local/share/cursor-agent/current/cursor-agent /usr/local/bin/cursor-agent
}

install_grok_build() {
  local grok_home grok_bin_dir grok_bin installer
  grok_home="$(mktemp -d)"
  tmp_dirs+=("$grok_home")
  grok_bin_dir="$grok_home/bin"
  installer="$grok_home/install.sh"

  curl -fsSL https://x.ai/cli/install.sh -o "$installer"
  verify_installer "$installer" "${GROK_INSTALLER_SHA256:-}" "Grok Build"
  HOME="$grok_home" GROK_BIN_DIR="$grok_bin_dir" bash "$installer" "${GROK_VERSION:-}"

  grok_bin="$(readlink -f "$grok_bin_dir/grok")"
  install -D -m 0755 "$grok_bin" /usr/local/share/grok-build/grok
  ln -sf /usr/local/share/grok-build/grok /usr/local/bin/grok
}

case "${T3_DOCKER_INSTALL_TARGET:-all}" in
  t3)
    install_t3_cli
    ;;
  providers)
    install_npm_provider_clis
    install_cursor_agent
    install_grok_build
    ;;
  all)
    install_npm_provider_clis
    install_cursor_agent
    install_grok_build
    install_t3_cli
    ;;
  *)
    echo "T3_DOCKER_INSTALL_TARGET must be one of: all, providers, t3" >&2
    exit 2
    ;;
esac
