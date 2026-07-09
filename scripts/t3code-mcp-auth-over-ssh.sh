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

remote_connect_script="$(
  ssh "$ssh_host" 'tmp="$(mktemp /tmp/t3code-mcp-connect.XXXXXX.py)"; cat > "$tmp"; chmod 600 "$tmp"; printf "%s\n" "$tmp"' <<'REMOTE_CONNECT'
import os
import subprocess
import sys

container_name = os.environ.get("T3_CONTAINER_NAME", "t3code")
oauth_port = int(os.environ.get("T3_MCP_OAUTH_PORT", "19876"))

container_pid = subprocess.check_output(
    ["docker", "inspect", "-f", "{{.State.Pid}}", container_name],
    text=True,
).strip()
if not container_pid or container_pid == "0":
    print(f"Container {container_name} is not running.", file=sys.stderr)
    sys.exit(1)

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

os.execvp(
    "nsenter",
    ["nsenter", "-t", container_pid, "-n", "python3", "-c", child_code, str(oauth_port)],
)
REMOTE_CONNECT
)"

remote_auth_script="$(
  ssh "$ssh_host" 'tmp="$(mktemp /tmp/t3code-mcp-auth.XXXXXX.sh)"; cat > "$tmp"; chmod 600 "$tmp"; printf "%s\n" "$tmp"' <<'REMOTE_AUTH'
set -Eeuo pipefail

container_name="${T3_CONTAINER_NAME:-t3code}"
cmd_b64="${T3_CONTAINER_AUTH_CMD_B64:?T3_CONTAINER_AUTH_CMD_B64 is required}"

container_cmd=()
while IFS= read -r -d '' arg; do
  container_cmd+=("$arg")
done < <(printf '%s' "$cmd_b64" | base64 -d)
if [[ "${#container_cmd[@]}" -eq 0 ]]; then
  echo "Decoded container auth command is empty." >&2
  exit 2
fi

docker exec -it "$container_name" "${container_cmd[@]}"
REMOTE_AUTH
)"

cleanup() {
  if [[ -n "${listener_pid:-}" ]]; then
    kill "$listener_pid" >/dev/null 2>&1 || true
    wait "$listener_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${remote_connect_script:-}" || -n "${remote_auth_script:-}" ]]; then
    ssh "$ssh_host" "rm -f $(printf '%q' "$remote_connect_script") $(printf '%q' "$remote_auth_script")" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - "$ssh_host" "$container_name" "$oauth_port" "$remote_connect_script" <<'PY' &
import os
import shlex
import signal
import socket
import subprocess
import sys
import threading

ssh_host, container_name, oauth_port, remote_connect_script = sys.argv[1:5]

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
    remote_command = " ".join(
        [
            "sudo",
            "env",
            f"T3_CONTAINER_NAME={shlex.quote(container_name)}",
            f"T3_MCP_OAUTH_PORT={shlex.quote(oauth_port)}",
            "python3",
            shlex.quote(remote_connect_script),
        ],
    )
    proc = subprocess.Popen(
        ["ssh", ssh_host, remote_command],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def write_child(data):
        proc.stdin.write(data)
        proc.stdin.flush()

    def write_client(data):
        client.sendall(data)

    def drain_stderr():
        for line in proc.stderr:
            sys.stderr.buffer.write(line)
            sys.stderr.buffer.flush()

    threads = [
        threading.Thread(target=relay_stream, args=(client, write_child, proc.stdin.close), daemon=True),
        threading.Thread(target=relay_stream, args=(proc.stdout, write_client, client.close), daemon=True),
        threading.Thread(target=drain_stderr, daemon=True),
    ]
    for thread in threads:
        thread.start()
    for thread in threads[:2]:
        thread.join()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(oauth_port)))
listener.listen(16)
print(
    f"Forwarding local 127.0.0.1:{oauth_port} into {container_name} on {ssh_host} without SSH TCP forwarding",
    flush=True,
)

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

listener_pid="$!"
sleep 1
if ! kill -0 "$listener_pid" >/dev/null 2>&1; then
  wait "$listener_pid"
fi

ssh -tt "$ssh_host" \
  "sudo env T3_CONTAINER_NAME=$(printf '%q' "$container_name") T3_CONTAINER_AUTH_CMD_B64=$(printf '%q' "$cmd_b64") bash $(printf '%q' "$remote_auth_script")"
