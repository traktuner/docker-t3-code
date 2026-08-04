#!/usr/bin/env bash
set -Eeuo pipefail

sandbox_enabled=0
xcode_enabled=0
github_enabled=0
[[ -n "${T3_SANDBOX_URL:-}" && -n "${T3_SANDBOX_TOKEN:-}" ]] && sandbox_enabled=1
[[ -n "${T3_XCODE_SSH_HOST:-}" && -n "${T3_XCODE_REMOTE_WORKSPACE_ROOT:-}" ]] && xcode_enabled=1
github_presets="${T3_OPENCODE_MCP_PRESETS:-}"
github_presets="${github_presets//[[:space:]]/}"
if [[ ",${github_presets,,}," == *",github,"* ]] \
  && [[ -n "${GITHUB_PERSONAL_ACCESS_TOKEN:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  github_enabled=1
fi
reconcile="${T3_HARNESS_MCP_RECONCILE:-${T3_SANDBOX_MCP_RECONCILE:-1}}"
export T3_SANDBOX_MCP_RECONCILE="$reconcile"
if [[ "$sandbox_enabled" == "0" && "$github_enabled" == "0" && "$xcode_enabled" == "0" && "$reconcile" != "1" ]]; then
  exit 0
fi

provision_codex() {
  [[ "${T3_PROVIDER_CODEX:-1}" == "1" ]] || return 0
  command -v codex >/dev/null 2>&1 || return 0

  if [[ "$reconcile" == "1" ]]; then
    codex mcp remove t3-sandbox >/dev/null 2>&1 || true
    codex mcp remove github >/dev/null 2>&1 || true
    codex mcp remove xcodebuild >/dev/null 2>&1 || true
  fi

  if [[ "$github_enabled" == "1" ]]; then
    if ! codex mcp get github >/dev/null 2>&1 \
      && ! codex mcp add github -- t3-github-mcp >/dev/null; then
      echo "Warning: could not register GitHub MCP in Codex." >&2
    fi
  fi

  if [[ "$sandbox_enabled" == "1" ]]; then
    if ! codex mcp get t3-sandbox >/dev/null 2>&1 \
      && ! codex mcp add t3-sandbox -- t3-sandbox-mcp >/dev/null; then
      echo "Warning: could not register t3-sandbox MCP in Codex." >&2
    fi
  fi

  if [[ "$xcode_enabled" == "1" ]]; then
    if ! codex mcp get xcodebuild >/dev/null 2>&1 \
      && ! codex mcp add xcodebuild -- t3-xcode-mcp >/dev/null; then
      echo "Warning: could not register XcodeBuildMCP in Codex." >&2
    fi
  fi

  if ! /opt/t3-docker/configure-codex-mcp.py; then
    echo "Warning: could not apply Codex MCP timeouts." >&2
  fi
}

provision_claude() {
  [[ "${T3_PROVIDER_CLAUDE:-1}" == "1" ]] || return 0
  command -v claude >/dev/null 2>&1 || return 0

  local claude_home="${T3_CLAUDE_HOME_PATH:-/data/claude-home}"
  mkdir -p "$claude_home"
  if [[ "$reconcile" == "1" ]]; then
    HOME="$claude_home" claude mcp remove --scope user t3-sandbox >/dev/null 2>&1 || true
    HOME="$claude_home" claude mcp remove --scope user github >/dev/null 2>&1 || true
    HOME="$claude_home" claude mcp remove --scope user xcodebuild >/dev/null 2>&1 || true
  fi

  if [[ "$github_enabled" == "1" ]]; then
    if ! HOME="$claude_home" claude mcp get github >/dev/null 2>&1 \
      && ! HOME="$claude_home" claude mcp add --scope user github -- t3-github-mcp >/dev/null; then
      echo "Warning: could not register GitHub MCP in Claude Code." >&2
    fi
  fi

  if [[ "$sandbox_enabled" == "1" ]]; then
    if ! HOME="$claude_home" claude mcp get t3-sandbox >/dev/null 2>&1 \
      && ! HOME="$claude_home" claude mcp add --scope user t3-sandbox -- t3-sandbox-mcp >/dev/null; then
      echo "Warning: could not register t3-sandbox MCP in Claude Code." >&2
    fi
  fi

  if [[ "$xcode_enabled" == "1" ]]; then
    if ! HOME="$claude_home" claude mcp get xcodebuild >/dev/null 2>&1 \
      && ! HOME="$claude_home" claude mcp add --scope user xcodebuild -- t3-xcode-mcp >/dev/null; then
      echo "Warning: could not register XcodeBuildMCP in Claude Code." >&2
    fi
  fi
}

provision_cursor() {
  [[ "${T3_PROVIDER_CURSOR:-1}" == "1" ]] || return 0
  command -v agent >/dev/null 2>&1 || return 0

  if ! /opt/t3-docker/configure-cursor-mcp.mjs; then
    echo "Warning: could not reconcile Cursor Agent MCP configuration." >&2
  fi
}

provision_grok() {
  [[ "${T3_PROVIDER_GROK:-1}" == "1" ]] || return 0
  command -v grok >/dev/null 2>&1 || return 0

  local grok_home="${T3_GROK_HOME_PATH:-/data/home}"
  if [[ "$reconcile" == "1" ]]; then
    HOME="$grok_home" grok mcp remove t3-sandbox >/dev/null 2>&1 || true
    HOME="$grok_home" grok mcp remove github >/dev/null 2>&1 || true
    HOME="$grok_home" grok mcp remove xcodebuild >/dev/null 2>&1 || true
  fi
  if [[ "$github_enabled" == "1" ]] \
    && ! HOME="$grok_home" grok mcp add github -- t3-github-mcp >/dev/null; then
    echo "Warning: could not register GitHub MCP in Grok Build." >&2
  fi

  if [[ "$sandbox_enabled" == "1" ]] \
    && ! HOME="$grok_home" grok mcp add t3-sandbox -- t3-sandbox-mcp >/dev/null; then
    echo "Warning: could not register t3-sandbox MCP in Grok Build." >&2
  fi
  if [[ "$xcode_enabled" == "1" ]] \
    && ! HOME="$grok_home" grok mcp add xcodebuild -- t3-xcode-mcp >/dev/null; then
    echo "Warning: could not register XcodeBuildMCP in Grok Build." >&2
  fi
}

provision_codex
provision_claude
provision_cursor
provision_grok
