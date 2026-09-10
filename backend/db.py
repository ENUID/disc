"""Per-shop persistence for the multi-tenant Shopify app.

SQLite, not a hosted database — this is deliberate. A shop record is just
{domain, access token, scope, sync status}; there's no concurrent-write
load here that would justify standing up Postgres, and it keeps the
"everything free, near-zero cost" constraint intact. Swap this module out
first if Disc ever needs to run across more than one backend process.
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
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

# Added after the first shops were already installed, so they arrive as
# ALTER TABLEs rather than columns in _SCHEMA — an existing shops.db has
# to survive a deploy without being rebuilt. Adding a column here is
# safe; renaming or dropping one is not.
_MIGRATIONS = [
    "ALTER TABLE shops ADD COLUMN plan TEXT",
    "ALTER TABLE shops ADD COLUMN subscription_id TEXT",
    "ALTER TABLE shops ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none'",
    # Self-serve install: the merchant pastes a script tag carrying this
    # key, so it — not an OAuth token — is what identifies the tenant at
    # search time.
    "ALTER TABLE shops ADD COLUMN site_key TEXT",
    "ALTER TABLE shops ADD COLUMN source TEXT NOT NULL DEFAULT 'public'",
    "ALTER TABLE shops ADD COLUMN email TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_site_key ON shops(site_key)",
]


@contextmanager
def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(_SCHEMA)
    for statement in _MIGRATIONS:
        try:
            conn.execute(statement)
        except sqlite3.OperationalError:
            pass  # already applied
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


def create_site(shop: str, site_key: str, email: str | None = None) -> None:
    """Register a self-serve tenant — no OAuth token, no Shopify app.

    `access_token` is empty for these: the catalog comes from the store's
    public JSON, so there is no credential to hold. Re-running signup for
    a domain keeps its existing key, so a merchant who signs up twice
    doesn't invalidate the snippet already pasted in their theme.
    """
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO shops (shop, access_token, scope, installed_at, sync_status,
                               site_key, source, email)
            VALUES (?, '', '', ?, 'pending', ?, 'public', ?)
            ON CONFLICT(shop) DO UPDATE SET
                email = COALESCE(excluded.email, shops.email)
            """,
            (shop, datetime.now(timezone.utc).isoformat(), site_key, email),
        )


def get_shop(shop: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM shops WHERE shop = ?", (shop,)).fetchone()


def get_shop_by_site_key(site_key: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM shops WHERE site_key = ?", (site_key,)).fetchone()


def shops_due_for_resync(older_than_iso: str) -> list[sqlite3.Row]:
    """Self-serve shops whose catalog hasn't been refreshed recently.

    Without an app there are no product webhooks, so staying in sync means
    re-reading the public catalog on a schedule. `last_synced_at IS NULL`
    is included so a shop whose first ingestion crashed gets retried
    rather than sitting stale forever.
    """
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT * FROM shops
            WHERE source = 'public'
              AND (last_synced_at IS NULL OR last_synced_at < ?)
            """,
            (older_than_iso,),
        ).fetchall()


def set_sync_status(shop: str, status: str, product_count: int | None = None, synced_at: str | None = None) -> None:
    with get_conn() as conn:
        if product_count is not None and synced_at is not None:
            conn.execute(
                "UPDATE shops SET sync_status = ?, product_count = ?, last_synced_at = ? WHERE shop = ?",
                (status, product_count, synced_at, shop),
            )
        else:
            conn.execute("UPDATE shops SET sync_status = ? WHERE shop = ?", (status, shop))


def set_subscription(
    shop: str, status: str, plan: str | None = None, subscription_id: str | None = None
) -> None:
    """Cache what Shopify says about this shop's subscription.

    Cached rather than queried per search on purpose: a `/search` that had
    to call Shopify's Admin API first would add a network round trip to
    the one path that currently has none. Shopify stays the source of
    truth — this is refreshed from it at install, at the billing
    callback, and on every `app_subscriptions/update` webhook.
    """
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE shops SET
                subscription_status = ?,
                plan = COALESCE(?, plan),
                subscription_id = COALESCE(?, subscription_id)
            WHERE shop = ?
            """,
            (status, plan, subscription_id, shop),
        )


def delete_shop(shop: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM shops WHERE shop = ?", (shop,))
