from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import json5

from .config import Settings


class DevContainerError(RuntimeError):
    pass


LifecycleCommand = str | list[str]


@dataclass(frozen=True, slots=True)
class LifecycleStage:
    name: str
    commands: tuple[LifecycleCommand, ...]


@dataclass(frozen=True, slots=True)
class DevContainerPlan:
    image: str
    environment: dict[str, str]
    lifecycle: tuple[LifecycleStage, ...]
    image_path: str


FORBIDDEN_KEYS = {
    "capAdd",
    "dockerComposeFile",
    "initializeCommand",
    "mounts",
    "privileged",
    "runArgs",
    "securityOpt",
    "workspaceFolder",
    "workspaceMount",
}
FORBIDDEN_TEXT = (
    "/var/run/docker.sock",
    "/run/docker.sock",
    "--privileged",
    "--cap-add",
    "--security-opt",
)
LIFECYCLE_KEYS = (
    "onCreateCommand",
    "updateContentCommand",
    "postCreateCommand",
    "postStartCommand",
)
USER_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$")
WORKSPACE_WRAPPER_DOCKERFILE = r"""# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG ORIGINAL_USER
ARG WORKSPACE_GID
USER root
RUN set -eu; \
    identity="${ORIGINAL_USER%%:*}"; \
    user_name="$(awk -F: -v identity="$identity" \
      '$1 == identity || $3 == identity { print $1; exit }' /etc/passwd)"; \
    if [ -z "$user_name" ]; then \
      echo "Devcontainer USER is absent from /etc/passwd" >&2; \
      exit 1; \
    fi; \
    group_name="$(awk -F: -v gid="$WORKSPACE_GID" '$3 == gid { print $1; exit }' /etc/group)"; \
    if [ -z "$group_name" ]; then \
      group_name="t3-workspace-$WORKSPACE_GID"; \
      if command -v groupadd >/dev/null 2>&1; then \
        groupadd --gid "$WORKSPACE_GID" "$group_name"; \
      elif command -v addgroup >/dev/null 2>&1; then \
        addgroup -g "$WORKSPACE_GID" "$group_name"; \
      else \
        echo "Devcontainer image has no supported group management command" >&2; exit 1; \
      fi; \
    fi; \
    member=0; \
    for gid in $(id -G "$user_name"); do [ "$gid" != "$WORKSPACE_GID" ] || member=1; done; \
    if [ "$member" = 0 ]; then \
      if command -v usermod >/dev/null 2>&1; then \
        usermod -aG "$group_name" "$user_name"; \
      elif command -v addgroup >/dev/null 2>&1; then \
        addgroup "$user_name" "$group_name"; \
      else \
        echo "Devcontainer image has no supported user management command" >&2; exit 1; \
      fi; \
    fi; \
    mkdir -p /cache; \
    chmod 0777 /cache
USER ${ORIGINAL_USER}
"""


def find_devcontainer(workspace: Path) -> Path | None:
    candidates = (
        workspace / ".devcontainer" / "devcontainer.json",
        workspace / ".devcontainer.json",
    )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _walk(value: Any):
    yield value
    if isinstance(value, dict):
        for nested in value.values():
            yield from _walk(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk(nested)


def _normalize_lifecycle(value: Any, key: str) -> tuple[LifecycleCommand, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return ([*value],)
    if isinstance(value, dict):
        commands: list[LifecycleCommand] = []
        for name, command in value.items():
            if isinstance(command, str):
                commands.append(command)
            elif isinstance(command, list) and all(isinstance(item, str) for item in command):
                commands.append([*command])
            else:
                raise DevContainerError(f"{key}.{name} must be a string or string array")
        return tuple(commands)
    raise DevContainerError(f"{key} must be a string, string array, or command object")


def lifecycle_shell_command(command: LifecycleCommand) -> str:
    return command if isinstance(command, str) else shlex.join(command)


def _metadata_configs(
    config: dict[str, Any], image_config: dict[str, Any]
) -> list[dict[str, Any]]:
    labels = image_config.get("Labels") or {}
    raw = labels.get("devcontainer.metadata") if isinstance(labels, dict) else None
    if not raw:
        return [config]
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise DevContainerError("built image contains invalid devcontainer.metadata") from exc
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        raise DevContainerError("built image devcontainer.metadata must be an object array")
    return parsed


def _validate_runtime_metadata(configs: list[dict[str, Any]]) -> None:
    for config in configs:
        present_forbidden = sorted(key for key in FORBIDDEN_KEYS if key in config)
        if present_forbidden:
            raise DevContainerError(
                "built devcontainer metadata requests unsupported runtime options: "
                + ", ".join(present_forbidden)
            )
        for item in _walk(config):
            if not isinstance(item, str):
                continue
            lowered = item.lower()
            if "${localenv:" in lowered or any(
                marker in lowered for marker in FORBIDDEN_TEXT
            ):
                raise DevContainerError("built devcontainer metadata requests host access")


class DevContainerBuilder:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._locks: dict[str, asyncio.Lock] = {}

    def load_and_validate(self, workspace: Path) -> tuple[Path, dict[str, Any]]:
        config_path = find_devcontainer(workspace)
        if config_path is None:
            raise DevContainerError("workspace does not contain a devcontainer.json")
        try:
            config = json5.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DevContainerError(f"invalid devcontainer config: {exc}") from exc
        if not isinstance(config, dict):
            raise DevContainerError("devcontainer config must be an object")

        present_forbidden = sorted(key for key in FORBIDDEN_KEYS if key in config)
        if present_forbidden:
            raise DevContainerError(
                "unsupported host-affecting devcontainer options: "
                + ", ".join(present_forbidden)
            )

        for item in _walk(config):
            if not isinstance(item, str):
                continue
            lowered = item.lower()
            if "${localenv:" in lowered:
                raise DevContainerError("${localEnv:...} expansion is not allowed")
            if any(marker in lowered for marker in FORBIDDEN_TEXT):
                raise DevContainerError("devcontainer config requests host-level Docker access")

        features = config.get("features", {})
        if not isinstance(features, dict):
            raise DevContainerError("features must be an object")
        for feature in features:
            if not any(
                str(feature).startswith(prefix)
                for prefix in self.settings.devcontainer_feature_prefixes
            ):
                raise DevContainerError(
                    f"feature is outside the configured registry allowlist: {feature}"
                )

        build = config.get("build")
        if build is not None:
            if not isinstance(build, dict):
                raise DevContainerError("build must be an object")
            if "options" in build:
                raise DevContainerError("build.options is not allowed")
            context = build.get("context", ".")
            if not isinstance(context, str):
                raise DevContainerError("build.context must be a string")
            resolved_context = (config_path.parent / context).resolve()
            if (
                not resolved_context.is_dir()
                or not resolved_context.is_relative_to(workspace.resolve())
            ):
                raise DevContainerError("build.context must stay inside the workspace")
            dockerfile = build.get("dockerfile", "Dockerfile")
            if not isinstance(dockerfile, str):
                raise DevContainerError("build.dockerfile must be a string")
            resolved_dockerfile = (config_path.parent / dockerfile).resolve()
            if (
                not resolved_dockerfile.is_file()
                or not resolved_dockerfile.is_relative_to(workspace.resolve())
            ):
                raise DevContainerError("build.dockerfile must stay inside the workspace")

        for env_key in ("containerEnv", "remoteEnv"):
            environment = config.get(env_key, {})
            if not isinstance(environment, dict) or not all(
                isinstance(key, str) and isinstance(value, (str, int, float, bool))
                for key, value in environment.items()
            ):
                raise DevContainerError(f"{env_key} must contain scalar environment values")

        return config_path, config

    async def build(self, workspace: Path) -> DevContainerPlan:
        config_path, config = self.load_and_validate(workspace)
        key = hashlib.sha256(str(workspace).encode()).hexdigest()[:16]
        image = f"t3-agent-devcontainer:{key}"
        raw_image = f"t3-agent-devcontainer:raw-{key}"
        user_data = self.settings.devcontainer_user_data / key
        user_data.mkdir(parents=True, exist_ok=True)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            await self._run(
                "devcontainer",
                "build",
                "--workspace-folder",
                str(workspace),
                "--config",
                str(config_path),
                "--image-name",
                raw_image,
                "--platform",
                self.settings.devcontainer_platform,
                "--user-data-folder",
                str(user_data),
                "--no-lockfile",
                timeout=self.settings.build_timeout_seconds,
                failure="devcontainer image build failed",
            )
            image_config = await self._inspect_image(raw_image)
            user = str(image_config.get("User") or "").strip()
            if user.lower() in {"", "0", "0:0", "root", "root:root"}:
                raise DevContainerError(
                    "devcontainer image must declare a non-root USER; root images are rejected"
                )
            if not USER_PATTERN.fullmatch(user):
                raise DevContainerError("devcontainer image declares an unsupported USER value")
            configs = _metadata_configs(config, image_config)
            _validate_runtime_metadata(configs)
            await self._wrap_image(raw_image, image, user)

        image_environment = {}
        for item in image_config.get("Env") or []:
            if isinstance(item, str) and "=" in item:
                name, value = item.split("=", 1)
                image_environment[name] = value

        environment = {
            str(key): str(value)
            for env_key in ("containerEnv", "remoteEnv")
            for metadata in configs
            for key, value in metadata.get(env_key, {}).items()
        }
        lifecycle = tuple(
            LifecycleStage(name=key, commands=commands)
            for key in LIFECYCLE_KEYS
            if (
                commands := tuple(
                    command
                    for metadata in configs
                    for command in _normalize_lifecycle(metadata.get(key), key)
                )
            )
        )
        return DevContainerPlan(
            image=image,
            environment=environment,
            lifecycle=lifecycle,
            image_path=image_environment.get(
                "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ),
        )

    async def _wrap_image(self, base_image: str, image: str, user: str) -> None:
        context = self.settings.devcontainer_user_data / "wrapper-context"
        context.mkdir(parents=True, exist_ok=True)
        await self._run(
            "docker",
            "build",
            "--file",
            "-",
            "--tag",
            image,
            "--build-arg",
            f"BASE_IMAGE={base_image}",
            "--build-arg",
            f"ORIGINAL_USER={user}",
            "--build-arg",
            f"WORKSPACE_GID={self.settings.workspace_gid}",
            str(context),
            input_text=WORKSPACE_WRAPPER_DOCKERFILE,
            timeout=self.settings.build_timeout_seconds,
            failure="could not prepare devcontainer workspace permissions",
        )

    async def _inspect_image(self, image: str) -> dict[str, Any]:
        output = await self._run(
            "docker",
            "image",
            "inspect",
            image,
            "--format",
            "{{json .Config}}",
            timeout=60,
            failure="could not inspect built devcontainer image",
        )
        try:
            value = json.loads(output)
        except json.JSONDecodeError as exc:
            raise DevContainerError("Docker returned invalid image metadata") from exc
        if not isinstance(value, dict):
            raise DevContainerError("Docker image metadata is not an object")
        return value

    @staticmethod
    async def _run(
        *args: str,
        input_text: str | None = None,
        timeout: int,
        failure: str,
    ) -> str:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            input_bytes = input_text.encode() if input_text is not None else None
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(input_bytes), timeout=timeout
            )
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise DevContainerError(f"{failure}: timed out after {timeout}s") from exc
        if process.returncode != 0:
            raise DevContainerError(f"{failure}: exit code {process.returncode}")
        return stdout.decode("utf-8", errors="replace").strip()
