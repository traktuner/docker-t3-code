#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/t3code-mcp-auth-over-ssh.sh [ssh-host] [mcp-server]
  bash scripts/t3code-mcp-auth-over-ssh.sh [ssh-host] -- <container-auth-command...>

Examples:
  bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 cloudflare
  bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 cloudflare-bindings
  bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 -- t3-auth opencode mcp-auth cloudflare
  bash scripts/t3code-mcp-auth-over-ssh.sh slvpdocker01 -- codex mcp login cloudflare

Environment:
  T3_CONTAINER_NAME=t3code
  T3_MCP_OAUTH_PORT=19876
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ssh_host="slvpdocker01"
if [[ $# -gt 0 && "${1:-}" != "--" ]]; then
  ssh_host="$1"
  shift
fi

container_name="${T3_CONTAINER_NAME:-t3code}"
oauth_port="${T3_MCP_OAUTH_PORT:-${T3_OPENCODE_MCP_OAUTH_PORT:-19876}}"
container_cmd=()

if [[ "${1:-}" == "--" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "Missing container auth command after --." >&2
    usage >&2
    exit 2
  fi
  container_cmd=("$@")
else
  mcp_server="${1:-cloudflare}"
  container_cmd=(opencode mcp auth "$mcp_server")
fi

cmd_b64="$(printf '%s\0' "${container_cmd[@]}" | base64 | tr -d '\n')"

remote_script="$(
  ssh "$ssh_host" 'tmp="$(mktemp /tmp/t3code-mcp-auth.XXXXXX.sh)"; cat > "$tmp"; chmod 700 "$tmp"; printf "%s\n" "$tmp"' <<'REMOTE'
set -Eeuo pipefail

container_name="${T3_CONTAINER_NAME:-t3code}"
oauth_port="${T3_MCP_OAUTH_PORT:-19876}"
cmd_b64="${T3_CONTAINER_AUTH_CMD_B64:?T3_CONTAINER_AUTH_CMD_B64 is required}"

container_pid="$(docker inspect -f '{{.State.Pid}}' "$container_name")"
if [[ -z "$container_pid" || "$container_pid" == "0" ]]; then
  echo "Container $container_name is not running." >&2
  exit 1
fi

python3 - "$container_pid" "$oauth_port" <<'PY' &
import os
import signal
import socket
import subprocess
import sys
import threading

container_pid = sys.argv[1]
oauth_port = int(sys.argv[2])

child_code = r'''
import os
import select
import socket
import sys

port = int(sys.argv[1])
sock = socket.create_connection(("127.0.0.1", port))
stdin = sys.stdin.buffer

while True:
    readable, _, _ = select.select([stdin, sock], [], [])
    if stdin in readable:
        data = os.read(0, 65536)
        if not data:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        else:
            sock.sendall(data)
    if sock in readable:
        data = sock.recv(65536)
        if not data:
            break
        os.write(1, data)
'''

def relay_stream(src, write_fn, close_fn=None):
    try:
        while True:
            data = src.recv(65536) if hasattr(src, "recv") else src.read(65536)
            if not data:
                break
            write_fn(data)
    finally:
        if close_fn:
            try:
                close_fn()
            except Exception:
                pass

def handle_client(client):
    proc = subprocess.Popen(
        ["nsenter", "-t", container_pid, "-n", "python3", "-c", child_code, str(oauth_port)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def write_child(data):
        proc.stdin.write(data)
        proc.stdin.flush()

    def write_client(data):
        client.sendall(data)

    threads = [
        threading.Thread(target=relay_stream, args=(client, write_child, proc.stdin.close), daemon=True),
        threading.Thread(target=relay_stream, args=(proc.stdout, write_client, client.close), daemon=True),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    proc.wait(timeout=10)

listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", oauth_port))
listener.listen(16)
print(f"Forwarding 127.0.0.1:{oauth_port} on host into container netns {container_pid}", flush=True)

def stop(_signum, _frame):
    listener.close()
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

while True:
    try:
        client, _addr = listener.accept()
    except OSError:
        break
    threading.Thread(target=handle_client, args=(client,), daemon=True).start()
PY

forwarder_pid="$!"
cleanup() {
  kill "$forwarder_pid" >/dev/null 2>&1 || true
  wait "$forwarder_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

container_cmd=()
while IFS= read -r -d '' arg; do
  container_cmd+=("$arg")
done < <(printf '%s' "$cmd_b64" | base64 -d)
if [[ "${#container_cmd[@]}" -eq 0 ]]; then
  echo "Decoded container auth command is empty." >&2
  exit 2
fi

sleep 1
docker exec -it "$container_name" "${container_cmd[@]}"
REMOTE
)"

cleanup_remote_script() {
  if [[ -n "${remote_script:-}" ]]; then
    ssh "$ssh_host" "rm -f $(printf '%q' "$remote_script")" >/dev/null 2>&1 || true
  fi
}
trap cleanup_remote_script EXIT

ssh -o ExitOnForwardFailure=yes \
  -L "${oauth_port}:127.0.0.1:${oauth_port}" \
  -tt "$ssh_host" \
  "sudo env T3_CONTAINER_NAME=$(printf '%q' "$container_name") T3_MCP_OAUTH_PORT=$(printf '%q' "$oauth_port") T3_CONTAINER_AUTH_CMD_B64=$(printf '%q' "$cmd_b64") bash $(printf '%q' "$remote_script")"
