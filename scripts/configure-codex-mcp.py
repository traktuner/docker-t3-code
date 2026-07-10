#!/usr/bin/env python3
from __future__ import annotations

import os
import stat
import sys
from collections.abc import MutableMapping
from pathlib import Path

import tomlkit


def main() -> int:
    config_path = Path(os.environ.get("CODEX_HOME", "/data/codex")) / "config.toml"
    if not config_path.is_file():
        return 0
    try:
        document = tomlkit.parse(config_path.read_text(encoding="utf-8"))
    except (OSError, tomlkit.exceptions.ParseError) as exc:
        print(f"Could not update Codex MCP timeouts: {exc}", file=sys.stderr)
        return 1

    servers = document.get("mcp_servers")
    if not isinstance(servers, MutableMapping):
        return 0

    changed = False
    timeout = int(os.environ.get("T3_MCP_TOOL_TIMEOUT_SECONDS", "3700"))
    for name in ("t3-sandbox", "xcodebuild"):
        server = servers.get(name)
        if not isinstance(server, MutableMapping):
            continue
        if server.get("startup_timeout_sec") != 30:
            server["startup_timeout_sec"] = 30
            changed = True
        if server.get("tool_timeout_sec") != timeout:
            server["tool_timeout_sec"] = timeout
            changed = True

    if not changed:
        return 0

    temporary = config_path.with_name(f".{config_path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(tomlkit.dumps(document), encoding="utf-8")
        os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary, config_path)
    finally:
        temporary.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
