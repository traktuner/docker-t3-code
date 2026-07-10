from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class WorkspacePathError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class WorkspacePath:
    client_path: str
    host_path: Path


class WorkspaceMapper:
    def __init__(self, client_root: str, host_root: Path):
        self.client_root = PurePosixPath(client_root)
        self.host_root = host_root.resolve(strict=True)
        if not self.client_root.is_absolute():
            raise WorkspacePathError("client workspace root must be absolute")

    def resolve(self, requested: str) -> WorkspacePath:
        raw = PurePosixPath(requested)
        client_path = raw if raw.is_absolute() else self.client_root / raw
        if ".." in client_path.parts:
            raise WorkspacePathError("workspace path cannot contain '..'")

        try:
            relative = client_path.relative_to(self.client_root)
        except ValueError as exc:
            raise WorkspacePathError(
                f"workspace must be below {self.client_root}"
            ) from exc
        if relative == PurePosixPath("."):
            raise WorkspacePathError("workspace root cannot be mounted as one sandbox")

        candidate = (self.host_root / Path(*relative.parts)).resolve(strict=True)
        if not candidate.is_dir():
            raise WorkspacePathError("workspace must be an existing directory")
        if not candidate.is_relative_to(self.host_root):
            raise WorkspacePathError("workspace resolves outside the allowed host root")

        normalized = str(self.client_root / relative)
        return WorkspacePath(client_path=normalized, host_path=candidate)


def sandbox_working_directory(value: str, workspace_root: str = "/workspace") -> str:
    virtual_root = PurePosixPath("/workspace")
    actual_root = PurePosixPath(workspace_root)
    requested = PurePosixPath(value)
    if requested.is_absolute():
        try:
            requested.relative_to(actual_root)
            resolved = requested
        except ValueError:
            try:
                relative = requested.relative_to(virtual_root)
            except ValueError as exc:
                raise WorkspacePathError(
                    f"working directory must be below {actual_root}"
                ) from exc
            resolved = actual_root / relative
    else:
        resolved = actual_root / requested
    if ".." in resolved.parts:
        raise WorkspacePathError("working directory cannot contain '..'")
    try:
        resolved.relative_to(actual_root)
    except ValueError as exc:
        raise WorkspacePathError(
            f"working directory must be below {actual_root}"
        ) from exc
    return str(resolved)
