from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Protocol

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.models.execd import RunCommandOpts
from opensandbox.models.sandboxes import PVC, Host, NetworkPolicy, NetworkRule, Volume

from .config import Settings


@dataclass(frozen=True, slots=True)
class BackendExecution:
    exit_code: int | None
    stdout: str
    stderr: str


@dataclass(frozen=True, slots=True)
class BackendStatus:
    state: str


def _bounded_log(messages, max_bytes: int) -> str:
    raw = "".join(message.text for message in messages).encode(
        "utf-8", errors="replace"
    )
    if len(raw) <= max_bytes:
        return raw.decode("utf-8", errors="replace")

    marker = f"\n... [{len(raw) - max_bytes} output bytes omitted] ...\n".encode()
    head_size = min(max_bytes // 4, max_bytes - len(marker))
    tail_size = max_bytes - len(marker) - head_size
    bounded = raw[:head_size] + marker + raw[-tail_size:]
    return bounded.decode("utf-8", errors="replace")


class SandboxBackend(Protocol):
    async def create(
        self,
        *,
        image: str,
        host_path: Path,
        mount_path: str,
        git_common_host: Path | None,
        git_common_target: str | None,
        ttl_seconds: int,
        environment: dict[str, str],
        workspace_hash: str,
    ) -> str: ...

    async def execute(
        self,
        upstream_id: str,
        command: str,
        working_directory: str,
        timeout_seconds: int,
    ) -> BackendExecution: ...

    async def status(self, upstream_id: str) -> BackendStatus: ...

    async def renew(self, upstream_id: str, ttl_seconds: int) -> None: ...

    async def destroy(self, upstream_id: str) -> None: ...


class OpenSandboxBackend:
    def __init__(self, settings: Settings):
        self.settings = settings

    def _connection(self) -> ConnectionConfig:
        return ConnectionConfig(
            domain=self.settings.opensandbox_domain,
            api_key=self.settings.opensandbox_api_key,
            request_timeout=timedelta(
                seconds=max(self.settings.command_timeout_seconds + 120, 300)
            ),
            use_server_proxy=True,
        )

    def _network_policy(self) -> NetworkPolicy | None:
        if not self.settings.egress_allow:
            return None
        return NetworkPolicy(
            defaultAction="deny",
            egress=[
                NetworkRule(action="allow", target=target)
                for target in self.settings.egress_allow
            ],
        )

    async def create(
        self,
        *,
        image: str,
        host_path: Path,
        mount_path: str,
        git_common_host: Path | None,
        git_common_target: str | None,
        ttl_seconds: int,
        environment: dict[str, str],
        workspace_hash: str,
    ) -> str:
        volumes = [
            Volume(
                name="workspace",
                host=Host(path=str(host_path)),
                mountPath=mount_path,
                readOnly=False,
            ),
            Volume(
                name="agent-cache",
                pvc=PVC(claimName=self.settings.cache_volume),
                mountPath="/cache",
                readOnly=False,
            ),
        ]
        if git_common_host is not None and git_common_target is not None:
            volumes.append(
                Volume(
                    name="git-common",
                    host=Host(path=str(git_common_host)),
                    mountPath=git_common_target,
                    readOnly=False,
                )
            )

        sandbox = await Sandbox.create(
            image,
            connection_config=self._connection(),
            timeout=timedelta(seconds=ttl_seconds),
            ready_timeout=timedelta(seconds=90),
            resource={
                "cpu": self.settings.cpu_limit,
                "memory": self.settings.memory_limit,
            },
            env=environment,
            metadata={"t3.workspace": workspace_hash},
            network_policy=self._network_policy(),
            volumes=volumes,
            entrypoint=[
                "/bin/sh",
                "-c",
                "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
            ],
        )
        try:
            return sandbox.id
        finally:
            await sandbox.close()

    async def execute(
        self,
        upstream_id: str,
        command: str,
        working_directory: str,
        timeout_seconds: int,
    ) -> BackendExecution:
        sandbox = await Sandbox.connect(
            upstream_id,
            connection_config=self._connection(),
            connect_timeout=timedelta(seconds=30),
        )
        try:
            result = await sandbox.commands.run(
                command,
                opts=RunCommandOpts(
                    working_directory=working_directory,
                    timeout=timedelta(seconds=timeout_seconds),
                ),
            )
            return BackendExecution(
                exit_code=result.exit_code,
                stdout=_bounded_log(
                    result.logs.stdout, self.settings.max_output_bytes
                ),
                stderr=_bounded_log(
                    result.logs.stderr, self.settings.max_output_bytes
                ),
            )
        finally:
            await sandbox.close()

    async def status(self, upstream_id: str) -> BackendStatus:
        sandbox = await Sandbox.connect(
            upstream_id,
            connection_config=self._connection(),
            connect_timeout=timedelta(seconds=15),
            skip_health_check=True,
        )
        try:
            info = await sandbox.get_info()
            return BackendStatus(state=str(info.status.state))
        finally:
            await sandbox.close()

    async def renew(self, upstream_id: str, ttl_seconds: int) -> None:
        sandbox = await Sandbox.connect(
            upstream_id,
            connection_config=self._connection(),
            connect_timeout=timedelta(seconds=15),
            skip_health_check=True,
        )
        try:
            await sandbox.renew(timedelta(seconds=ttl_seconds))
        finally:
            await sandbox.close()

    async def destroy(self, upstream_id: str) -> None:
        sandbox = await Sandbox.connect(
            upstream_id,
            connection_config=self._connection(),
            connect_timeout=timedelta(seconds=15),
            skip_health_check=True,
        )
        try:
            await sandbox.kill()
        finally:
            await sandbox.close()
