#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  t3-auth codex login          # ChatGPT/Codex included usage via device auth
  t3-auth codex access-token   # persist CODEX_ACCESS_TOKEN from env
  t3-auth codex api-key        # persist OPENAI_API_KEY, API-billed
  t3-auth codex status

  t3-auth claude login         # Claude subscription auth
  t3-auth claude setup-token   # generate CLAUDE_CODE_OAUTH_TOKEN for Proton Pass
  t3-auth claude status
  t3-auth claude env           # report env-based Claude auth presence

  t3-auth grok login           # xAI/Grok included usage via device auth
  t3-auth grok env             # report env-based Grok auth presence

API keys are intentionally not the default login path because they normally use
API billing instead of included subscription usage.
USAGE
}

provider="${1:-}"
action="${2:-login}"

case "$provider" in
  codex)
    export CODEX_HOME="${CODEX_HOME:-/data/codex}"
    mkdir -p "$CODEX_HOME"
    case "$action" in
      login)
        exec codex login --device-auth
        ;;
      access-token)
        if [[ -z "${CODEX_ACCESS_TOKEN:-}" ]]; then
          echo "CODEX_ACCESS_TOKEN is not set." >&2
          exit 1
        fi
        printenv CODEX_ACCESS_TOKEN | exec codex login --with-access-token
        ;;
      api-key)
        if [[ -z "${OPENAI_API_KEY:-}" ]]; then
          echo "OPENAI_API_KEY is not set." >&2
          exit 1
        fi
        printenv OPENAI_API_KEY | exec codex login --with-api-key
        ;;
      status)
        exec codex login status
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  claude)
    export HOME="${T3_CLAUDE_HOME_PATH:-/data/claude-home}"
    mkdir -p "$HOME"
    case "$action" in
      login)
        exec claude auth login
        ;;
      setup-token)
        exec claude setup-token
        ;;
      status)
        exec claude auth status
        ;;
      env)
        if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
          echo "CLAUDE_CODE_OAUTH_TOKEN is set; Claude Code can use subscription-backed OAuth."
        elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
          echo "ANTHROPIC_API_KEY is set; Claude Code will use API billing."
        elif [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
          echo "ANTHROPIC_AUTH_TOKEN is set."
        else
          echo "No Claude env auth found. Use t3-auth claude login or t3-auth claude setup-token."
          exit 1
        fi
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  grok)
    export HOME="${HOME:-/data/home}"
    export GROK_CONFIG_DIR="${GROK_CONFIG_DIR:-$HOME/.grok}"
    mkdir -p "$GROK_CONFIG_DIR"
    case "$action" in
      login)
        exec grok login --device-auth
        ;;
      env)
        if [[ -n "${XAI_API_KEY:-}" ]]; then
          echo "XAI_API_KEY is set; Grok will use API-key auth."
        elif [[ -n "${GROK_DEPLOYMENT_KEY:-}" ]]; then
          echo "GROK_DEPLOYMENT_KEY is set."
        else
          echo "No Grok env auth found. Use t3-auth grok login for device auth."
          exit 1
        fi
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
