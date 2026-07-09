#!/usr/bin/env python3
import base64
import json
import os
from pathlib import Path
import stat
import sys
import tomllib


PROVIDER_DEFAULT_MODELS = {
    "codex": "gpt-5.4-mini",
    "claudeAgent": "claude-haiku-4-5",
    "cursor": "composer-2",
    "grok": "grok-build",
    "opencode": "openai/gpt-5",
}

DEFAULT_PROVIDER_ENV = {
    "codex": [
        {"name": "OPENAI_API_KEY", "from_env": "OPENAI_API_KEY", "sensitive": True},
        {"name": "OPENAI_BASE_URL", "from_env": "OPENAI_BASE_URL"},
        {"name": "OPENAI_ORG_ID", "from_env": "OPENAI_ORG_ID"},
        {"name": "OPENAI_PROJECT_ID", "from_env": "OPENAI_PROJECT_ID"},
    ],
    "claude": [
        {"name": "ANTHROPIC_API_KEY", "from_env": "ANTHROPIC_API_KEY", "sensitive": True},
        {"name": "ANTHROPIC_AUTH_TOKEN", "from_env": "ANTHROPIC_AUTH_TOKEN", "sensitive": True},
        {"name": "ANTHROPIC_BASE_URL", "from_env": "ANTHROPIC_BASE_URL"},
        {"name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "from_env": "ANTHROPIC_DEFAULT_OPUS_MODEL"},
        {"name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "from_env": "ANTHROPIC_DEFAULT_SONNET_MODEL"},
        {"name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "from_env": "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
        {"name": "CLAUDE_CODE_SUBAGENT_MODEL", "from_env": "CLAUDE_CODE_SUBAGENT_MODEL"},
    ],
    "opencode": [
        {"name": "OPENCODE_API_KEY", "from_env": "OPENCODE_API_KEY", "sensitive": True},
        {"name": "LUMO_API_KEY", "from_env": "LUMO_API_KEY", "sensitive": True},
        {"name": "OPENAI_API_KEY", "from_env": "OPENAI_API_KEY", "sensitive": True},
        {"name": "ANTHROPIC_API_KEY", "from_env": "ANTHROPIC_API_KEY", "sensitive": True},
        {"name": "OPENROUTER_API_KEY", "from_env": "OPENROUTER_API_KEY", "sensitive": True},
        {"name": "GEMINI_API_KEY", "from_env": "GEMINI_API_KEY", "sensitive": True},
        {"name": "GOOGLE_GENERATIVE_AI_API_KEY", "from_env": "GOOGLE_GENERATIVE_AI_API_KEY", "sensitive": True},
        {"name": "XAI_API_KEY", "from_env": "XAI_API_KEY", "sensitive": True},
    ],
    "grok": [
        {"name": "GROK_DEPLOYMENT_KEY", "from_env": "GROK_DEPLOYMENT_KEY", "sensitive": True},
        {"name": "GROK_PROXY_URL", "from_env": "GROK_PROXY_URL"},
        {"name": "GROK_CHANNEL", "from_env": "GROK_CHANNEL"},
        {"name": "XAI_API_KEY", "from_env": "XAI_API_KEY", "sensitive": True},
    ],
}


def read_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as fh:
        return tomllib.load(fh)


def env_bool(name: str):
    raw = os.environ.get(name)
    if raw is None:
        return None
    lowered = raw.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise SystemExit(f"{name} must be a boolean-like value, got {raw!r}")


def to_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise SystemExit(f"Expected boolean-like value, got {value!r}")


def cfg_get(mapping: dict, key: str, default=None):
    value = mapping.get(key)
    return default if value is None else value


def env_or_cfg(env_name: str, mapping: dict, key: str, default):
    value = os.environ.get(env_name)
    if value is not None and value != "":
        return value
    return cfg_get(mapping, key, default)


def env_or_cfg_optional(env_name: str, mapping: dict, key: str):
    value = os.environ.get(env_name)
    if value is not None and value != "":
        return value
    value = mapping.get(key)
    if value is None or value == "":
        return None
    return value


def env_or_cfg_bool(env_name: str, mapping: dict, key: str, default: bool) -> bool:
    env_value = env_bool(env_name)
    if env_value is not None:
        return env_value
    return to_bool(mapping.get(key), default)


def env_or_cfg_list(env_name: str, mapping: dict, key: str) -> list[str]:
    raw = os.environ.get(env_name)
    if raw is not None:
        return [item.strip() for item in raw.split(",") if item.strip()]
    return list(mapping.get(key, []))


def env_json_list(env_name: str) -> list[dict]:
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return []
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{env_name} must be JSON: {exc}") from exc
    if not isinstance(decoded, list) or not all(isinstance(item, dict) for item in decoded):
        raise SystemExit(f"{env_name} must be a JSON array of objects")
    return decoded


def secret_file_name(instance_id: str, env_name: str) -> str:
    def encode(value: str) -> str:
        return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")

    return f"provider-env-{encode(instance_id)}-{encode(env_name)}.bin"


def looks_sensitive(name: str) -> bool:
    upper = name.upper()
    return any(marker in upper for marker in ("KEY", "TOKEN", "SECRET", "PASSWORD"))


def normalize_env_entries(provider_key: str, configured_entries: list, instance_id: str, secrets_dir: Path):
    by_name = {entry["name"]: entry for entry in DEFAULT_PROVIDER_ENV.get(provider_key, [])}
    for entry in configured_entries:
        if "name" not in entry:
            raise SystemExit(f"providers.{provider_key}.env entry is missing name")
        by_name[str(entry["name"])] = entry

    rendered = []
    secrets_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(secrets_dir, stat.S_IRWXU)

    for name in sorted(by_name):
        entry = by_name[name]
        from_env = entry.get("from_env", name)
        include_empty = to_bool(entry.get("include_empty"), False)
        if "value" in entry:
            value = str(entry["value"])
        else:
            value = os.environ.get(str(from_env), "")

        if value == "" and not include_empty:
            continue

        sensitive = to_bool(entry.get("sensitive"), looks_sensitive(name))
        if sensitive:
            secret_path = secrets_dir / secret_file_name(instance_id, name)
            secret_path.write_bytes(value.encode("utf-8"))
            os.chmod(secret_path, stat.S_IRUSR | stat.S_IWUSR)
            rendered.append(
                {
                    "name": name,
                    "value": "",
                    "sensitive": True,
                    "valueRedacted": True,
                }
            )
        else:
            rendered.append({"name": name, "value": value, "sensitive": False})

    return rendered


def provider_enabled(config: dict, provider_key: str, env_name: str, default: bool) -> bool:
    provider = config.get("providers", {}).get(provider_key, {})
    return env_or_cfg_bool(env_name, provider, "enabled", default)


def provider_update_enabled(updates: dict, key: str, provider_is_enabled: bool, install_disabled: bool) -> bool:
    env_value = env_bool(f"T3_UPDATE_{key.upper()}")
    if env_value is not None:
        return env_value
    default = install_disabled
    return to_bool(updates.get(key), default)


def write_runtime_env(path: Path, values: dict):
    lines = []
    for key, value in values.items():
        escaped = str(value).replace("'", "'\"'\"'")
        lines.append(f"{key}='{escaped}'")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    config_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/config/t3code.toml")
    runtime_env_path = Path(sys.argv[2] if len(sys.argv) > 2 else "/run/t3-docker/runtime.env")
    config = read_toml(config_path)

    server = config.get("server", {})
    auth = config.get("auth", {})
    updates = config.get("updates", {})
    providers = config.get("providers", {})

    t3_home = str(env_or_cfg("T3CODE_HOME", server, "t3_home", "/data/t3"))
    t3_home_path = Path(t3_home)
    state_dir = t3_home_path / "userdata"
    settings_path = state_dir / "settings.json"
    secrets_dir = state_dir / "secrets"
    state_dir.mkdir(parents=True, exist_ok=True)

    server_host = str(env_or_cfg("T3_SERVER_HOST", server, "host", "0.0.0.0"))
    server_port = int(env_or_cfg("T3_SERVER_PORT", server, "port", 3773))
    workdir = str(env_or_cfg("T3_WORKDIR", server, "workdir", "/workspace"))
    auto_bootstrap = env_or_cfg_bool(
        "T3_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
        server,
        "auto_bootstrap_project_from_cwd",
        True,
    )
    auth_proxy = env_or_cfg_bool("T3_AUTH_PROXY", auth, "proxy", False)
    auth_proxy_internal_host = str(
        env_or_cfg("T3_AUTH_PROXY_INTERNAL_HOST", auth, "internal_host", "127.0.0.1")
    )
    auth_proxy_internal_port = int(
        env_or_cfg("T3_AUTH_PROXY_INTERNAL_PORT", auth, "internal_port", 13773)
    )
    auth_proxy_admin_ttl = str(
        env_or_cfg("T3_AUTH_PROXY_ADMIN_TTL", auth, "admin_ttl", "2m")
    )

    codex_enabled = provider_enabled(config, "codex", "T3_PROVIDER_CODEX", True)
    claude_enabled = provider_enabled(config, "claude", "T3_PROVIDER_CLAUDE", True)
    cursor_enabled = provider_enabled(config, "cursor", "T3_PROVIDER_CURSOR", True)
    grok_enabled = provider_enabled(config, "grok", "T3_PROVIDER_GROK", True)
    opencode_enabled = provider_enabled(config, "opencode", "T3_PROVIDER_OPENCODE", True)

    codex_cfg = providers.get("codex", {})
    claude_cfg = providers.get("claude", {})
    cursor_cfg = providers.get("cursor", {})
    grok_cfg = providers.get("grok", {})
    opencode_cfg = providers.get("opencode", {})
    codex_env = list(codex_cfg.get("env", [])) + env_json_list("T3_CODEX_ENV_JSON")
    claude_env = list(claude_cfg.get("env", [])) + env_json_list("T3_CLAUDE_ENV_JSON")
    cursor_env = list(cursor_cfg.get("env", [])) + env_json_list("T3_CURSOR_ENV_JSON")
    grok_env = list(grok_cfg.get("env", [])) + env_json_list("T3_GROK_ENV_JSON")
    opencode_env = list(opencode_cfg.get("env", [])) + env_json_list("T3_OPENCODE_ENV_JSON")

    opencode_config_content = env_or_cfg_optional(
        "T3_OPENCODE_CONFIG_CONTENT",
        opencode_cfg,
        "config_content",
    )
    opencode_config_source = env_or_cfg_optional(
        "T3_OPENCODE_CONFIG_SOURCE",
        opencode_cfg,
        "config_source",
    )
    opencode_config_path = str(
        env_or_cfg(
            "T3_OPENCODE_CONFIG_PATH",
            opencode_cfg,
            "config_path",
            "/data/home/.config/opencode/opencode.json",
        )
    )
    opencode_config_effective = ""
    if opencode_config_content is not None:
        opencode_config_file = Path(opencode_config_path)
        opencode_config_file.parent.mkdir(parents=True, exist_ok=True)
        opencode_config_file.write_text(str(opencode_config_content), encoding="utf-8")
        os.chmod(opencode_config_file, stat.S_IRUSR | stat.S_IWUSR)
        opencode_config_effective = opencode_config_path
    elif opencode_config_source is not None:
        opencode_config_effective = str(opencode_config_source)
    elif env_or_cfg_optional("T3_OPENCODE_CONFIG_PATH", opencode_cfg, "config_path") is not None:
        opencode_config_effective = opencode_config_path

    opencode_managed_server = env_or_cfg_bool(
        "T3_OPENCODE_MANAGED_SERVER",
        opencode_cfg,
        "managed_server",
        opencode_config_effective != "",
    )
    opencode_managed_host = str(
        env_or_cfg("T3_OPENCODE_MANAGED_HOST", opencode_cfg, "managed_host", "127.0.0.1")
    )
    opencode_managed_port = int(
        env_or_cfg("T3_OPENCODE_MANAGED_PORT", opencode_cfg, "managed_port", 4096)
    )
    opencode_managed_url = f"http://{opencode_managed_host}:{opencode_managed_port}"
    opencode_server_url = env_or_cfg_optional(
        "T3_OPENCODE_SERVER_URL",
        opencode_cfg,
        "server_url",
    )
    if opencode_server_url is None:
        opencode_server_url = opencode_managed_url if opencode_managed_server else ""

    provider_default_models = dict(PROVIDER_DEFAULT_MODELS)
    provider_default_models["opencode"] = str(
        env_or_cfg(
            "T3_OPENCODE_DEFAULT_MODEL",
            opencode_cfg,
            "default_model",
            PROVIDER_DEFAULT_MODELS["opencode"],
        )
    )

    provider_instances = {
        "codex": {
            "driver": "codex",
            "displayName": str(env_or_cfg("T3_CODEX_DISPLAY_NAME", codex_cfg, "display_name", "Codex")),
            "enabled": codex_enabled,
            "environment": normalize_env_entries(
                "codex",
                codex_env,
                "codex",
                secrets_dir,
            ),
            "config": {
                "enabled": codex_enabled,
                "binaryPath": str(env_or_cfg("T3_CODEX_BINARY_PATH", codex_cfg, "binary_path", "codex")),
                "homePath": str(env_or_cfg("T3_CODEX_HOME_PATH", codex_cfg, "home_path", "/data/codex")),
                "shadowHomePath": str(env_or_cfg("T3_CODEX_SHADOW_HOME_PATH", codex_cfg, "shadow_home_path", "")),
                "customModels": env_or_cfg_list("T3_CODEX_CUSTOM_MODELS", codex_cfg, "custom_models"),
            },
        },
        "claudeAgent": {
            "driver": "claudeAgent",
            "displayName": str(env_or_cfg("T3_CLAUDE_DISPLAY_NAME", claude_cfg, "display_name", "Claude")),
            "enabled": claude_enabled,
            "environment": normalize_env_entries(
                "claude",
                claude_env,
                "claudeAgent",
                secrets_dir,
            ),
            "config": {
                "enabled": claude_enabled,
                "binaryPath": str(env_or_cfg("T3_CLAUDE_BINARY_PATH", claude_cfg, "binary_path", "claude")),
                "homePath": str(env_or_cfg("T3_CLAUDE_HOME_PATH", claude_cfg, "home_path", "/data/claude-home")),
                "customModels": env_or_cfg_list("T3_CLAUDE_CUSTOM_MODELS", claude_cfg, "custom_models"),
                "launchArgs": str(env_or_cfg("T3_CLAUDE_LAUNCH_ARGS", claude_cfg, "launch_args", "")),
            },
        },
        "cursor": {
            "driver": "cursor",
            "displayName": str(env_or_cfg("T3_CURSOR_DISPLAY_NAME", cursor_cfg, "display_name", "Cursor")),
            "enabled": cursor_enabled,
            "environment": normalize_env_entries(
                "cursor",
                cursor_env,
                "cursor",
                secrets_dir,
            ),
            "config": {
                "enabled": cursor_enabled,
                "binaryPath": str(env_or_cfg("T3_CURSOR_BINARY_PATH", cursor_cfg, "binary_path", "agent")),
                "apiEndpoint": str(env_or_cfg("T3_CURSOR_API_ENDPOINT", cursor_cfg, "api_endpoint", "")),
                "customModels": env_or_cfg_list("T3_CURSOR_CUSTOM_MODELS", cursor_cfg, "custom_models"),
            },
        },
        "grok": {
            "driver": "grok",
            "displayName": str(env_or_cfg("T3_GROK_DISPLAY_NAME", grok_cfg, "display_name", "Grok")),
            "enabled": grok_enabled,
            "environment": normalize_env_entries(
                "grok",
                grok_env,
                "grok",
                secrets_dir,
            ),
            "config": {
                "enabled": grok_enabled,
                "binaryPath": str(env_or_cfg("T3_GROK_BINARY_PATH", grok_cfg, "binary_path", "grok")),
                "customModels": env_or_cfg_list("T3_GROK_CUSTOM_MODELS", grok_cfg, "custom_models"),
            },
        },
        "opencode": {
            "driver": "opencode",
            "displayName": str(env_or_cfg("T3_OPENCODE_DISPLAY_NAME", opencode_cfg, "display_name", "OpenCode")),
            "enabled": opencode_enabled,
            "environment": normalize_env_entries(
                "opencode",
                opencode_env,
                "opencode",
                secrets_dir,
            ),
            "config": {
                "enabled": opencode_enabled,
                "binaryPath": str(env_or_cfg("T3_OPENCODE_BINARY_PATH", opencode_cfg, "binary_path", "opencode")),
                "serverUrl": str(opencode_server_url),
                "serverPassword": str(env_or_cfg("T3_OPENCODE_SERVER_PASSWORD", opencode_cfg, "server_password", "")),
                "customModels": env_or_cfg_list("T3_OPENCODE_CUSTOM_MODELS", opencode_cfg, "custom_models"),
            },
        },
    }

    first_enabled = next(
        (
            instance_id
            for instance_id in ("codex", "claudeAgent", "cursor", "grok", "opencode")
            if provider_instances[instance_id]["enabled"]
        ),
        "codex",
    )

    settings = {
        "enableProviderUpdateChecks": env_or_cfg_bool(
            "T3_ENABLE_PROVIDER_UPDATE_CHECKS",
            updates,
            "provider_update_checks",
            False,
        ),
        "defaultThreadEnvMode": str(
            env_or_cfg("T3_DEFAULT_THREAD_ENV_MODE", server, "default_thread_env_mode", "local")
        ),
        "newWorktreesStartFromOrigin": env_or_cfg_bool(
            "T3_NEW_WORKTREES_START_FROM_ORIGIN",
            server,
            "new_worktrees_start_from_origin",
            False,
        ),
        "textGenerationModelSelection": {
            "instanceId": first_enabled,
            "model": provider_default_models.get(first_enabled, "gpt-5.4-mini"),
        },
        "providers": {
            "codex": provider_instances["codex"]["config"],
            "claudeAgent": provider_instances["claudeAgent"]["config"],
            "opencode": provider_instances["opencode"]["config"],
            "cursor": provider_instances["cursor"]["config"],
            "grok": provider_instances["grok"]["config"],
        },
        "providerInstances": provider_instances,
    }

    settings_path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(settings_path, stat.S_IRUSR | stat.S_IWUSR)

    auto_update = env_or_cfg_bool("T3_AUTO_UPDATE", updates, "on_start", True)
    install_disabled = env_or_cfg_bool(
        "T3_INSTALL_DISABLED_PROVIDERS",
        updates,
        "install_disabled_providers",
        False,
    )
    runtime_values = {
        "T3CODE_HOME": t3_home,
        "T3_SERVER_HOST": server_host,
        "T3_SERVER_PORT": str(server_port),
        "T3_WORKDIR": workdir,
        "T3_AUTO_BOOTSTRAP_PROJECT_FROM_CWD": "1" if auto_bootstrap else "0",
        "T3_AUTH_PROXY": "1" if auth_proxy else "0",
        "T3_AUTH_PROXY_INTERNAL_HOST": auth_proxy_internal_host,
        "T3_AUTH_PROXY_INTERNAL_PORT": str(auth_proxy_internal_port),
        "T3_AUTH_PROXY_ADMIN_TTL": auth_proxy_admin_ttl,
        "T3_AUTO_UPDATE_EFFECTIVE": "1" if auto_update else "0",
        "T3_UPDATE_T3": "1" if env_or_cfg_bool("T3_UPDATE_T3", updates, "t3", True) else "0",
        "T3_UPDATE_CODEX": "1" if provider_update_enabled(updates, "codex", codex_enabled, install_disabled) else "0",
        "T3_UPDATE_CLAUDE": "1" if provider_update_enabled(updates, "claude", claude_enabled, install_disabled) else "0",
        "T3_UPDATE_CURSOR": "1" if provider_update_enabled(updates, "cursor", cursor_enabled, install_disabled) else "0",
        "T3_UPDATE_GROK": "1" if provider_update_enabled(updates, "grok", grok_enabled, install_disabled) else "0",
        "T3_UPDATE_OPENCODE": "1" if provider_update_enabled(updates, "opencode", opencode_enabled, install_disabled) else "0",
        "T3_OPENCODE_MANAGED_SERVER": "1" if opencode_managed_server else "0",
        "T3_OPENCODE_MANAGED_HOST": opencode_managed_host,
        "T3_OPENCODE_MANAGED_PORT": str(opencode_managed_port),
        "T3_OPENCODE_CONFIG": opencode_config_effective,
    }
    runtime_env_path.parent.mkdir(parents=True, exist_ok=True)
    write_runtime_env(runtime_env_path, runtime_values)


if __name__ == "__main__":
    main()
