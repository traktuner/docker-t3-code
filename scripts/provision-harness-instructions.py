#!/usr/bin/env python3
"""Reconcile the managed sandbox policy into harness-native global rule files."""

from __future__ import annotations

import os
import re
import stat
import tempfile
from pathlib import Path

START = "<!-- t3-docker:sandbox-policy:start -->"
END = "<!-- t3-docker:sandbox-policy:end -->"
BLOCK_PATTERN = re.compile(
    rf"(?m)^[ \t]*{re.escape(START)}[ \t]*\n.*?^[ \t]*{re.escape(END)}[ \t]*(?:\n|$)",
    re.DOTALL,
)


def enabled(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def provider_enabled(name: str) -> bool:
    return enabled(f"T3_PROVIDER_{name}")


def reconcile_file(path: Path, policy: str, active: bool) -> None:
    destination = path.resolve(strict=False) if path.is_symlink() else path
    before = destination.read_text(encoding="utf-8") if destination.exists() else ""
    if (START in before) != (END in before):
        raise RuntimeError(f"Refusing to modify malformed managed policy block in {destination}")
    without_managed = BLOCK_PATTERN.sub("", before).rstrip()

    if active:
        block = f"{START}\n{policy.rstrip()}\n{END}"
        after = f"{without_managed}\n\n{block}\n" if without_managed else f"{block}\n"
    else:
        after = f"{without_managed}\n" if without_managed else ""

    if after == before:
        return
    if not after and not path.is_symlink():
        if destination.exists():
            destination.unlink()
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(destination.stat().st_mode) if destination.exists() else 0o600
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            output.write(after)
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    policy_path = Path(
        os.environ.get(
            "T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE",
            "/opt/t3-docker/t3-sandbox-instructions.md",
        )
    )
    policy = policy_path.read_text(encoding="utf-8")
    active = (
        bool(os.environ.get("T3_SANDBOX_URL", "").strip())
        and enabled(
            "T3_HARNESS_SANDBOX_INSTRUCTIONS",
            os.environ.get("T3_OPENCODE_SANDBOX_INSTRUCTIONS", "1"),
        )
    )

    home = Path(os.environ.get("HOME", "/data/home"))
    targets = (
        (
            "CODEX",
            Path(os.environ.get("CODEX_HOME", "/data/codex")) / "AGENTS.md",
        ),
        (
            "CLAUDE",
            Path(os.environ.get("T3_CLAUDE_HOME_PATH", "/data/claude-home"))
            / ".claude"
            / "CLAUDE.md",
        ),
        (
            "GROK",
            Path(os.environ.get("GROK_CONFIG_DIR", str(home / ".grok"))) / "AGENTS.md",
        ),
    )

    for provider, target in targets:
        reconcile_file(target, policy, active and provider_enabled(provider))


if __name__ == "__main__":
    main()
