"""Per-shop persistence for the multi-tenant Shopify app.

SQLite, not a hosted database — this is deliberate. A shop record is just
{domain, access token, scope, sync status}; there's no concurrent-write
load here that would justify standing up Postgres, and it keeps the
"everything free, near-zero cost" constraint intact. Swap this module out
first if Disc ever needs to run across more than one backend process.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "shops.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS shops (
    shop TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    scope TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    last_synced_at TEXT,
    product_count INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending'
);
"""


@contextmanager
def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(_SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def upsert_shop(shop: str, access_token: str, scope: str, installed_at: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO shops (shop, access_token, scope, installed_at, sync_status)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT(shop) DO UPDATE SET
                access_token = excluded.access_token,
                scope = excluded.scope,
                installed_at = excluded.installed_at
            """,
            (shop, access_token, scope, installed_at),
        )


def get_shop(shop: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM shops WHERE shop = ?", (shop,)).fetchone()


def set_sync_status(shop: str, status: str, product_count: int | None = None, synced_at: str | None = None) -> None:
    with get_conn() as conn:
        if product_count is not None and synced_at is not None:
            conn.execute(
                "UPDATE shops SET sync_status = ?, product_count = ?, last_synced_at = ? WHERE shop = ?",
                (status, product_count, synced_at, shop),
            )
        else:
            conn.execute("UPDATE shops SET sync_status = ? WHERE shop = ?", (status, shop))


def delete_shop(shop: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM shops WHERE shop = ?", (shop,))
