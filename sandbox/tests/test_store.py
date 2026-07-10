from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from t3_sandbox_gateway.store import (
    Lease,
    LeaseStore,
    SandboxCapacityError,
    WorkspaceBusyError,
)


def lease(identifier: str, workspace: str, now: datetime) -> Lease:
    return Lease(
        id=identifier,
        upstream_id=None,
        workspace=workspace,
        host_path=f"/host/{workspace}",
        profile="base",
        image="agent-base:test",
        state="creating",
        created_at=now,
        expires_at=now + timedelta(minutes=10),
        error=None,
    )


def test_capacity_check_and_reservation_are_one_store_operation(tmp_path: Path) -> None:
    store = LeaseStore(tmp_path / "state.db")
    now = datetime.now(UTC)
    store.create(lease("one", "one", now), max_active=1)

    with pytest.raises(SandboxCapacityError):
        store.create(lease("two", "two", now), max_active=1)


def test_unavailable_lease_keeps_workspace_reservation(tmp_path: Path) -> None:
    store = LeaseStore(tmp_path / "state.db")
    now = datetime.now(UTC)
    store.create(lease("one", "same", now))
    store.set_state("one", "unavailable")

    with pytest.raises(WorkspaceBusyError, match="workspace already has an active sandbox"):
        store.create(lease("two", "same", now))


def test_expire_due_releases_active_and_stale_creating_leases(tmp_path: Path) -> None:
    store = LeaseStore(tmp_path / "state.db")
    now = datetime.now(UTC)
    store.create(lease("active", "active", now - timedelta(hours=2)))
    store.activate(
        "active",
        "upstream-active",
        "agent-base:test",
        now - timedelta(seconds=1),
    )
    store.create(lease("creating", "creating", now - timedelta(hours=2)))

    store.expire_due(now, creating_timeout_seconds=60)

    assert store.get("active").state == "expired"
    assert store.get("creating").state == "failed"
    store.create(lease("replacement", "replacement", now), max_active=1)


def test_finds_active_overlapping_host_path(tmp_path: Path) -> None:
    store = LeaseStore(tmp_path / "state.db")
    created = lease("one", "repo", datetime.now(UTC))
    store.create(created)

    assert store.active_for_host_path("/host/repo/packages/app") == created
