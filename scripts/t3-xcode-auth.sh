#!/usr/bin/env bash
set -Eeuo pipefail

host="${1:-${T3_XCODE_SSH_HOST:-}}"
port="${T3_XCODE_SSH_PORT:-22}"
identity="${T3_XCODE_SSH_IDENTITY_FILE:-$HOME/.ssh/t3-xcode}"
known_hosts="${T3_XCODE_SSH_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
remote_root="${T3_XCODE_REMOTE_WORKSPACE_ROOT:-}"
derived_data_root="${T3_XCODE_DERIVED_DATA_ROOT:-}"
enabled_workflows="${T3_XCODE_ENABLED_WORKFLOWS:-}"

if [[ -z "$host" ]]; then
  echo "Usage: t3-xcode-auth <mac-user@mac-host>" >&2
  exit 2
fi
if [[ -z "$remote_root" || "$remote_root" != /* \
  || "$remote_root" == *$'\n'* || "$remote_root" == *$'\r'* ]]; then
  echo "T3_XCODE_REMOTE_WORKSPACE_ROOT must be a single-line absolute Mac path." >&2
  exit 2
fi
if [[ "$derived_data_root" == *$'\n'* || "$derived_data_root" == *$'\r'* \
  || "$enabled_workflows" == *$'\n'* || "$enabled_workflows" == *$'\r'* ]]; then
  echo "Xcode worker settings must be single-line values." >&2
  exit 2
fi

mkdir -p "$(dirname "$identity")" "$(dirname "$known_hosts")"
chmod 0700 "$(dirname "$identity")"
touch "$known_hosts"
chmod 0600 "$known_hosts"

if [[ ! -f "$identity" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "t3-xcode-worker" -f "$identity"
fi

encode() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

echo "The next SSH connection may ask for the Mac account password and host-key confirmation."
ssh \
  -T \
  -p "$port" \
  -o "UserKnownHostsFile=$known_hosts" \
  "$host" \
  bash -s -- \
  "$(encode "$(<"$identity.pub")")" \
  "$(encode "$remote_root")" \
  "$(encode "$derived_data_root")" \
  "$(encode "$enabled_workflows")" <<'REMOTE'
set -Eeuo pipefail
decode() { printf '%s' "$1" | /usr/bin/base64 -D; }

public_key="$(decode "$1")"
remote_root="$(decode "$2")"
derived_data_root="$(decode "$3")"
enabled_workflows="$(decode "$4")"

test -d "$remote_root"
test -x "$HOME/.local/bin/t3-xcode-worker"
test -x "$HOME/.local/bin/t3-xcode-ssh-gate"

umask 077
mkdir -p "$HOME/.ssh" "$HOME/.config/t3-xcode-worker"
touch "$HOME/.ssh/authorized_keys"
filtered="$(mktemp)"
awk '$NF != "t3-xcode-worker"' "$HOME/.ssh/authorized_keys" > "$filtered"
printf 'restrict,command="$HOME/.local/bin/t3-xcode-ssh-gate" %s\n' "$public_key" >> "$filtered"
mv "$filtered" "$HOME/.ssh/authorized_keys"
chmod 0600 "$HOME/.ssh/authorized_keys"
printf '%s\n%s\n%s\n' "$remote_root" "$derived_data_root" "$enabled_workflows" \
  > "$HOME/.config/t3-xcode-worker/ssh-gate.conf"
chmod 0600 "$HOME/.config/t3-xcode-worker/ssh-gate.conf"
REMOTE

ssh \
  -T \
  -i "$identity" \
  -p "$port" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known_hosts" \
  "$host" \
  t3-xcode-check

echo "Xcode worker SSH authentication is ready."
