#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ENV=/tmp/t3-docker/runtime.env
if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
fi

port="${T3_SERVER_PORT:-3773}"
curl -fsS "http://127.0.0.1:${port}/" >/dev/null
