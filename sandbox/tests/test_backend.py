from dataclasses import dataclass
from pathlib import Path

import pytest
from t3_sandbox_gateway.backend import OpenSandboxBackend, _bounded_log
from t3_sandbox_gateway.config import Settings


@dataclass
class Message:
    text: str


def test_bounded_log_keeps_short_output() -> None:
    assert _bounded_log([Message("hello"), Message(" world")], 4096) == "hello world"


def test_bounded_log_keeps_head_and_tail() -> None:
    output = _bounded_log([Message("start-" + ("x" * 5000) + "-failure")], 4096)

    assert output.startswith("start-")
    assert "output bytes omitted" in output
    assert output.endswith("-failure")
    assert len(output.encode()) <= 4096


@pytest.mark.asyncio
async def test_create_mounts_broker_and_ssh_for_infra_worker(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    class CreatedSandbox:
        id = "sandbox-test"

        async def close(self) -> None:
            return None

    async def create(*_args, **kwargs):
        captured.update(kwargs)
        return CreatedSandbox()

    monkeypatch.setattr("t3_sandbox_gateway.backend.Sandbox.create", create)
    settings = Settings(
        gateway_token="test",
        opensandbox_domain="opensandbox:8080",
        opensandbox_api_key="test",
        client_workspace_root="/workspace",
        host_workspace_root=tmp_path,
        state_db=tmp_path / "state.db",
        base_image="agent-base:test",
        cache_volume="cache",
        proton_pass_broker_host_path=Path("/srv/t3/proton-pass/run"),
        ssh_host_path=Path("/srv/semaphore/ssh-keys"),
        devcontainer_user_data=tmp_path / "devcontainers",
        devcontainer_enabled=True,
        devcontainer_feature_prefixes=(),
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

    result = await OpenSandboxBackend(settings).create(
        image="agent-base:test",
        host_path=tmp_path,
        mount_path="/workspace/repo",
        git_common_host=None,
        git_common_target=None,
        ttl_seconds=600,
        environment={},
        workspace_hash="test",
    )

    assert result == "sandbox-test"
    mounts = {volume.mount_path: volume for volume in captured["volumes"]}
    assert mounts["/run/proton-pass"].host.path == "/srv/t3/proton-pass/run"
    assert mounts["/run/proton-pass"].read_only is True
    assert mounts["/home/agent/.ssh"].host.path == "/srv/semaphore/ssh-keys"
    assert mounts["/home/agent/.ssh"].read_only is True
