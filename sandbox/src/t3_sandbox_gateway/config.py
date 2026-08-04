from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _integer(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean-like value")


def _required(name: str, file_name: str | None = None) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if file_name:
        path_value = os.environ.get(file_name, "").strip()
        if path_value:
            try:
                file_value = Path(path_value).read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise RuntimeError(f"could not read {file_name}") from exc
            if file_value:
                return file_value
    suffix = f" or {file_name}" if file_name else ""
    raise RuntimeError(f"{name}{suffix} is required")


def _optional_absolute_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        raise RuntimeError(f"{name} must be absolute when configured")
    return path


@dataclass(frozen=True, slots=True)
class Settings:
    gateway_token: str
    opensandbox_domain: str
    opensandbox_api_key: str
    client_workspace_root: str
    host_workspace_root: Path
    state_db: Path
    base_image: str
    cache_volume: str
    proton_pass_broker_host_path: Path | None
    ssh_host_path: Path | None
    devcontainer_user_data: Path
    devcontainer_enabled: bool
    devcontainer_feature_prefixes: tuple[str, ...]
    devcontainer_platform: str
    workspace_gid: int
    default_ttl_seconds: int
    max_ttl_seconds: int
    max_sandboxes: int
    command_timeout_seconds: int
    max_output_bytes: int
    build_timeout_seconds: int
    cpu_limit: str
    memory_limit: str
    egress_allow: tuple[str, ...]

    @classmethod
    def from_env(cls) -> Settings:
        prefixes = tuple(
            item.strip()
            for item in os.environ.get(
                "T3_SANDBOX_DEVCONTAINER_FEATURE_PREFIXES",
                "ghcr.io/devcontainers/features/,ghcr.io/devcontainers-extra/features/",
            ).split(",")
            if item.strip()
        )
        egress_allow = tuple(
            item.strip()
            for item in os.environ.get("T3_SANDBOX_EGRESS_ALLOW", "").split(",")
            if item.strip()
        )
        default_ttl = _integer("T3_SANDBOX_DEFAULT_TTL_SECONDS", 7200, 60)
        max_ttl = _integer("T3_SANDBOX_MAX_TTL_SECONDS", 28800, 60)
        if default_ttl > max_ttl:
            raise RuntimeError(
                "T3_SANDBOX_DEFAULT_TTL_SECONDS cannot exceed T3_SANDBOX_MAX_TTL_SECONDS"
            )

        return cls(
            gateway_token=_required(
                "T3_SANDBOX_GATEWAY_TOKEN", "T3_SANDBOX_GATEWAY_TOKEN_FILE"
            ),
            opensandbox_domain=os.environ.get(
                "OPEN_SANDBOX_DOMAIN", "opensandbox:8080"
            ).strip(),
            opensandbox_api_key=_required(
                "OPEN_SANDBOX_API_KEY", "OPEN_SANDBOX_API_KEY_FILE"
            ),
            client_workspace_root=os.environ.get(
                "T3_SANDBOX_CLIENT_WORKSPACE_ROOT", "/workspace"
            ).rstrip("/"),
            host_workspace_root=Path(
                os.environ.get("T3_SANDBOX_HOST_WORKSPACE_ROOT", "/workspaces")
            ),
            state_db=Path(
                os.environ.get("T3_SANDBOX_STATE_DB", "/data/t3-sandbox-gateway.sqlite3")
            ),
            base_image=os.environ.get(
                "T3_SANDBOX_BASE_IMAGE",
                "ghcr.io/traktuner/docker-t3-code:agent-base",
            ).strip(),
            cache_volume=os.environ.get(
                "T3_SANDBOX_CACHE_VOLUME", "t3-sandbox-agent-cache"
            ).strip(),
            proton_pass_broker_host_path=_optional_absolute_path(
                "T3_SANDBOX_PROTON_PASS_BROKER_HOST_PATH"
            ),
            ssh_host_path=_optional_absolute_path("T3_SANDBOX_SSH_HOST_PATH"),
            devcontainer_user_data=Path(
                os.environ.get("T3_SANDBOX_DEVCONTAINER_USER_DATA", "/data/devcontainers")
            ),
            devcontainer_enabled=_boolean("T3_SANDBOX_DEVCONTAINER_ENABLED", True),
            devcontainer_feature_prefixes=prefixes,
            devcontainer_platform=os.environ.get(
                "T3_SANDBOX_DEVCONTAINER_PLATFORM", "linux/amd64"
            ).strip(),
            workspace_gid=_integer("T3_SANDBOX_WORKSPACE_GID", 3001),
            default_ttl_seconds=default_ttl,
            max_ttl_seconds=max_ttl,
            max_sandboxes=_integer("T3_SANDBOX_MAX_CONCURRENT", 4),
            command_timeout_seconds=_integer(
                "T3_SANDBOX_MAX_COMMAND_SECONDS", 1800, 1
            ),
            max_output_bytes=_integer(
                "T3_SANDBOX_MAX_OUTPUT_BYTES", 262144, 4096
            ),
            build_timeout_seconds=_integer(
                "T3_SANDBOX_DEVCONTAINER_BUILD_SECONDS", 3600, 60
            ),
            cpu_limit=os.environ.get("T3_SANDBOX_CPU_LIMIT", "4").strip(),
            memory_limit=os.environ.get("T3_SANDBOX_MEMORY_LIMIT", "8Gi").strip(),
            egress_allow=egress_allow,
        )
