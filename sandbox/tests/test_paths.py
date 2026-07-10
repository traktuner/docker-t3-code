from pathlib import Path

import pytest
from t3_sandbox_gateway.paths import (
    WorkspaceMapper,
    WorkspacePathError,
    sandbox_working_directory,
)


def test_maps_client_workspace_to_host(tmp_path: Path):
    project = tmp_path / "repos" / "project"
    project.mkdir(parents=True)
    mapper = WorkspaceMapper("/workspace", tmp_path)

    resolved = mapper.resolve("/workspace/repos/project")

    assert resolved.client_path == "/workspace/repos/project"
    assert resolved.host_path == project


def test_rejects_symlink_escape(tmp_path: Path):
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    (tmp_path / "escape").symlink_to(outside, target_is_directory=True)
    mapper = WorkspaceMapper("/workspace", tmp_path)

    with pytest.raises(WorkspacePathError):
        mapper.resolve("/workspace/escape")


def test_rejects_mounting_entire_workspace_root(tmp_path: Path):
    mapper = WorkspaceMapper("/workspace", tmp_path)

    with pytest.raises(WorkspacePathError):
        mapper.resolve("/workspace")


@pytest.mark.parametrize("value", ["/tmp", "../repo", "/workspace/../tmp"])
def test_rejects_working_directory_escape(value: str):
    with pytest.raises(WorkspacePathError):
        sandbox_working_directory(value)


def test_accepts_relative_sandbox_working_directory():
    assert sandbox_working_directory("packages/api") == "/workspace/packages/api"


def test_maps_virtual_workspace_to_original_t3_path():
    assert (
        sandbox_working_directory("/workspace/packages/api", "/workspace/repos/project")
        == "/workspace/repos/project/packages/api"
    )


def test_accepts_original_t3_worktree_path():
    assert (
        sandbox_working_directory(
            "/workspace/repos/project/packages/api", "/workspace/repos/project"
        )
        == "/workspace/repos/project/packages/api"
    )
