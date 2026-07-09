#!/usr/bin/env bash
set -Eeuo pipefail

tmp_dirs=()
cleanup() {
  for dir in "${tmp_dirs[@]}"; do
    rm -rf "$dir"
  done
}
trap cleanup EXIT

new_tmp_dir() {
  local dir
  dir="$(mktemp -d)"
  tmp_dirs+=("$dir")
  printf '%s\n' "$dir"
}

install_npm_clis() {
  export NPM_CONFIG_CACHE=/tmp/npm-cache
  export npm_config_cache=/tmp/npm-cache
  local t3_package="t3@${T3_VERSION:-latest}"

  npm install -g --prefix /usr/local --no-audit --no-fund \
    "$t3_package" \
    @openai/codex \
    @anthropic-ai/claude-code \
    opencode-ai
  npm cache clean --force
  rm -rf /tmp/npm-cache
}

install_cursor_agent() {
  local cursor_home cursor_bin cursor_dir
  cursor_home="$(new_tmp_dir)"

  HOME="$cursor_home" NO_COLOR=1 bash -c 'curl -fsSL https://cursor.com/install | bash'

  cursor_bin="$(readlink -f "$cursor_home/.local/bin/cursor-agent")"
  cursor_dir="$(dirname "$cursor_bin")"
  rm -rf /usr/local/share/cursor-agent/current
  mkdir -p /usr/local/share/cursor-agent
  cp -a "$cursor_dir" /usr/local/share/cursor-agent/current
  ln -sf /usr/local/share/cursor-agent/current/cursor-agent /usr/local/bin/agent
  ln -sf /usr/local/share/cursor-agent/current/cursor-agent /usr/local/bin/cursor-agent
}

install_grok_build() {
  local grok_home grok_bin_dir grok_bin
  grok_home="$(new_tmp_dir)"
  grok_bin_dir="$grok_home/bin"

  HOME="$grok_home" GROK_BIN_DIR="$grok_bin_dir" bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash'

  grok_bin="$(readlink -f "$grok_bin_dir/grok")"
  install -D -m 0755 "$grok_bin" /usr/local/share/grok-build/grok
  ln -sf /usr/local/share/grok-build/grok /usr/local/bin/grok
}

install_npm_clis
install_cursor_agent
install_grok_build
