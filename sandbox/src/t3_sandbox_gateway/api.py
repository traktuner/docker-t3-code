from __future__ import annotations

import hmac

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status

from .backend import OpenSandboxBackend
from .config import Settings
from .devcontainer import DevContainerBuilder, DevContainerError
from .models import (
    CreateSandboxRequest,
    ExecuteRequest,
    ExecutionView,
    RenewRequest,
    SandboxView,
)
from .paths import WorkspaceMapper, WorkspacePathError
from .service import (
    LifecycleError,
    SandboxLimitError,
    SandboxNotFoundError,
    SandboxService,
    SandboxStateError,
)
from .store import Lease, LeaseStore, WorkspaceBusyError


def _view(lease: Lease) -> SandboxView:
    return SandboxView(
        id=lease.id,
        workspace=lease.workspace,
        profile=lease.profile,
        image=lease.image,
        state=lease.state,
        created_at=lease.created_at,
        expires_at=lease.expires_at,
    )


def build_service(settings: Settings) -> SandboxService:
    return SandboxService(
        settings=settings,
        store=LeaseStore(settings.state_db),
        mapper=WorkspaceMapper(
            settings.client_workspace_root, settings.host_workspace_root
        ),
        backend=OpenSandboxBackend(settings),
        devcontainers=DevContainerBuilder(settings),
    )


def create_app(
    settings: Settings | None = None,
    service: SandboxService | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    service = service or build_service(settings)
    app = FastAPI(
        title="T3 Sandbox Gateway",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def authorize(authorization: str | None = Header(default=None)) -> None:
        prefix = "Bearer "
        if authorization is None or not authorization.startswith(prefix):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        if not hmac.compare_digest(
            authorization[len(prefix) :], settings.gateway_token
        ):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/v1/sandboxes",
        response_model=SandboxView,
        dependencies=[Depends(authorize)],
    )
    async def create_sandbox(request: CreateSandboxRequest) -> SandboxView:
        try:
            return _view(await service.create(request))
        except (WorkspaceBusyError, SandboxLimitError, SandboxStateError) as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except (
            ValueError,
            WorkspacePathError,
            DevContainerError,
            LifecycleError,
        ) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.get(
        "/v1/sandboxes",
        response_model=list[SandboxView],
        dependencies=[Depends(authorize)],
    )
    async def list_sandboxes() -> list[SandboxView]:
        return [_view(lease) for lease in service.list()]

    @app.get(
        "/v1/sandboxes/{lease_id}",
        response_model=SandboxView,
        dependencies=[Depends(authorize)],
    )
    async def get_sandbox(lease_id: str) -> SandboxView:
        try:
            return _view(await service.status(lease_id))
        except SandboxNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from exc

    @app.post(
        "/v1/sandboxes/{lease_id}/exec",
        response_model=ExecutionView,
        dependencies=[Depends(authorize)],
    )
    async def execute(lease_id: str, request: ExecuteRequest) -> ExecutionView:
        try:
            result = await service.execute(lease_id, request)
        except SandboxNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from exc
        except (SandboxStateError, WorkspacePathError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        return ExecutionView(
            sandbox_id=lease_id,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
        )

    @app.post(
        "/v1/sandboxes/{lease_id}/renew",
        response_model=SandboxView,
        dependencies=[Depends(authorize)],
    )
    async def renew(lease_id: str, request: RenewRequest) -> SandboxView:
        try:
            return _view(await service.renew(lease_id, request.ttl_seconds))
        except SandboxNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from exc
        except (SandboxStateError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    @app.delete(
        "/v1/sandboxes/{lease_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        dependencies=[Depends(authorize)],
    )
    async def destroy(lease_id: str) -> Response:
        try:
            await service.destroy(lease_id)
        except SandboxNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app


app = create_app()
