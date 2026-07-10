from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from t3_sandbox_gateway.backend import BackendExecution, BackendStatus
from t3_sandbox_gateway.config import Settings
from t3_sandbox_gateway.devcontainer import DevContainerPlan
from t3_sandbox_gateway.models import CreateSandboxRequest, ExecuteRequest
from t3_sandbox_gateway.paths import WorkspaceMapper
from t3_sandbox_gateway.service import SandboxService, SandboxStateError
from t3_sandbox_gateway.store import LeaseStore, WorkspaceBusyError


class FakeBackend:
    def __init__(self):
        self.created = 0
        self.destroyed: list[str] = []
        self.renewed: list[tuple[str, int]] = []

    async def create(self, **_kwargs) -> str:
        self.created += 1
        return f"upstream-{self.created}"

    async def execute(
        self, upstream_id, command, working_directory, timeout_seconds
    ) -> BackendExecution:
        return BackendExecution(
            exit_code=0,
            stdout=f"{upstream_id}:{working_directory}:{command}",
            stderr="",
        )

    async def status(self, _upstream_id) -> BackendStatus:
        return BackendStatus(state="running")

    async def renew(self, upstream_id, ttl_seconds) -> None:
        self.renewed.append((upstream_id, ttl_seconds))

    async def destroy(self, upstream_id) -> None:
        self.destroyed.append(upstream_id)


class FakeDevContainers:
    async def build(self, _workspace: Path) -> DevContainerPlan:
        return DevContainerPlan(
            image="devcontainer:test",
            environment={},
            lifecycle=(),
            image_path="/usr/bin:/bin",
        )


def settings(tmp_path: Path) -> Settings:
    return Settings(
        gateway_token="test",
        opensandbox_domain="opensandbox:8080",
        opensandbox_api_key="test",
        client_workspace_root="/workspace",
        host_workspace_root=tmp_path,
        state_db=tmp_path / "state.db",
        base_image="agent-base:test",
        cache_volume="cache",
        devcontainer_user_data=tmp_path / "devcontainers",
        devcontainer_enabled=True,
        devcontainer_feature_prefixes=("ghcr.io/devcontainers/features/",),
        devcontainer_platform="linux/amd64",
        workspace_gid=3001,
        default_ttl_seconds=600,
        max_ttl_seconds=3600,
        max_sandboxes=2,
        command_timeout_seconds=60,
        max_output_bytes=262144,
        build_timeout_seconds=60,
        cpu_limit="1",
        memory_limit="1Gi",
        egress_allow=(),
    )


def service(tmp_path: Path) -> tuple[SandboxService, FakeBackend]:
    backend = FakeBackend()
    config = settings(tmp_path)
    return (
        SandboxService(
            settings=config,
            store=LeaseStore(config.state_db),
            mapper=WorkspaceMapper("/workspace", tmp_path),
            backend=backend,
            devcontainers=FakeDevContainers(),
        ),
        backend,
    )


@pytest.mark.asyncio
async def test_reuses_one_active_sandbox_per_workspace(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, backend = service(tmp_path)
    request = CreateSandboxRequest(workspace="/workspace/repo")

    first = await subject.create(request)
    second = await subject.create(request)

    assert first.id == second.id
    assert backend.created == 1
    assert backend.renewed == [("upstream-1", 600)]


@pytest.mark.asyncio
async def test_does_not_reuse_sandbox_with_a_different_profile(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / ".devcontainer").mkdir(parents=True)
    (repo / ".devcontainer" / "devcontainer.json").write_text(
        '{"image":"example.invalid/dev:latest"}', encoding="utf-8"
    )
    subject, _backend = service(tmp_path)
    await subject.create(
        CreateSandboxRequest(workspace="/workspace/repo", profile="base")
    )

    with pytest.raises(WorkspaceBusyError):
        await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))


@pytest.mark.asyncio
async def test_rejects_overlapping_parent_and_child_workspaces(tmp_path: Path):
    (tmp_path / "repo" / "packages" / "app").mkdir(parents=True)
    subject, backend = service(tmp_path)
    await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    with pytest.raises(WorkspaceBusyError, match="overlaps active sandbox"):
        await subject.create(
            CreateSandboxRequest(workspace="/workspace/repo/packages/app")
        )

    assert backend.created == 1


@pytest.mark.asyncio
async def test_reuse_recovers_unavailable_sandbox(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, _backend = service(tmp_path)
    created = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    subject.store.set_state(created.id, "unavailable")

    reused = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    assert reused.id == created.id
    assert reused.state == "active"


@pytest.mark.asyncio
async def test_executes_only_inside_workspace(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, _backend = service(tmp_path)
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    result = await subject.execute(
        lease.id,
        ExecuteRequest(command="git status", working_directory="packages/app"),
    )

    assert "/workspace/repo/packages/app:git status" in result.stdout


@pytest.mark.asyncio
async def test_execute_rejects_an_expired_lease(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, _backend = service(tmp_path)
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    subject.store.renew(lease.id, datetime.now(UTC) - timedelta(seconds=1))

    with pytest.raises(SandboxStateError, match="state=expired"):
        await subject.execute(lease.id, ExecuteRequest(command="git status"))

    assert subject.store.get(lease.id).state == "expired"


@pytest.mark.asyncio
async def test_destroy_releases_workspace_lease(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, backend = service(tmp_path)
    first = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    await subject.destroy(first.id)
    second = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    assert second.id != first.id
    assert backend.destroyed == ["upstream-1"]
