#!/usr/bin/env bash
set -Eeuo pipefail

persisted="${NPM_CONFIG_PREFIX:-/data/npm-global}/bin/claude"
bundled=/usr/local/bin/claude

if [[ -x "$persisted" ]] && "$persisted" --version >/dev/null 2>&1; then
  exec "$persisted" "$@"
fi

exec "$bundled" "$@"
