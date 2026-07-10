#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import stat
import sys
import tomllib
from pathlib import Path


def integer(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if value < minimum:
        raise SystemExit(f"{name} must be at least {minimum}")
    return value


def text(name: str, default: str) -> str:
    value = os.environ.get(name, default).strip()
    if not value or "\n" in value or "\r" in value:
        raise SystemExit(f"{name} must be a non-empty single-line value")
    return value


def secure_runtime_config() -> str:
    runtime = os.environ.get("T3_SANDBOX_SECURE_RUNTIME", "").strip().lower()
    if not runtime:
        return ""
    if runtime not in {"gvisor", "kata"}:
        raise SystemExit("T3_SANDBOX_SECURE_RUNTIME must be empty, gvisor, or kata")
    docker_runtime = text("T3_SANDBOX_DOCKER_RUNTIME", "runsc" if runtime == "gvisor" else "kata")
    return (
        "[secure_runtime]\n"
        f"type = {json.dumps(runtime)}\n"
        f"docker_runtime = {json.dumps(docker_runtime)}"
    )


def docker_host_ip_config(runtime_network: str) -> str:
    if runtime_network != "bridge":
        return ""
    host_ip = text("T3_SANDBOX_DOCKER_HOST_IP", "host.docker.internal")
    return f"host_ip = {json.dumps(host_ip)}"


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-opensandbox-config.py TEMPLATE OUTPUT")
    template_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    host_root = Path(text("T3_SANDBOX_HOST_WORKSPACE_ROOT", "/workspaces"))
    if not host_root.is_absolute():
        raise SystemExit("T3_SANDBOX_HOST_WORKSPACE_ROOT must be absolute")

    port_min = integer("T3_SANDBOX_PORT_RANGE_MIN", 40000, 1024)
    port_max = integer("T3_SANDBOX_PORT_RANGE_MAX", 40200, 1024)
    if port_max > 65535:
        raise SystemExit("T3_SANDBOX_PORT_RANGE_MAX cannot exceed 65535")
    if port_max - port_min < 100:
        raise SystemExit("sandbox port range must span at least 100 ports")
    runtime_network = os.environ.get("T3_SANDBOX_DOCKER_NETWORK_MODE", "").strip()
    if not runtime_network:
        runtime_network = text("T3_SANDBOX_RUNTIME_NETWORK", "t3-sandbox-runtime")
    egress_mode = text("T3_SANDBOX_EGRESS_MODE", "dns")
    if egress_mode not in {"dns", "dns+nft"}:
        raise SystemExit("T3_SANDBOX_EGRESS_MODE must be dns or dns+nft")
    if os.environ.get("T3_SANDBOX_EGRESS_ALLOW", "").strip() and runtime_network != "bridge":
        raise SystemExit(
            "T3_SANDBOX_EGRESS_ALLOW requires T3_SANDBOX_DOCKER_NETWORK_MODE=bridge"
        )

    replacements = {
        "@@MAX_TTL_SECONDS@@": str(integer("T3_SANDBOX_MAX_TTL_SECONDS", 28800, 60)),
        "@@EXECD_IMAGE@@": json.dumps(text("T3_SANDBOX_EXECD_IMAGE", "opensandbox/execd:v1.0.20")),
        "@@HOST_WORKSPACE_ROOT@@": json.dumps(str(host_root)),
        "@@RUNTIME_NETWORK@@": json.dumps(runtime_network),
        "@@DOCKER_HOST_IP_CONFIG@@": docker_host_ip_config(runtime_network),
        "@@PORT_RANGE_MIN@@": str(port_min),
        "@@PORT_RANGE_MAX@@": str(port_max),
        "@@PIDS_LIMIT@@": str(integer("T3_SANDBOX_PIDS_LIMIT", 4096, 64)),
        "@@APPARMOR_PROFILE@@": json.dumps(
            os.environ.get("T3_SANDBOX_APPARMOR_PROFILE", "").strip()
        ),
        "@@SECCOMP_PROFILE@@": json.dumps(
            os.environ.get("T3_SANDBOX_SECCOMP_PROFILE", "").strip()
        ),
        "@@EGRESS_IMAGE@@": json.dumps(
            text("T3_SANDBOX_EGRESS_IMAGE", "opensandbox/egress:v1.1.3")
        ),
        "@@EGRESS_MODE@@": json.dumps(egress_mode),
        "@@SECURE_RUNTIME_CONFIG@@": secure_runtime_config(),
    }

    rendered = template_path.read_text(encoding="utf-8")
    for placeholder, value in replacements.items():
        rendered = rendered.replace(placeholder, value)
    if "@@" in rendered:
        raise SystemExit("OpenSandbox config template contains an unresolved placeholder")
    tomllib.loads(rendered)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    temporary.write_text(rendered, encoding="utf-8")
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
    os.replace(temporary, output_path)


if __name__ == "__main__":
    main()
