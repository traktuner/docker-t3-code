from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from t3_sandbox_gateway.backend import BackendExecution, BackendStatus
from t3_sandbox_gateway.config import Settings
from t3_sandbox_gateway.devcontainer import DevContainerPlan, LifecycleStage
from t3_sandbox_gateway.models import CreateSandboxRequest, ExecuteRequest
from t3_sandbox_gateway.paths import WorkspaceMapper
from t3_sandbox_gateway.service import LifecycleError, SandboxService, SandboxStateError
from t3_sandbox_gateway.store import LeaseStore, WorkspaceBusyError


class FakeBackend:
    def __init__(self):
        self.created = 0
        self.create_requests: list[dict] = []
        self.destroyed: list[str] = []
        self.renewed: list[tuple[str, int]] = []
        self.events: list[tuple[str, str, int | str]] = []

    async def create(self, **kwargs) -> str:
        self.created += 1
        self.create_requests.append(kwargs)
        return f"upstream-{self.created}"

    async def execute(
        self, upstream_id, command, working_directory, timeout_seconds
    ) -> BackendExecution:
        self.events.append(("execute", upstream_id, timeout_seconds))
        return BackendExecution(
            exit_code=0,
            stdout=f"{upstream_id}:{working_directory}:{command}",
            stderr="",
        )

    async def status(self, _upstream_id) -> BackendStatus:
        return BackendStatus(state="running")

    async def renew(self, upstream_id, ttl_seconds) -> None:
        self.renewed.append((upstream_id, ttl_seconds))
        self.events.append(("renew", upstream_id, ttl_seconds))

    async def destroy(self, upstream_id) -> None:
        self.destroyed.append(upstream_id)


class BlockingBackend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def create(self, **kwargs) -> str:
        self.started.set()
        await self.release.wait()
        return await super().create(**kwargs)


class FailingLifecycleBackend(FakeBackend):
    async def execute(
        self, upstream_id, command, working_directory, timeout_seconds
    ) -> BackendExecution:
        return BackendExecution(
            exit_code=1,
            stdout="Resolving dependencies",
            stderr="error: @effect/tsgo@catalog: failed to resolve",
        )


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
        proton_pass_broker_host_path=None,
        ssh_host_path=None,
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


def service(
    tmp_path: Path, backend: FakeBackend | None = None
) -> tuple[SandboxService, FakeBackend]:
    backend = backend or FakeBackend()
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
async def test_lifecycle_error_includes_bounded_command_output(tmp_path: Path):
    subject, _backend = service(tmp_path, FailingLifecycleBackend())
    plan = DevContainerPlan(
        image="devcontainer:test",
        environment={},
        lifecycle=(
            LifecycleStage(name="postCreateCommand", commands=("bun install",)),
        ),
        image_path="/usr/bin:/bin",
    )

    with pytest.raises(
        LifecycleError,
        match=r"postCreateCommand failed with exit code 1: "
        r"error: @effect/tsgo@catalog: failed to resolve",
    ):
        await subject._run_lifecycle("upstream-1", plan, "/workspace/repo")


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
async def test_creation_marks_only_the_mounted_workspace_as_git_safe(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, backend = service(tmp_path)

    await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))

    environment = backend.create_requests[0]["environment"]
    assert environment["GIT_CONFIG_COUNT"] == "1"
    assert environment["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert environment["GIT_CONFIG_VALUE_0"] == "/workspace/repo"


@pytest.mark.asyncio
async def test_concurrent_reuse_waits_for_the_first_creation(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    backend = BlockingBackend()
    subject, _backend = service(tmp_path, backend)
    request = CreateSandboxRequest(workspace="/workspace/repo")

    first_task = asyncio.create_task(subject.create(request))
    await backend.started.wait()
    second_task = asyncio.create_task(subject.create(request))
    await asyncio.sleep(0)
    backend.release.set()
    first, second = await asyncio.gather(first_task, second_task)

    assert first.id == second.id
    assert backend.created == 1


@pytest.mark.asyncio
async def test_destroy_during_creation_cannot_reactivate_the_lease(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    backend = BlockingBackend()
    subject, _backend = service(tmp_path, backend)

    creation = asyncio.create_task(
        subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    )
    await backend.started.wait()
    lease = subject.list()[0]
    await subject.destroy(lease.id)
    backend.release.set()

    with pytest.raises(SandboxStateError, match="creation was cancelled"):
        await creation
    assert subject.store.get(lease.id).state == "destroyed"
    assert backend.destroyed == ["upstream-1"]


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
    subject, backend = service(tmp_path)
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    original_expiry = lease.expires_at
    backend.events.clear()

    result = await subject.execute(
        lease.id,
        ExecuteRequest(command="git status", working_directory="packages/app"),
    )

    assert "/workspace/repo/packages/app:git status" in result.stdout
    assert backend.events == [
        ("renew", "upstream-1", 600),
        ("execute", "upstream-1", 60),
    ]
    assert subject.store.get(lease.id).expires_at > original_expiry


@pytest.mark.asyncio
async def test_execution_lease_covers_long_command_plus_safety_margin(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    backend = FakeBackend()
    config = replace(
        settings(tmp_path),
        default_ttl_seconds=60,
        command_timeout_seconds=300,
    )
    subject = SandboxService(
        settings=config,
        store=LeaseStore(config.state_db),
        mapper=WorkspaceMapper("/workspace", tmp_path),
        backend=backend,
        devcontainers=FakeDevContainers(),
    )
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    backend.events.clear()

    await subject.execute(
        lease.id,
        ExecuteRequest(command="make all", timeout_seconds=300),
    )

    assert backend.events == [
        ("renew", "upstream-1", 360),
        ("execute", "upstream-1", 300),
    ]


@pytest.mark.asyncio
async def test_execution_rejects_ttl_too_short_for_command(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    backend = FakeBackend()
    config = replace(
        settings(tmp_path),
        default_ttl_seconds=60,
        max_ttl_seconds=300,
        command_timeout_seconds=300,
    )
    subject = SandboxService(
        settings=config,
        store=LeaseStore(config.state_db),
        mapper=WorkspaceMapper("/workspace", tmp_path),
        backend=backend,
        devcontainers=FakeDevContainers(),
    )
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    backend.events.clear()

    with pytest.raises(ValueError, match="maximum TTL must cover"):
        await subject.execute(
            lease.id,
            ExecuteRequest(command="make all", timeout_seconds=300),
        )

    assert backend.events == []


@pytest.mark.asyncio
async def test_observation_does_not_keep_unused_sandbox_alive(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    subject, backend = service(tmp_path)
    lease = await subject.create(CreateSandboxRequest(workspace="/workspace/repo"))
    backend.renewed.clear()

    await subject.status(lease.id)
    subject.list()

    assert backend.renewed == []


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
