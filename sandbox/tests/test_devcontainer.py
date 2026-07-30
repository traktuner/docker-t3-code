import json
from pathlib import Path

import pytest
from t3_sandbox_gateway.config import Settings
from t3_sandbox_gateway.devcontainer import (
    DevContainerBuilder,
    DevContainerError,
    _metadata_configs,
    _validate_runtime_metadata,
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


def write_config(workspace: Path, content: str) -> None:
    config_dir = workspace / ".devcontainer"
    config_dir.mkdir(parents=True)
    (config_dir / "devcontainer.json").write_text(content, encoding="utf-8")


def test_accepts_safe_image_config(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(
        workspace,
        """
        {
          // JSONC is part of the devcontainer format.
          "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
          "remoteUser": "vscode",
          "features": {
            "ghcr.io/devcontainers/features/git:1": {}
          },
          "postCreateCommand": ["npm", "install"]
        }
        """,
    )

    _path, config = DevContainerBuilder(settings(tmp_path)).load_and_validate(workspace)

    assert config["remoteUser"] == "vscode"


@pytest.mark.asyncio
async def test_build_wraps_non_root_user_with_workspace_group(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(workspace, '{"image":"example.invalid/dev:latest"}')
    builder = DevContainerBuilder(settings(tmp_path))
    calls = []

    async def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        if args[:3] == ("docker", "image", "inspect"):
            return json.dumps(
                {
                    "User": "vscode",
                    "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
                    "Labels": {},
                }
            )
        return ""

    builder._run = fake_run
    plan = await builder.build(workspace)

    assert plan.image.startswith("t3-agent-devcontainer:")
    assert any(
        any(arg.startswith("t3-agent-devcontainer:raw-") for arg in args)
        for args, _kwargs in calls
    )
    wrapper = next(kwargs for args, kwargs in calls if args[:2] == ("docker", "build"))
    assert "WORKSPACE_GID=3001" in calls[-1][0]
    assert "CREATE_USER=0" in calls[-1][0]
    assert "usermod -aG" in wrapper["input_text"]


@pytest.mark.asyncio
async def test_build_creates_non_root_user_for_root_base_image(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(workspace, '{"image":"debian:bookworm"}')
    builder = DevContainerBuilder(settings(tmp_path))
    calls = []

    async def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        if args[:3] == ("docker", "image", "inspect"):
            return json.dumps({"User": "root", "Env": [], "Labels": {}})
        return ""

    builder._run = fake_run
    plan = await builder.build(workspace)

    assert plan.image.startswith("t3-agent-devcontainer:")
    assert "ORIGINAL_USER=t3sandbox" in calls[-1][0]
    assert "CREATE_USER=1" in calls[-1][0]
    assert (
        'useradd --create-home --user-group --shell /bin/sh "$identity"'
        in calls[-1][1]["input_text"]
    )


@pytest.mark.asyncio
async def test_build_rejects_explicit_root_user(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(workspace, '{"image":"debian:bookworm","remoteUser":"root"}')
    builder = DevContainerBuilder(settings(tmp_path))

    async def fake_run(*args, **kwargs):
        if args[:3] == ("docker", "image", "inspect"):
            return json.dumps({"User": "root", "Env": [], "Labels": {}})
        return ""

    builder._run = fake_run
    with pytest.raises(DevContainerError, match="must not select the root user"):
        await builder.build(workspace)


@pytest.mark.parametrize(
    "fragment",
    [
        '"privileged": true',
        '"mounts": ["source=/,target=/host,type=bind"]',
        '"initializeCommand": "touch /tmp/host-side"',
        '"runArgs": ["--cap-add=SYS_ADMIN"]',
    ],
)
def test_rejects_host_affecting_options(tmp_path: Path, fragment: str):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(workspace, "{" + fragment + "}")

    with pytest.raises(DevContainerError):
        DevContainerBuilder(settings(tmp_path)).load_and_validate(workspace)


def test_rejects_unlisted_feature_registry(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(
        workspace,
        '{"image":"ubuntu", "features":{"ghcr.io/example/feature:1":{}}}',
    )

    with pytest.raises(DevContainerError):
        DevContainerBuilder(settings(tmp_path)).load_and_validate(workspace)


def test_rejects_build_context_outside_workspace(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    write_config(workspace, '{"build":{"dockerfile":"Dockerfile","context":"../.."}}')

    with pytest.raises(DevContainerError):
        DevContainerBuilder(settings(tmp_path)).load_and_validate(workspace)


def test_rejects_dockerfile_outside_workspace(tmp_path: Path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    (tmp_path / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    write_config(
        workspace,
        '{"build":{"dockerfile":"../../Dockerfile","context":".."}}',
    )

    with pytest.raises(DevContainerError):
        DevContainerBuilder(settings(tmp_path)).load_and_validate(workspace)


def test_uses_built_feature_metadata_when_present():
    metadata = [
        {"containerEnv": {"FROM_FEATURE": "1"}, "postCreateCommand": "feature-init"},
        {"remoteEnv": {"FROM_PROJECT": "1"}, "postCreateCommand": ["npm", "install"]},
    ]
    image_config = {"Labels": {"devcontainer.metadata": json.dumps(metadata)}}

    assert _metadata_configs({"image": "ignored"}, image_config) == metadata


def test_rejects_privileged_built_feature_metadata():
    with pytest.raises(DevContainerError):
        _validate_runtime_metadata([{"mounts": ["source=/,target=/host,type=bind"]}])
