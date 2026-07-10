#!/usr/bin/env bash
set -Eeuo pipefail

case "${1:-}" in
  *sername*)
    printf '%s\n' "${T3_GIT_USERNAME:-x-access-token}"
    ;;
  *)
    printf '%s\n' "${T3_GIT_PASSWORD:?T3_GIT_PASSWORD is required}"
    ;;
esac
