#!/usr/bin/env bash
set -Eeuo pipefail

config_output="${T3_SANDBOX_CONFIG_OUTPUT:-/run/opensandbox-config/config.toml}"
secret_dir="${T3_SANDBOX_SECRET_DIR:-/run/t3-sandbox-secrets}"
cache_root="${T3_SANDBOX_CACHE_ROOT:-/cache}"
sandbox_uid="${T3_SANDBOX_UID:-1000}"
sandbox_gid="${T3_SANDBOX_GID:-1000}"

write_secret() {
  local file="$1"
  local value="${2:-}"
  local owner="$3"

  if [[ ! -s "$file" ]]; then
    umask 077
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value" > "${file}.tmp"
    else
      head -c 48 /dev/urandom | base64 > "${file}.tmp"
    fi
    mv "${file}.tmp" "$file"
  fi
  if ! chown "$owner" "$file" || ! chmod 0400 "$file"; then
    if [[ -r "$file" ]]; then
      echo "Warning: preserving readable secret on a read-only mount: $file" >&2
      return 0
    fi
    echo "Secret is not readable: $file" >&2
    return 1
  fi
}

install -d -m 0755 "$(dirname "$config_output")" "$secret_dir"
install -d -m 0777 "$cache_root/bin" "$cache_root/workspaces"

write_secret \
  "$secret_dir/gateway-token" \
  "${T3_SANDBOX_GATEWAY_TOKEN:-}" \
  "${sandbox_uid}:${sandbox_gid}"
write_secret \
  "$secret_dir/opensandbox-api-key" \
  "${OPEN_SANDBOX_API_KEY:-}" \
  "0:0"

/opt/t3-sandbox/render-opensandbox-config.py \
  /opt/t3-sandbox/opensandbox.toml \
  "$config_output"

exec "$@"
