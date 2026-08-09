#!/usr/bin/env python3
"""Install the managed ASD-STE100 policy and portable skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

START = "<!-- t3-docker:asd-ste100-policy:start -->"
END = "<!-- t3-docker:asd-ste100-policy:end -->"
METADATA_RE = re.compile(
    rb"<!-- t3-docker:asd-ste100-policy:metadata:"
    rb"file-existed:([01]);prefix-newline:([01]) -->"
)
SKILL_MANIFEST = ".t3-docker-managed.json"
UPSTREAM_COMMIT = "8564f8985f15104c2184f90531bfd1bbb25f3d5b"


@dataclass(frozen=True)
class RuleTarget:
    label: str
    path: Path
    boundary: Path


@dataclass(frozen=True)
class SkillTarget:
    label: str
    path: Path
    boundary: Path


@dataclass(frozen=True)
class Operation:
    path: Path
    kind: str
    apply: Callable[[], None]


@dataclass
class Snapshot:
    path: Path
    kind: str
    existed: bool
    mode: int | None = None
    data: bytes | None = None
    backup: Path | None = None


class ConflictError(Exception):
    pass


def enabled(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip() == "1"


def lexists(path: Path) -> bool:
    return os.path.lexists(path)


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


def effective_path(target: Path, boundary: Path, *, allow_file_symlink: bool) -> Path:
    boundary = boundary.expanduser().absolute()
    target = target.expanduser().absolute()
    if not within(target, boundary):
        raise ConflictError(f"target escapes its expected provider root: {target}")
    try:
        resolved_boundary = boundary.resolve(strict=False)
        resolved_target = target.resolve(strict=False)
    except RuntimeError as error:
        raise ConflictError(f"symlink loop at {target}: {error}") from error
    if not within(resolved_target, resolved_boundary):
        raise ConflictError(
            f"symlink target escapes {resolved_boundary}: {target} -> {resolved_target}"
        )
    if target.is_symlink() and not allow_file_symlink:
        raise ConflictError(f"managed skill target is a symlink: {target}")
    return resolved_target


def atomic_write(path: Path, data: bytes, default_mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else default_mode
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def policy_block(policy: bytes, metadata: bytes) -> bytes:
    return (
        START.encode("utf-8")
        + b"\n"
        + metadata
        + b"\n"
        + policy.rstrip(b"\n")
        + b"\n"
        + END.encode("utf-8")
        + b"\n"
    )


def locate_block(data: bytes) -> tuple[int, int, bytes] | None:
    start_marker = START.encode("utf-8")
    end_marker = END.encode("utf-8")
    starts = data.count(start_marker)
    ends = data.count(end_marker)
    if starts == 0 and ends == 0:
        return None
    if starts != 1 or ends != 1:
        raise ConflictError("policy file has incomplete or duplicate ASD-STE100 markers")
    start = data.index(start_marker)
    try:
        end = data.index(end_marker, start) + len(end_marker)
    except ValueError as error:
        raise ConflictError("policy markers are out of order") from error
    match = METADATA_RE.search(data, start, end)
    if match is None:
        raise ConflictError("managed ASD-STE100 block has missing or invalid metadata")
    if end < len(data) and data[end : end + 1] == b"\n":
        end += 1
    return start, end, match.group(0)


def metadata_values(metadata: bytes) -> tuple[bool, bool]:
    match = METADATA_RE.fullmatch(metadata)
    if match is None:
        raise ConflictError("managed ASD-STE100 metadata is invalid")
    return match.group(1) == b"1", match.group(2) == b"1"


def plan_rule_install(
    target: RuleTarget,
    policy: bytes,
    plans: list[str],
    operations: list[Operation],
) -> None:
    path = effective_path(target.path, target.boundary, allow_file_symlink=True)
    if path.exists() and not path.is_file():
        raise ConflictError(f"{target.label} policy target is not a file: {target.path}")
    data = path.read_bytes() if path.exists() else b""
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ConflictError(f"{target.label} policy file is not UTF-8: {target.path}") from error

    located = locate_block(data)
    if located is None:
        prefix_newline = bool(data and not data.endswith(b"\n"))
        metadata = (
            "<!-- t3-docker:asd-ste100-policy:metadata:"
            f"file-existed:{int(path.exists())};prefix-newline:{int(prefix_newline)} -->"
        ).encode()
        desired = data + (b"\n" if prefix_newline else b"") + policy_block(policy, metadata)
    else:
        start, end, metadata = located
        desired = data[:start] + policy_block(policy, metadata) + data[end:]

    if desired == data:
        return
    plans.append(f"install {target.label} policy: {target.path}")
    operations.append(
        Operation(
            path,
            "file",
            lambda path=path, desired=desired: atomic_write(path, desired, 0o600),
        )
    )


def plan_rule_uninstall(
    target: RuleTarget,
    plans: list[str],
    operations: list[Operation],
) -> None:
    path = effective_path(target.path, target.boundary, allow_file_symlink=True)
    if not path.exists():
        return
    if not path.is_file():
        raise ConflictError(f"{target.label} policy target is not a file: {target.path}")
    data = path.read_bytes()
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ConflictError(f"{target.label} policy file is not UTF-8: {target.path}") from error
    located = locate_block(data)
    if located is None:
        return
    start, end, metadata = located
    file_existed, prefix_newline = metadata_values(metadata)
    before = data[:start]
    if prefix_newline:
        if not before.endswith(b"\n"):
            raise ConflictError(f"{target.label} managed separator is missing: {target.path}")
        before = before[:-1]
    desired = before + data[end:]
    plans.append(f"remove {target.label} policy: {target.path}")
    if not file_existed and desired == b"":
        operations.append(Operation(path, "file", lambda path=path: path.unlink(missing_ok=True)))
    else:
        operations.append(
            Operation(
                path,
                "file",
                lambda path=path, desired=desired: atomic_write(path, desired, 0o600),
            )
        )


def source_manifest(source: Path) -> dict[str, object]:
    files = [
        {"path": str(relative), "sha256": sha256_file(source / relative)}
        for relative in relative_files(source)
    ]
    return {
        "schema": 1,
        "managedBy": "t3-docker",
        "skill": "asd-ste100",
        "upstreamCommit": UPSTREAM_COMMIT,
        "files": files,
    }


def validate_managed_skill(target: Path) -> dict[str, object]:
    manifest_path = target / SKILL_MANIFEST
    if not manifest_path.is_file():
        raise ConflictError(f"foreign asd-ste100 skill directory has no managed manifest: {target}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConflictError(f"managed skill manifest is invalid: {manifest_path}") from error
    if manifest.get("schema") != 1 or manifest.get("managedBy") != "t3-docker":
        raise ConflictError(f"skill manifest is not owned by t3-docker: {manifest_path}")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ConflictError(f"skill manifest file list is invalid: {manifest_path}")
    expected: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ConflictError(f"skill manifest contains an invalid entry: {manifest_path}")
        relative = entry["path"]
        digest = entry.get("sha256")
        unsafe = (
            not isinstance(digest, str)
            or relative in expected
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        )
        if unsafe:
            raise ConflictError(f"skill manifest contains an unsafe entry: {manifest_path}")
        expected[relative] = digest
    entries_on_disk = list(target.rglob("*"))
    symlinks = [path for path in entries_on_disk if path.is_symlink()]
    if symlinks:
        raise ConflictError(f"managed skill contains a symlink: {symlinks[0]}")
    special = [path for path in entries_on_disk if not path.is_file() and not path.is_dir()]
    if special:
        raise ConflictError(f"managed skill contains an unsupported node: {special[0]}")
    actual = {
        str(path.relative_to(target))
        for path in entries_on_disk
        if path.is_file() and path.relative_to(target) != Path(SKILL_MANIFEST)
    }
    if actual != set(expected):
        raise ConflictError(f"managed skill contains missing or unexpected files: {target}")
    expected_directories = {
        str(parent)
        for relative in expected
        for parent in Path(relative).parents
        if parent != Path(".")
    }
    actual_directories = {
        str(path.relative_to(target)) for path in entries_on_disk if path.is_dir()
    }
    if actual_directories != expected_directories:
        raise ConflictError(f"managed skill contains unexpected directories: {target}")
    for relative, digest in expected.items():
        if sha256_file(target / relative) != digest:
            raise ConflictError(f"managed skill file was modified: {target / relative}")
    return manifest


def install_skill_tree(source: Path, target: Path, manifest: dict[str, object]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.stage.", dir=target.parent))
    backup: Path | None = None
    try:
        for relative in relative_files(source):
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(source / relative, destination)
            destination.chmod(0o644)
        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        atomic_write(stage / SKILL_MANIFEST, manifest_bytes, 0o600)
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=f".{target.name}.old.", dir=target.parent))
            backup.rmdir()
            os.replace(target, backup)
        os.replace(stage, target)
        if backup is not None:
            shutil.rmtree(backup)
    except Exception:
        if backup is not None and backup.exists() and not target.exists():
            os.replace(backup, target)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def plan_skill_install(
    target: SkillTarget,
    source: Path,
    plans: list[str],
    operations: list[Operation],
) -> None:
    path = effective_path(target.path, target.boundary, allow_file_symlink=False)
    desired_manifest = source_manifest(source)
    if path.exists():
        if not path.is_dir():
            raise ConflictError(f"{target.label} skill target is not a directory: {target.path}")
        current_manifest = validate_managed_skill(path)
        if current_manifest == desired_manifest:
            return
    plans.append(f"install {target.label} skill: {target.path}")
    operations.append(
        Operation(
            path,
            "directory",
            lambda source=source, path=path, manifest=desired_manifest: install_skill_tree(
                source, path, manifest
            ),
        )
    )


def plan_skill_uninstall(
    target: SkillTarget,
    plans: list[str],
    operations: list[Operation],
) -> None:
    path = effective_path(target.path, target.boundary, allow_file_symlink=False)
    if not path.exists():
        return
    if not path.is_dir():
        raise ConflictError(f"{target.label} skill target is not a directory: {target.path}")
    validate_managed_skill(path)
    plans.append(f"remove {target.label} skill: {target.path}")
    operations.append(Operation(path, "directory", lambda path=path: shutil.rmtree(path)))


def tree_signature(root: Path) -> tuple[tuple[str, str, int], ...]:
    signature: list[tuple[str, str, int]] = []
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            signature.append((relative, f"symlink:{os.readlink(path)}", 0))
        elif path.is_dir():
            signature.append((relative, "directory", stat.S_IMODE(path.stat().st_mode)))
        elif path.is_file():
            signature.append((relative, sha256_file(path), stat.S_IMODE(path.stat().st_mode)))
        else:
            signature.append((relative, "other", stat.S_IMODE(path.stat().st_mode)))
    return tuple(signature)


def capture_snapshot(operation: Operation, backup_root: Path, index: int) -> Snapshot:
    path = operation.path
    if not lexists(path):
        return Snapshot(path, operation.kind, False)
    if operation.kind == "file":
        if not path.is_file() or path.is_symlink():
            raise ConflictError(f"file target changed after preflight: {path}")
        return Snapshot(
            path,
            operation.kind,
            True,
            mode=stat.S_IMODE(path.stat().st_mode),
            data=path.read_bytes(),
        )
    if not path.is_dir() or path.is_symlink():
        raise ConflictError(f"skill target changed after preflight: {path}")
    backup = backup_root / f"skill-{index}"
    shutil.copytree(path, backup, copy_function=shutil.copy2)
    return Snapshot(path, operation.kind, True, backup=backup)


def snapshot_matches(snapshot: Snapshot) -> bool:
    if not snapshot.existed:
        return not lexists(snapshot.path)
    if snapshot.kind == "file":
        return (
            snapshot.path.is_file()
            and not snapshot.path.is_symlink()
            and snapshot.path.read_bytes() == snapshot.data
            and stat.S_IMODE(snapshot.path.stat().st_mode) == snapshot.mode
        )
    return (
        snapshot.path.is_dir()
        and not snapshot.path.is_symlink()
        and snapshot.backup is not None
        and tree_signature(snapshot.path) == tree_signature(snapshot.backup)
    )


def restore_snapshot(snapshot: Snapshot) -> None:
    path = snapshot.path
    if snapshot.kind == "file":
        if snapshot.existed:
            if snapshot.data is None or snapshot.mode is None:
                raise RuntimeError(f"incomplete file snapshot: {path}")
            atomic_write(path, snapshot.data, snapshot.mode)
            path.chmod(snapshot.mode)
        elif lexists(path):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        return

    if lexists(path):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    if snapshot.existed:
        if snapshot.backup is None:
            raise RuntimeError(f"incomplete directory snapshot: {path}")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copytree(snapshot.backup, path, copy_function=shutil.copy2)


def missing_parent_directories(operations: list[Operation]) -> list[Path]:
    missing: set[Path] = set()
    for operation in operations:
        current = operation.path.parent
        while not current.exists():
            missing.add(current)
            if current == current.parent:
                break
            current = current.parent
    return sorted(missing, key=lambda path: len(path.parts), reverse=True)


def remove_empty_directories(paths: list[Path]) -> None:
    for path in paths:
        with suppress(FileNotFoundError, OSError):
            path.rmdir()


def targets(scope: str) -> tuple[list[RuleTarget], list[SkillTarget]]:
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser().absolute()
    if scope == "user":
        codex_root = home / ".codex"
        claude_root = home / ".claude"
        opencode_root = home / ".config" / "opencode"
        rules = [RuleTarget("Codex", codex_root / "AGENTS.md", codex_root)]
        codex_override = codex_root / "AGENTS.override.md"
        if lexists(codex_override):
            rules.append(RuleTarget("Codex override", codex_override, codex_root))
        rules.extend(
            [
                RuleTarget("Claude Code", claude_root / "CLAUDE.md", claude_root),
                RuleTarget("OpenCode", opencode_root / "AGENTS.md", opencode_root),
            ]
        )
        return (
            rules,
            [
                SkillTarget(
                    "Codex and OpenCode",
                    home / ".agents" / "skills" / "asd-ste100",
                    home / ".agents",
                ),
                SkillTarget("Claude Code", claude_root / "skills" / "asd-ste100", claude_root),
            ],
        )

    rules: list[RuleTarget] = []
    skills: list[SkillTarget] = []
    codex_root = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser().absolute()
    claude_home = (
        Path(os.environ.get("T3_CLAUDE_HOME_PATH", "/data/claude-home"))
        .expanduser()
        .absolute()
    )
    claude_root = claude_home / ".claude"
    opencode_root = Path(
        os.environ.get("OPENCODE_CONFIG_DIR", str(home / ".config" / "opencode"))
    ).expanduser().absolute()
    grok_root = Path(os.environ.get("GROK_CONFIG_DIR", str(home / ".grok"))).expanduser().absolute()

    codex_enabled = enabled("T3_PROVIDER_CODEX")
    claude_enabled = enabled("T3_PROVIDER_CLAUDE")
    opencode_enabled = enabled("T3_PROVIDER_OPENCODE")
    grok_enabled = enabled("T3_PROVIDER_GROK")
    if codex_enabled:
        rules.append(RuleTarget("Codex", codex_root / "AGENTS.md", codex_root))
        codex_override = codex_root / "AGENTS.override.md"
        if lexists(codex_override):
            rules.append(RuleTarget("Codex override", codex_override, codex_root))
    if claude_enabled:
        rules.append(RuleTarget("Claude Code", claude_root / "CLAUDE.md", claude_root))
        skills.append(
            SkillTarget("Claude Code", claude_root / "skills" / "asd-ste100", claude_root)
        )
    if opencode_enabled:
        rules.append(RuleTarget("OpenCode", opencode_root / "AGENTS.md", opencode_root))
    if grok_enabled:
        rules.append(RuleTarget("Grok", grok_root / "AGENTS.md", grok_root))
    if codex_enabled or opencode_enabled:
        skills.append(
            SkillTarget(
                "Codex and OpenCode",
                home / ".agents" / "skills" / "asd-ste100",
                home / ".agents",
            )
        )
    return rules, skills


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


def main() -> int:
    scope, action = parse_args()
    source_root = Path(__file__).resolve().parent.parent
    policy_source = source_root / "agent-assets" / "policies" / "asd-ste100-mandatory.md"
    skill_source = source_root / "agent-assets" / "skills" / "asd-ste100"
    if not policy_source.is_file() or not skill_source.is_dir():
        print("ASD-STE100 image sources are missing.", file=sys.stderr)
        return 2
    policy = policy_source.read_bytes()
    try:
        policy.decode("utf-8")
    except UnicodeDecodeError:
        print("ASD-STE100 policy source is not UTF-8.", file=sys.stderr)
        return 2

    rules, skills = targets(scope)
    plans: list[str] = []
    operations: list[Operation] = []
    conflicts: list[str] = []
    uninstall = action == "uninstall"
    for rule in rules:
        try:
            if uninstall:
                plan_rule_uninstall(rule, plans, operations)
            else:
                plan_rule_install(rule, policy, plans, operations)
        except (ConflictError, OSError) as error:
            conflicts.append(f"{rule.label}: {error}")
    for skill in skills:
        try:
            if uninstall:
                plan_skill_uninstall(skill, plans, operations)
            else:
                plan_skill_install(skill, skill_source, plans, operations)
        except (ConflictError, OSError) as error:
            conflicts.append(f"{skill.label}: {error}")

    for conflict in conflicts:
        print(f"CONFLICT: {conflict}")
    for plan in plans:
        print(f"CHANGE: {plan}")
    if conflicts:
        print("No changes were made because preflight found a conflict.", file=sys.stderr)
        return 2
    if action == "dry-run":
        if not plans:
            print("No changes required.")
        return 0
    missing_directories = missing_parent_directories(operations)
    backup_root = Path(tempfile.mkdtemp(prefix="t3-ste100-transaction."))
    snapshots: list[Snapshot] = []
    attempted: list[Snapshot] = []
    try:
        snapshots = [
            capture_snapshot(operation, backup_root, index)
            for index, operation in enumerate(operations)
        ]
        for operation, snapshot in zip(operations, snapshots, strict=True):
            if not snapshot_matches(snapshot):
                raise ConflictError(f"target changed after preflight: {operation.path}")
            attempted.append(snapshot)
            operation.apply()
    except Exception as error:
        rollback_errors: list[str] = []
        for snapshot in reversed(attempted):
            try:
                restore_snapshot(snapshot)
            except Exception as rollback_error:
                rollback_errors.append(f"{snapshot.path}: {rollback_error}")
        remove_empty_directories(missing_directories)
        print(f"ERROR: installation transaction failed: {error}", file=sys.stderr)
        for rollback_error in rollback_errors:
            print(f"ROLLBACK ERROR: {rollback_error}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(backup_root, ignore_errors=True)
    if not plans:
        print("No changes required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
