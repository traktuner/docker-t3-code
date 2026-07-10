from __future__ import annotations

import posixpath
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class GitMountError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class GitCommonMount:
    host_path: Path
    target_path: str


def _within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def resolve_git_common_mount(
    workspace_host: Path,
    workspace_client: str,
    host_root: Path,
    client_root: str,
) -> GitCommonMount | None:
    dot_git = workspace_host / ".git"
    if not dot_git.is_file():
        return None

    try:
        marker = dot_git.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise GitMountError("could not read linked-worktree .git file") from exc
    if not marker.lower().startswith("gitdir:"):
        raise GitMountError("linked-worktree .git file has an invalid format")
    raw_gitdir = marker.split(":", 1)[1].strip()
    if not raw_gitdir:
        raise GitMountError("linked-worktree .git file has an empty gitdir")

    host_root = host_root.resolve(strict=True)
    raw_posix = PurePosixPath(raw_gitdir)
    client_root_posix = PurePosixPath(client_root)
    workspace_client_posix = PurePosixPath(workspace_client)

    if raw_posix.is_absolute():
        try:
            relative = raw_posix.relative_to(client_root_posix)
            host_gitdir = (host_root / Path(*relative.parts)).resolve(strict=True)
            target_gitdir = raw_posix
        except ValueError:
            raw_host = Path(raw_gitdir)
            try:
                host_gitdir = raw_host.resolve(strict=True)
            except OSError as exc:
                raise GitMountError(
                    "linked-worktree gitdir is outside the known container and host roots"
                ) from exc
            if not _within(host_gitdir, host_root):
                raise GitMountError(
                    "linked-worktree gitdir resolves outside the host root"
                ) from None
            target_gitdir = raw_posix
    else:
        host_gitdir = (workspace_host / Path(raw_gitdir)).resolve(strict=True)
        target_gitdir = PurePosixPath(
            posixpath.normpath(str(workspace_client_posix / raw_posix))
        )

    if not host_gitdir.is_dir() or not _within(host_gitdir, host_root):
        raise GitMountError("linked-worktree gitdir is not below the allowed host root")

    common_file = host_gitdir / "commondir"
    if common_file.is_file():
        common_relative = common_file.read_text(encoding="utf-8").strip()
        if not common_relative:
            raise GitMountError("linked-worktree commondir is empty")
        host_common = (host_gitdir / common_relative).resolve(strict=True)
        target_common = PurePosixPath(
            posixpath.normpath(
                str(PurePosixPath(target_gitdir) / PurePosixPath(common_relative))
            )
        )
    else:
        host_common = host_gitdir
        target_common = target_gitdir

    if not host_common.is_dir() or not _within(host_common, host_root):
        raise GitMountError("linked-worktree common directory escapes the host root")
    if not target_common.is_absolute():
        raise GitMountError("linked-worktree target path must be absolute")
    target_host_root = PurePosixPath(str(host_root))
    if not (
        target_common in (client_root_posix, target_host_root)
        or target_common.is_relative_to(client_root_posix)
        or target_common.is_relative_to(target_host_root)
    ):
        raise GitMountError("linked-worktree target path escapes known roots")

    return GitCommonMount(host_path=host_common, target_path=str(target_common))
