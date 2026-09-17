#!/usr/bin/env bash
set -Eeuo pipefail

bootstrap="${T3_CONFIG_BOOTSTRAP:-}"
scope="${1:?bootstrap scope is required}"

[[ -z "$bootstrap" ]] && exit 0
if [[ "$bootstrap" != /* || ! -f "$bootstrap" || ! -r "$bootstrap" ]]; then
  echo "T3_CONFIG_BOOTSTRAP must be an absolute path to a readable regular file: $bootstrap" >&2
  exit 1
fi

echo "Running operator configuration bootstrap for $scope"
bash "$bootstrap" "$scope"
