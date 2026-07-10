from __future__ import annotations

import asyncio
import hashlib
import uuid
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from .backend import BackendExecution, SandboxBackend
from .config import Settings
from .devcontainer import (
    DevContainerBuilder,
    DevContainerError,
    DevContainerPlan,
    find_devcontainer,
    lifecycle_shell_command,
)
from .git_mount import resolve_git_common_mount
from .models import CreateSandboxRequest, ExecuteRequest
from .paths import WorkspaceMapper, sandbox_working_directory
from .store import Lease, LeaseStore, SandboxCapacityError, WorkspaceBusyError


class SandboxNotFoundError(KeyError):
    pass


class SandboxLimitError(RuntimeError):
    pass


class SandboxStateError(RuntimeError):
    pass


class LifecycleError(RuntimeError):
    pass


class SandboxService:
    def __init__(
        self,
        settings: Settings,
        store: LeaseStore,
        mapper: WorkspaceMapper,
        backend: SandboxBackend,
        devcontainers: DevContainerBuilder,
    ):
        self.settings = settings
        self.store = store
        self.mapper = mapper
        self.backend = backend
        self.devcontainers = devcontainers
        self._reservation_lock = asyncio.Lock()

    async def create(self, request: CreateSandboxRequest) -> Lease:
        workspace = self.mapper.resolve(request.workspace)
        ttl_seconds = request.ttl_seconds or self.settings.default_ttl_seconds
        if ttl_seconds > self.settings.max_ttl_seconds:
            raise ValueError(
                f"ttl_seconds cannot exceed {self.settings.max_ttl_seconds}"
            )

        selected_profile = self._profile(request.profile, workspace.host_path)
        async with self._reservation_lock:
            now = datetime.now(UTC)
            self.store.expire_due(now, self.settings.build_timeout_seconds)
            current = self.store.active_for_host_path(str(workspace.host_path))
            if current is not None:
                if (
                    request.reuse
                    and current.workspace == workspace.client_path
                    and current.profile == selected_profile
                    and await self._is_reusable(current)
                ):
                    return self.store.get(current.id) or current
                raise WorkspaceBusyError(
                    f"workspace overlaps active sandbox: {current.workspace}"
                )
            lease = Lease(
                id=str(uuid.uuid4()),
                upstream_id=None,
                workspace=workspace.client_path,
                host_path=str(workspace.host_path),
                profile=selected_profile,
                image=self.settings.base_image,
                state="creating",
                created_at=now,
                expires_at=now + timedelta(seconds=ttl_seconds),
                error=None,
            )
            try:
                self.store.create(lease, self.settings.max_sandboxes)
            except SandboxCapacityError as exc:
                raise SandboxLimitError(str(exc)) from exc

        upstream_id: str | None = None
        try:
            plan = await self._plan(selected_profile, workspace.host_path)
            environment = self._environment(workspace.client_path, plan)
            git_common = resolve_git_common_mount(
                workspace.host_path,
                workspace.client_path,
                self.settings.host_workspace_root,
                self.settings.client_workspace_root,
            )
            workspace_hash = hashlib.sha256(
                workspace.client_path.encode("utf-8")
            ).hexdigest()[:24]
            upstream_id = await self.backend.create(
                image=plan.image,
                host_path=workspace.host_path,
                mount_path=workspace.client_path,
                git_common_host=git_common.host_path if git_common else None,
                git_common_target=git_common.target_path if git_common else None,
                ttl_seconds=ttl_seconds,
                environment=environment,
                workspace_hash=workspace_hash,
            )
            await self._run_lifecycle(upstream_id, plan, workspace.client_path)
            await self.backend.renew(upstream_id, ttl_seconds)
            return self.store.activate(
                lease.id,
                upstream_id,
                plan.image,
                datetime.now(UTC) + timedelta(seconds=ttl_seconds),
            )
        except asyncio.CancelledError:
            if upstream_id is not None:
                with suppress(Exception):
                    await self.backend.destroy(upstream_id)
            self.store.set_state(lease.id, "failed", "request cancelled")
            raise
        except Exception as exc:
            if upstream_id is not None:
                with suppress(Exception):
                    await self.backend.destroy(upstream_id)
            self.store.set_state(lease.id, "failed", type(exc).__name__)
            raise

    async def execute(self, lease_id: str, request: ExecuteRequest) -> BackendExecution:
        lease = self._active(lease_id)
        timeout = request.timeout_seconds or self.settings.command_timeout_seconds
        if timeout > self.settings.command_timeout_seconds:
            raise ValueError(
                f"timeout_seconds cannot exceed {self.settings.command_timeout_seconds}"
            )
        return await self.backend.execute(
            lease.upstream_id or "",
            request.command,
            sandbox_working_directory(request.working_directory, lease.workspace),
            timeout,
        )

    async def status(self, lease_id: str) -> Lease:
        lease = self._required(lease_id)
        if (
            lease.state in {"active", "unavailable"}
            and lease.expires_at <= datetime.now(UTC)
        ):
            return self.store.set_state(lease.id, "expired")
        if lease.state not in {"active", "unavailable"} or lease.upstream_id is None:
            return lease
        try:
            status = await self.backend.status(lease.upstream_id)
        except Exception:
            return self.store.set_state(lease.id, "unavailable", "upstream status failed")
        if status.state.lower() not in {"running", "active", "ready"}:
            return self.store.set_state(lease.id, status.state.lower())
        if lease.state != "active":
            return self.store.set_state(lease.id, "active")
        return lease

    async def renew(self, lease_id: str, ttl_seconds: int) -> Lease:
        if ttl_seconds > self.settings.max_ttl_seconds:
            raise ValueError(
                f"ttl_seconds cannot exceed {self.settings.max_ttl_seconds}"
            )
        lease = self._active(lease_id)
        await self.backend.renew(lease.upstream_id or "", ttl_seconds)
        return self.store.renew(
            lease.id, datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        )

    async def destroy(self, lease_id: str) -> Lease:
        lease = self._required(lease_id)
        if lease.upstream_id is not None and lease.state in {"creating", "active", "unavailable"}:
            with suppress(Exception):
                await self.backend.destroy(lease.upstream_id)
        return self.store.set_state(lease.id, "destroyed")

    def list(self) -> list[Lease]:
        self.store.expire_due(datetime.now(UTC), self.settings.build_timeout_seconds)
        return self.store.list()

    def _profile(self, requested: str, workspace) -> str:
        has_config = find_devcontainer(workspace) is not None
        if requested == "base":
            return "base"
        if requested == "devcontainer":
            if not self.settings.devcontainer_enabled:
                raise DevContainerError("devcontainer builds are disabled")
            if not has_config:
                raise DevContainerError("workspace does not contain a devcontainer.json")
            return "devcontainer"
        if requested == "auto" and has_config and self.settings.devcontainer_enabled:
            return "devcontainer"
        return "base"

    async def _plan(self, profile: str, workspace) -> DevContainerPlan:
        if profile == "devcontainer":
            return await self.devcontainers.build(workspace)
        return DevContainerPlan(
            image=self.settings.base_image,
            environment={},
            lifecycle=(),
            image_path="/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
        )

    def _environment(
        self, workspace: str, plan: DevContainerPlan
    ) -> dict[str, str]:
        namespace = hashlib.sha256(workspace.encode("utf-8")).hexdigest()[:16]
        root = f"/cache/workspaces/{namespace}"
        path = ":".join(
            (
                f"{root}/npm-global/bin",
                f"{root}/uv-tools/bin",
                f"{root}/bin",
                "/cache/bin",
                plan.image_path,
            )
        )
        managed = {
            "T3_SANDBOX": "1",
            "T3_SANDBOX_WORKSPACE": workspace,
            "T3_SANDBOX_CACHE": root,
            "PATH": path,
            "NPM_CONFIG_PREFIX": f"{root}/npm-global",
            "NPM_CONFIG_CACHE": f"{root}/npm-cache",
            "npm_config_prefix": f"{root}/npm-global",
            "npm_config_cache": f"{root}/npm-cache",
            "PNPM_HOME": f"{root}/pnpm",
            "YARN_CACHE_FOLDER": f"{root}/yarn",
            "UV_CACHE_DIR": f"{root}/uv-cache",
            "UV_TOOL_DIR": f"{root}/uv-tools",
            "UV_TOOL_BIN_DIR": f"{root}/uv-tools/bin",
            "PIP_CACHE_DIR": f"{root}/pip",
            "CARGO_HOME": f"{root}/cargo",
            "GOMODCACHE": f"{root}/go/pkg/mod",
            "GOCACHE": f"{root}/go/build",
            "GRADLE_USER_HOME": f"{root}/gradle",
            "MAVEN_CONFIG": f"{root}/maven",
        }
        return {**plan.environment, **managed}

    async def _run_lifecycle(
        self, upstream_id: str, plan: DevContainerPlan, workspace: str
    ) -> None:
        for stage in plan.lifecycle:
            results = await asyncio.gather(
                *(
                    self.backend.execute(
                        upstream_id,
                        lifecycle_shell_command(command),
                        workspace,
                        self.settings.command_timeout_seconds,
                    )
                    for command in stage.commands
                )
            )
            failed = next(
                (result for result in results if result.exit_code not in (None, 0)),
                None,
            )
            if failed is not None:
                raise LifecycleError(
                    f"devcontainer {stage.name} failed with exit code {failed.exit_code}"
                )

    async def _is_reusable(self, lease: Lease) -> bool:
        if lease.state == "creating":
            return False
        if lease.expires_at <= datetime.now(UTC) or lease.upstream_id is None:
            self.store.set_state(lease.id, "expired")
            return False
        try:
            status = await self.backend.status(lease.upstream_id)
        except Exception:
            self.store.set_state(lease.id, "unavailable", "upstream status failed")
            return False
        if status.state.lower() not in {"running", "active", "ready"}:
            self.store.set_state(lease.id, status.state.lower())
            return False
        if lease.state != "active":
            self.store.set_state(lease.id, "active")
        return True

    def _required(self, lease_id: str) -> Lease:
        lease = self.store.get(lease_id)
        if lease is None:
            raise SandboxNotFoundError(lease_id)
        return lease

    def _active(self, lease_id: str) -> Lease:
        lease = self._required(lease_id)
        if lease.state == "active" and lease.expires_at <= datetime.now(UTC):
            lease = self.store.set_state(lease.id, "expired")
        if lease.state != "active" or lease.upstream_id is None:
            raise SandboxStateError(
                f"sandbox {lease_id} is not active (state={lease.state})"
            )
        return lease
