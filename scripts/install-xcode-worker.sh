#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${T3_XCODE_BIN_DIR:-$HOME/.local/bin}"
launch_agents_dir="$HOME/Library/LaunchAgents"
label="at.traktuner.t3-xcode-worker-update"
plist="$launch_agents_dir/$label.plist"
version="${XCODEBUILDMCP_VERSION:-2.6.2}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer must run on the Mac that owns Xcode." >&2
  exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Select a full Xcode installation with xcode-select before installing." >&2
  exit 1
fi

XCODEBUILDMCP_VERSION="$version" "$script_dir/update-xcode-worker.sh"
mkdir -p "$bin_dir"
install -m 0755 "$script_dir/t3-xcode-worker" "$bin_dir/t3-xcode-worker"
install -m 0755 "$script_dir/t3-xcode-ssh-gate" "$bin_dir/t3-xcode-ssh-gate"
install -m 0755 "$script_dir/update-xcode-worker.sh" "$bin_dir/t3-xcode-worker-update"

if [[ "${1:-}" == "--install-launch-agent" ]]; then
  mkdir -p "$launch_agents_dir"
  escaped_home="${HOME//&/\\&}"
  sed "s|@@HOME@@|$escaped_home|g" "$script_dir/xcode-worker-update.plist.template" > "$plist"
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$label"
fi

echo "Xcode worker installed at $bin_dir/t3-xcode-worker"
echo "DerivedData default: $HOME/Developer/xcode"
