#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${T3_AGENT_RACK:-1}" == "1" ]] || exit 0

if ! command -v agent-rack >/dev/null 2>&1; then
  echo "Warning: agent-rack is not installed; skipping agent-rack provisioning." >&2
  exit 0
fi

config_path="${AGENT_RACK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-rack/config.json}"

warn() {
  echo "Warning: $1" >&2
}

if ! /opt/t3-docker/provision-agent-rack-config.mjs "$config_path"; then
  warn "could not write the agent-rack configuration at $config_path."
  exit 0
fi

# The canonical policy asset is mounted by the infra pre-deploy role. It
# patches exactly agent-rack@0.12.1 to add the synchronous parallel join tool
# and makes detached-session no-callback semantics explicit. The image grants
# the t3 user write access only to this one installed source file.
join_patcher="$(dirname "$config_path")/agent-rack-join-patch.mjs"
if [[ ! -f "$join_patcher" ]]; then
  warn "agent-rack join patch is missing: $join_patcher"
  exit 1
fi
if ! node "$join_patcher"; then
  warn "could not apply the agent-rack synchronous parallel join patch."
  exit 1
fi

if ! agent-rack config-check -c "$config_path"; then
  warn "the agent-rack configuration at $config_path failed validation."
fi

# Runs the stock `agent-rack install --target <target>` and treats an
# "already exists" rejection as success so restarts stay idempotent.
run_stock_install() {
  local target="$1"
  local scope="${2:-}"
  local output status

  if [[ -n "$scope" ]]; then
    output="$(agent-rack install --target "$target" --scope "$scope" 2>&1)" && status=0 || status=$?
  else
    output="$(agent-rack install --target "$target" 2>&1)" && status=0 || status=$?
  fi
  if [[ "$status" -ne 0 ]] && ! grep -qi "already exist" <<<"$output"; then
    warn "could not register agent-rack with $target (${scope:-default scope})."
    return 1
  fi
  return 0
}

if ! codex mcp get agent-rack >/dev/null 2>&1; then
  run_stock_install codex
fi

# `opencode mcp list` always exits 0, so probe its output instead of the code.
if ! opencode mcp list 2>/dev/null | grep -q "agent-rack"; then
  run_stock_install opencode
fi

# Claude runs with a dedicated HOME, so both the registration probe and the
# stock installer must run inside that HOME to target the same user scope.
claude_home="${T3_CLAUDE_HOME_PATH:-/data/claude-home}"
mkdir -p "$claude_home"
if ! HOME="$claude_home" claude mcp get agent-rack >/dev/null 2>&1; then
  output="$(HOME="$claude_home" agent-rack install --target claude --scope user 2>&1)" && status=0 || status=$?
  if [[ "$status" -ne 0 ]] && ! grep -qi "already exist" <<<"$output"; then
    warn "could not register agent-rack with Claude Code."
  fi
fi

# Stock `agent-rack cp --target codex` writes to $HOME/.codex/skills and ignores
# CODEX_HOME, so it would land outside /data/codex in this container. Codex skill
# distribution is therefore not automated here.
HOME="$claude_home" agent-rack cp --target claude --scope user >/dev/null 2>&1 \
  || warn "could not copy agent-rack skills for Claude Code."
agent-rack cp --target opencode --scope user >/dev/null 2>&1 \
  || warn "could not copy agent-rack skills for OpenCode."

exit 0
