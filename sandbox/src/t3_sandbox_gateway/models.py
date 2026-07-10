from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SandboxProfile = Literal["auto", "base", "devcontainer"]


class CreateSandboxRequest(BaseModel):
    workspace: str = Field(min_length=1, max_length=4096)
    profile: SandboxProfile = "auto"
    ttl_seconds: int | None = Field(default=None, ge=60)
    reuse: bool = True


class ExecuteRequest(BaseModel):
    command: str = Field(min_length=1, max_length=65536)
    working_directory: str = "/workspace"
    timeout_seconds: int | None = Field(default=None, ge=1)


class RenewRequest(BaseModel):
    ttl_seconds: int = Field(ge=60)


class SandboxView(BaseModel):
    id: str
    workspace: str
    profile: str
    image: str
    state: str
    created_at: datetime
    expires_at: datetime


class ExecutionView(BaseModel):
    sandbox_id: str
    exit_code: int | None
    stdout: str
    stderr: str

