#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
fi

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

  t3-auth gh login             # GitHub CLI browser/device auth
  t3-auth gh token             # persist GH_TOKEN or GITHUB_TOKEN
  t3-auth gh status
  t3-auth gh setup-git         # configure git credential integration
  t3-auth gh logout

  t3-auth opencode mcp-list
  t3-auth opencode mcp-auth cloudflare
  t3-auth opencode mcp-debug cloudflare
  t3-auth opencode mcp-logout cloudflare

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
  gh|github)
    export HOME="${HOME:-/data/home}"
    export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
    mkdir -p "$XDG_CONFIG_HOME/gh" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
    gh_host="${GH_HOST:-${GITHUB_HOST:-github.com}}"
    gh_git_protocol="${GH_GIT_PROTOCOL:-ssh}"
    case "$action" in
      login)
        exec gh auth login --hostname "$gh_host" --git-protocol "$gh_git_protocol" --web
        ;;
      token|with-token)
        if [[ -n "${GH_TOKEN:-}" ]]; then
          printenv GH_TOKEN | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --hostname "$gh_host" --with-token
          exit $?
        elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
          printenv GITHUB_TOKEN | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --hostname "$gh_host" --with-token
          exit $?
        else
          echo "GH_TOKEN or GITHUB_TOKEN is not set." >&2
          exit 1
        fi
        ;;
      status)
        exec gh auth status --hostname "$gh_host"
        ;;
      setup-git)
        exec gh auth setup-git --hostname "$gh_host"
        ;;
      logout)
        exec gh auth logout --hostname "$gh_host"
        ;;
      env)
        if [[ -n "${GH_TOKEN:-}" ]]; then
          echo "GH_TOKEN is set; gh can use env-based auth."
        elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
          echo "GITHUB_TOKEN is set; gh can use env-based auth."
        else
          echo "No GitHub env auth found. Use t3-auth gh login or t3-auth gh token."
          exit 1
        fi
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  opencode)
    export HOME="${HOME:-/data/home}"
    export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
    export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/opencode}"
    if [[ -n "${T3_OPENCODE_CONFIG:-}" ]]; then
      export OPENCODE_CONFIG="$T3_OPENCODE_CONFIG"
    fi
    mkdir -p "$OPENCODE_CONFIG_DIR" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
    mcp_server="${3:-cloudflare}"
    case "$action" in
      mcp-list)
        exec opencode mcp list
        ;;
      mcp-auth)
        exec opencode mcp auth "$mcp_server"
        ;;
      mcp-debug)
        exec opencode mcp debug "$mcp_server"
        ;;
      mcp-logout)
        exec opencode mcp logout "$mcp_server"
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
