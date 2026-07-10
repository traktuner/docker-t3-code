from pathlib import Path

import pytest
from t3_sandbox_gateway.git_mount import GitMountError, resolve_git_common_mount


def linked_worktree(tmp_path: Path):
    common = tmp_path / "repos" / "main" / ".git"
    gitdir = common / "worktrees" / "feature"
    workspace = tmp_path / "repos" / "feature"
    gitdir.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (gitdir / "commondir").write_text("../..\n", encoding="utf-8")
    (workspace / ".git").write_text(
        "gitdir: /workspace/repos/main/.git/worktrees/feature\n",
        encoding="utf-8",
    )
    return workspace, common


def test_maps_linked_worktree_common_git_directory(tmp_path: Path):
    workspace, common = linked_worktree(tmp_path)

    mount = resolve_git_common_mount(
        workspace,
        "/workspace/repos/feature",
        tmp_path,
        "/workspace",
    )

    assert mount is not None
    assert mount.host_path == common
    assert mount.target_path == "/workspace/repos/main/.git"


def test_normal_repository_needs_no_extra_mount(tmp_path: Path):
    workspace = tmp_path / "repo"
    (workspace / ".git").mkdir(parents=True)

    assert (
        resolve_git_common_mount(workspace, "/workspace/repo", tmp_path, "/workspace")
        is None
    )


def test_rejects_gitdir_outside_allowed_root(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (workspace / ".git").write_text("gitdir: /etc\n", encoding="utf-8")

    with pytest.raises(GitMountError):
        resolve_git_common_mount(workspace, "/workspace/repo", tmp_path, "/workspace")
