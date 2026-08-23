#!/usr/bin/env python3
"""Install the pinned promo-video-script skill for supported agent harnesses."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

SKILL_NAME = "promo-video-script"
MANIFEST_NAME = ".t3-docker-managed.json"
UPSTREAM_COMMIT = "0d34d65fb02b29016a25b38c3e1a593731732f76"


class ConflictError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    label: str
    path: Path
    boundary: Path


@dataclass
class Snapshot:
    target: Target
    existed: bool
    backup: Path | None = None


def enabled(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip() == "1"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_files(root: Path) -> list[Path]:
    return sorted(path.relative_to(root) for path in root.rglob("*") if path.is_file())


def within(path: Path, boundary: Path) -> bool:
    try:
        path.relative_to(boundary)
        return True
    except ValueError:
        return False


def effective_path(target: Target) -> Path:
    boundary = target.boundary.expanduser().absolute()
    path = target.path.expanduser().absolute()
    if not within(path, boundary):
        raise ConflictError(f"target escapes its expected provider root: {path}")
    try:
        resolved_boundary = boundary.resolve(strict=False)
        resolved_path = path.resolve(strict=False)
    except RuntimeError as error:
        raise ConflictError(f"symlink loop at {path}: {error}") from error
    if not within(resolved_path, resolved_boundary):
        raise ConflictError(f"symlink target escapes {resolved_boundary}: {path}")
    if path.is_symlink():
        raise ConflictError(f"managed skill target is a symlink: {path}")
    return resolved_path


def source_manifest(source: Path) -> dict[str, object]:
    return {
        "schema": 1,
        "managedBy": "t3-docker",
        "skill": SKILL_NAME,
        "upstreamCommit": UPSTREAM_COMMIT,
        "files": [
            {"path": str(relative), "sha256": sha256_file(source / relative)}
            for relative in relative_files(source)
        ],
    }


def read_manifest(target: Path) -> dict[str, object]:
    manifest_path = target / MANIFEST_NAME
    if not manifest_path.is_file():
        raise ConflictError(f"foreign {SKILL_NAME} directory has no managed manifest: {target}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConflictError(f"managed skill manifest is invalid: {manifest_path}") from error
    if (
        manifest.get("schema") != 1
        or manifest.get("managedBy") != "t3-docker"
        or manifest.get("skill") != SKILL_NAME
    ):
        raise ConflictError(f"skill manifest is not owned by this provisioner: {manifest_path}")
    return manifest


def validate_tree(target: Path) -> dict[str, object]:
    manifest = read_manifest(target)
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ConflictError(f"skill manifest file list is invalid: {target / MANIFEST_NAME}")
    expected: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ConflictError(f"skill manifest contains an invalid entry: {target}")
        relative = entry.get("path")
        digest = entry.get("sha256")
        if (
            not isinstance(relative, str)
            or not isinstance(digest, str)
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or relative in expected
        ):
            raise ConflictError(f"skill manifest contains an unsafe entry: {target}")
        expected[relative] = digest
    nodes = list(target.rglob("*"))
    if any(path.is_symlink() for path in nodes):
        raise ConflictError(f"managed skill contains a symlink: {target}")
    if any(not path.is_file() and not path.is_dir() for path in nodes):
        raise ConflictError(f"managed skill contains an unsupported node: {target}")
    actual_files = {
        str(path.relative_to(target))
        for path in nodes
        if path.is_file() and path.name != MANIFEST_NAME
    }
    if actual_files != set(expected):
        raise ConflictError(f"managed skill contains missing or unexpected files: {target}")
    expected_dirs = {
        str(parent)
        for relative in expected
        for parent in Path(relative).parents
        if parent != Path(".")
    }
    actual_dirs = {str(path.relative_to(target)) for path in nodes if path.is_dir()}
    if actual_dirs != expected_dirs:
        raise ConflictError(f"managed skill contains unexpected directories: {target}")
    for relative, digest in expected.items():
        if sha256_file(target / relative) != digest:
            raise ConflictError(f"managed skill file was modified: {target / relative}")
    return manifest


def write_tree(source: Path, target: Path, manifest: dict[str, object]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.stage.", dir=target.parent))
    old: Path | None = None
    try:
        for relative in relative_files(source):
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(source / relative, destination)
            destination.chmod(0o644)
        (stage / MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (stage / MANIFEST_NAME).chmod(0o600)
        if target.exists():
            old = Path(tempfile.mkdtemp(prefix=f".{target.name}.old.", dir=target.parent))
            old.rmdir()
            os.replace(target, old)
        os.replace(stage, target)
        if old is not None:
            shutil.rmtree(old)
    except Exception:
        if old is not None and old.exists() and not target.exists():
            os.replace(old, target)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def targets(scope: str) -> list[Target]:
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser().absolute()
    shared = Target(
        "Codex, OpenCode, and Cursor",
        home / ".agents" / "skills" / SKILL_NAME,
        home / ".agents",
    )
    if scope == "user":
        return [
            shared,
            Target("Claude Code", home / ".claude" / "skills" / SKILL_NAME, home / ".claude"),
            Target("Grok", home / ".grok" / "skills" / SKILL_NAME, home / ".grok"),
        ]

    selected: list[Target] = []
    if (
        enabled("T3_PROVIDER_CODEX")
        or enabled("T3_PROVIDER_OPENCODE")
        or enabled("T3_PROVIDER_CURSOR")
    ):
        selected.append(shared)
    if enabled("T3_PROVIDER_CLAUDE"):
        claude_home = Path(os.environ.get("T3_CLAUDE_HOME_PATH", "/data/claude-home"))
        claude_root = claude_home.expanduser().absolute() / ".claude"
        selected.append(Target("Claude Code", claude_root / "skills" / SKILL_NAME, claude_root))
    if enabled("T3_PROVIDER_GROK"):
        grok_root = (
            Path(os.environ.get("GROK_CONFIG_DIR", str(home / ".grok")))
            .expanduser()
            .absolute()
        )
        selected.append(Target("Grok", grok_root / "skills" / SKILL_NAME, grok_root))
    return selected


def parse_args() -> tuple[str, str]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", required=True, choices=("container", "user"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    selected = sum((args.dry_run, args.install, args.uninstall))
    if args.scope == "container":
        if selected:
            parser.error("--scope container does not accept an action flag")
        return args.scope, "install"
    if selected != 1:
        parser.error("--scope user requires exactly one of --dry-run, --install, or --uninstall")
    if args.dry_run:
        return args.scope, "dry-run"
    return args.scope, "uninstall" if args.uninstall else "install"


def resolve_source() -> Path | None:
    script_directory = Path(__file__).resolve().parent
    for root in (script_directory.parent, script_directory):
        source = root / "vendor" / SKILL_NAME / UPSTREAM_COMMIT
        if source.is_dir():
            return source
    return None


def main() -> int:
    scope, action = parse_args()
    source = resolve_source()
    if source is None:
        print("promo-video-script image source is missing.", file=sys.stderr)
        return 2
    desired = source_manifest(source)
    planned: list[Target] = []
    conflicts: list[str] = []
    for target in targets(scope):
        try:
            path = effective_path(target)
            if path.exists():
                if not path.is_dir():
                    raise ConflictError(f"skill target is not a directory: {path}")
                current = validate_tree(path)
                if action != "uninstall" and current == desired:
                    continue
            if action == "uninstall" and not path.exists():
                continue
            planned.append(Target(target.label, path, target.boundary))
        except (ConflictError, OSError) as error:
            conflicts.append(f"{target.label}: {error}")

    verb = "remove" if action == "uninstall" else "install"
    for conflict in conflicts:
        print(f"CONFLICT: {conflict}")
    for target in planned:
        print(f"CHANGE: {verb} {target.label} skill: {target.path}")
    if conflicts:
        print("No changes were made because preflight found a conflict.", file=sys.stderr)
        return 2
    if action == "dry-run":
        if not planned:
            print("No changes required.")
        return 0

    backup_root = Path(tempfile.mkdtemp(prefix="t3-promo-video-transaction."))
    snapshots: list[Snapshot] = []
    try:
        for index, target in enumerate(planned):
            backup = None
            if target.path.exists():
                backup = backup_root / str(index)
                shutil.copytree(target.path, backup, copy_function=shutil.copy2)
            snapshots.append(Snapshot(target, target.path.exists(), backup))
        for target in planned:
            if action == "uninstall":
                shutil.rmtree(target.path)
            else:
                write_tree(source, target.path, desired)
    except Exception as error:
        for snapshot in reversed(snapshots):
            with suppress(OSError):
                if snapshot.target.path.exists():
                    shutil.rmtree(snapshot.target.path)
                if snapshot.existed and snapshot.backup is not None:
                    snapshot.target.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    shutil.copytree(
                        snapshot.backup,
                        snapshot.target.path,
                        copy_function=shutil.copy2,
                    )
        print(f"ERROR: installation transaction failed: {error}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(backup_root, ignore_errors=True)
    if not planned:
        print("No changes required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
