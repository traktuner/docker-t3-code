#!/usr/bin/env python3
"""Reconcile managed cross-harness policies into native global rule files."""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import tempfile
from pathlib import Path

START = "<!-- t3-docker:sandbox-policy:start -->"
END = "<!-- t3-docker:sandbox-policy:end -->"
ONYX_START = "<!-- t3-docker:onyx-policy:start -->"
ONYX_END = "<!-- t3-docker:onyx-policy:end -->"
CLAUDE_NATIVE_ROUTING = re.compile(
    r"(?ms)^## Execution model[ \t]*\n.*?(?=^## Project traps\b)"
)
CLAUDE_NATIVE_ROUTING_SENTINELS = (
    "The user's primary coding harness is now OpenCode + Lumo Max",
    "`opus-critical-reviewer`",
    "Use parallel Claude subagents",
)
CLAUDE_NATIVE_BUNDLE = re.compile(
    r"(?ms)^## Available local bundle[ \t]*\n.*?(?=^Lead final responses)"
)
CLAUDE_NATIVE_BUNDLE_SENTINELS = (
    "## Available local bundle",
    "The tiered subagents",
    "`opus-critical-reviewer`",
    "`/preflight`",
)
CLAUDE_NATIVE_TIER_AGENTS = (
    "lumo-basic-researcher.md",
    "lumo-plus-implementer.md",
    "sonnet-sanity-checker.md",
    "opus-critical-reviewer.md",
    "fable-architect.md",
)
CLAUDE_NATIVE_ROUTING_COMMANDS = (
    "codex-impl.md",
    "codex-review.md",
    "critical-review.md",
    "final-review.md",
    "lumo-impl.md",
    "lumo-research.md",
    "lumo-review.md",
    "preflight.md",
    "sanity-check.md",
)


def enabled(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def provider_enabled(name: str) -> bool:
    return enabled(f"T3_PROVIDER_{name}")


def sanitize_claude_hooks(path: Path) -> None:
    if not path.is_file() or not enabled("T3_CLAUDE_SANITIZE_HOST_HOOKS"):
        return

    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(settings, dict) or not isinstance(settings.get("hooks"), dict):
        return

    changed = False
    reconciled_events = {}
    for event, groups in settings["hooks"].items():
        if not isinstance(groups, list):
            reconciled_events[event] = groups
            continue

        reconciled_groups = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                reconciled_groups.append(group)
                continue

            reconciled_hooks = []
            for hook in group["hooks"]:
                command = hook.get("command") if isinstance(hook, dict) else None
                try:
                    tokens = shlex.split(command) if isinstance(command, str) else []
                except ValueError:
                    tokens = []
                unavailable_host_hook = any(
                    token.startswith("/Users/") and not Path(token).is_file() for token in tokens
                )
                if unavailable_host_hook:
                    changed = True
                    continue
                reconciled_hooks.append(hook)

            if reconciled_hooks:
                reconciled_groups.append({**group, "hooks": reconciled_hooks})
            else:
                changed = True

        if reconciled_groups:
            reconciled_events[event] = reconciled_groups
        elif groups:
            changed = True

    if not changed:
        return

    settings["hooks"] = reconciled_events
    mode = stat.S_IMODE(path.stat().st_mode)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump(settings, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sanitize_claude_native_delegation(claude_home: Path) -> None:
    rules = claude_home / ".claude" / "CLAUDE.md"
    if rules.is_file():
        before = rules.read_text(encoding="utf-8")
        after = before
        if all(marker in before for marker in CLAUDE_NATIVE_ROUTING_SENTINELS):
            after = CLAUDE_NATIVE_ROUTING.sub("", before, count=1)
        if all(marker in after for marker in CLAUDE_NATIVE_BUNDLE_SENTINELS):
            after = CLAUDE_NATIVE_BUNDLE.sub("", after, count=1)
        if after != before:
            rules.write_text(after, encoding="utf-8")

    routing_paths = (
        (
            claude_home / ".claude" / "agents",
            claude_home / ".claude" / "agents-quarantine" / "agent-rack-native-tier",
            CLAUDE_NATIVE_TIER_AGENTS,
        ),
        (
            claude_home / ".claude" / "commands",
            claude_home / ".claude" / "commands-quarantine" / "agent-rack-native-tier",
            CLAUDE_NATIVE_ROUTING_COMMANDS,
        ),
    )
    for source_root, quarantine, names in routing_paths:
        for name in names:
            source = source_root / name
            if not source.is_file():
                continue
            quarantine.mkdir(parents=True, exist_ok=True)
            destination = quarantine / name
            if destination.is_file() and destination.read_bytes() == source.read_bytes():
                source.unlink()
                continue
            if destination.exists():
                index = 1
                while True:
                    candidate = quarantine / f"{Path(name).stem}.restored-{index}.md"
                    if not candidate.exists():
                        destination = candidate
                        break
                    index += 1
            source.replace(destination)


def reconcile_file(
    path: Path,
    policy: str,
    active: bool,
    start: str = START,
    end: str = END,
) -> None:
    block_pattern = re.compile(
        rf"(?m)^[ \t]*{re.escape(start)}[ \t]*\n.*?^[ \t]*{re.escape(end)}[ \t]*(?:\n|$)",
        re.DOTALL,
    )
    destination = path.resolve(strict=False) if path.is_symlink() else path
    before = destination.read_text(encoding="utf-8") if destination.exists() else ""
    if (start in before) != (end in before):
        raise RuntimeError(f"Refusing to modify malformed managed policy block in {destination}")
    without_managed = block_pattern.sub("", before).rstrip()

    if active:
        block = f"{start}\n{policy.rstrip()}\n{end}"
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
    claude_home = Path(os.environ.get("T3_CLAUDE_HOME_PATH", "/data/claude-home"))
    targets = (
        (
            "CODEX",
            Path(os.environ.get("CODEX_HOME", "/data/codex")) / "AGENTS.md",
        ),
        (
            "CLAUDE",
            claude_home / ".claude" / "CLAUDE.md",
        ),
        (
            "GROK",
            Path(os.environ.get("GROK_CONFIG_DIR", str(home / ".grok"))) / "AGENTS.md",
        ),
        (
            "OPENCODE",
            Path(
                os.environ.get(
                    "OPENCODE_CONFIG_DIR",
                    str(
                        Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
                        / "opencode"
                    ),
                )
            )
            / "AGENTS.md",
        ),
    )

    if enabled("T3_AGENT_RACK") and provider_enabled("CLAUDE"):
        sanitize_claude_native_delegation(claude_home)

    for provider, target in targets:
        reconcile_file(target, policy, active and provider_enabled(provider))

    sanitize_claude_hooks(
        claude_home / ".claude" / "settings.json"
    )

    onyx_policy_path = Path(
        os.environ.get("T3_HARNESS_ONYX_INSTRUCTIONS_FILE", "/config/onyx-context.md")
    )
    if onyx_policy_path.is_file():
        onyx_policy = onyx_policy_path.read_text(encoding="utf-8")
        for provider, target in targets:
            if provider_enabled(provider):
                existing = (
                    target.resolve(strict=False).read_text(encoding="utf-8")
                    if target.exists()
                    else ""
                )
                has_unmanaged_onyx = (
                    "onyx" in existing.lower()
                    and ONYX_START not in existing
                    and ONYX_END not in existing
                )
                if has_unmanaged_onyx:
                    continue
            reconcile_file(
                target,
                onyx_policy,
                provider_enabled(provider),
                ONYX_START,
                ONYX_END,
            )


if __name__ == "__main__":
    main()
