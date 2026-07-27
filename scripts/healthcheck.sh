#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
fi

port="${T3_SERVER_PORT:-3773}"
curl -fsS "http://127.0.0.1:${port}/" >/dev/null

if [[ "${T3_OPENCODE_MANAGED_SERVER:-0}" == "1" ]]; then
  curl -fsS "http://${T3_OPENCODE_MANAGED_HOST:-127.0.0.1}:${T3_OPENCODE_MANAGED_PORT:-4096}/global/health" >/dev/null
fi
