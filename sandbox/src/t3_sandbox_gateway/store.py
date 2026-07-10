from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock


class WorkspaceBusyError(RuntimeError):
    pass


class SandboxCapacityError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Lease:
    id: str
    upstream_id: str | None
    workspace: str
    host_path: str
    profile: str
    image: str
    state: str
    created_at: datetime
    expires_at: datetime
    error: str | None


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value)


class LeaseStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = RLock()
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS sandboxes (
                    id TEXT PRIMARY KEY,
                    upstream_id TEXT,
                    workspace TEXT NOT NULL,
                    host_path TEXT NOT NULL,
                    profile TEXT NOT NULL,
                    image TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    error TEXT
                )
                """
            )
            self._connection.execute("DROP INDEX IF EXISTS one_writer_per_workspace")
            self._connection.execute(
                """
                UPDATE sandboxes AS older
                SET state = 'failed', error = 'superseded during lease migration'
                WHERE state IN ('creating', 'active', 'unavailable')
                  AND EXISTS (
                    SELECT 1 FROM sandboxes AS newer
                    WHERE newer.workspace = older.workspace
                      AND newer.state IN ('creating', 'active', 'unavailable')
                      AND (
                        newer.created_at > older.created_at
                        OR (newer.created_at = older.created_at AND newer.id > older.id)
                      )
                  )
                """
            )
            self._connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS one_writer_per_workspace
                ON sandboxes(workspace)
                WHERE state IN ('creating', 'active', 'unavailable')
                """
            )

    @staticmethod
    def _lease(row: sqlite3.Row | None) -> Lease | None:
        if row is None:
            return None
        return Lease(
            id=row["id"],
            upstream_id=row["upstream_id"],
            workspace=row["workspace"],
            host_path=row["host_path"],
            profile=row["profile"],
            image=row["image"],
            state=row["state"],
            created_at=_parse_datetime(row["created_at"]),
            expires_at=_parse_datetime(row["expires_at"]),
            error=row["error"],
        )

    def active_for_host_path(self, host_path: str) -> Lease | None:
        requested = Path(host_path)
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM sandboxes
                WHERE state IN ('creating', 'active', 'unavailable')
                ORDER BY created_at DESC
                """
            ).fetchall()
        for row in rows:
            lease = self._lease(row)
            if lease is None:
                continue
            existing = Path(lease.host_path)
            if (
                requested == existing
                or requested.is_relative_to(existing)
                or existing.is_relative_to(requested)
            ):
                return lease
        return None

    def expire_due(self, now: datetime, creating_timeout_seconds: int) -> None:
        creating_cutoff = datetime.fromtimestamp(
            now.timestamp() - creating_timeout_seconds, tz=UTC
        )
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE sandboxes SET state = 'expired', error = NULL
                WHERE state IN ('active', 'unavailable') AND expires_at <= ?
                """,
                (now.astimezone(UTC).isoformat(),),
            )
            self._connection.execute(
                """
                UPDATE sandboxes SET state = 'failed', error = 'creation timed out'
                WHERE state = 'creating' AND created_at <= ?
                """,
                (creating_cutoff.isoformat(),),
            )

    def create(self, lease: Lease, max_active: int | None = None) -> None:
        try:
            with self._lock, self._connection:
                if max_active is not None:
                    row = self._connection.execute(
                        """
                        SELECT COUNT(*) AS count FROM sandboxes
                        WHERE state IN ('creating', 'active', 'unavailable')
                        """
                    ).fetchone()
                    if int(row["count"]) >= max_active:
                        raise SandboxCapacityError("sandbox concurrency limit reached")
                self._connection.execute(
                    """
                    INSERT INTO sandboxes (
                        id, upstream_id, workspace, host_path, profile, image,
                        state, created_at, expires_at, error
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        lease.id,
                        lease.upstream_id,
                        lease.workspace,
                        lease.host_path,
                        lease.profile,
                        lease.image,
                        lease.state,
                        lease.created_at.isoformat(),
                        lease.expires_at.isoformat(),
                        lease.error,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise WorkspaceBusyError(
                f"workspace already has an active sandbox: {lease.workspace}"
            ) from exc

    def get(self, lease_id: str) -> Lease | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM sandboxes WHERE id = ?", (lease_id,)
            ).fetchone()
        return self._lease(row)

    def list(self, limit: int = 100) -> list[Lease]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM sandboxes ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [lease for row in rows if (lease := self._lease(row)) is not None]

    def activate(
        self,
        lease_id: str,
        upstream_id: str,
        image: str,
        expires_at: datetime,
    ) -> Lease:
        self._update(
            lease_id,
            """
            upstream_id = ?, image = ?, state = 'active',
            expires_at = ?, error = NULL
            """,
            (upstream_id, image, expires_at.astimezone(UTC).isoformat()),
        )
        return self._required(lease_id)

    def set_state(self, lease_id: str, state: str, error: str | None = None) -> Lease:
        self._update(lease_id, "state = ?, error = ?", (state, error))
        return self._required(lease_id)

    def renew(self, lease_id: str, expires_at: datetime) -> Lease:
        self._update(
            lease_id,
            "expires_at = ?, error = NULL",
            (expires_at.astimezone(UTC).isoformat(),),
        )
        return self._required(lease_id)

    def _required(self, lease_id: str) -> Lease:
        lease = self.get(lease_id)
        if lease is None:
            raise KeyError(lease_id)
        return lease

    def _update(self, lease_id: str, expression: str, values: tuple[object, ...]) -> None:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                f"UPDATE sandboxes SET {expression} WHERE id = ?",  # noqa: S608
                (*values, lease_id),
            )
        if cursor.rowcount != 1:
            raise KeyError(lease_id)
