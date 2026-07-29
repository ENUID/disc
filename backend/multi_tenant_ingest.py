"""Per-shop catalog ingestion via the Shopify Admin API.

Each installed shop gets its own LanceDB table (one merchant's products
must never leak into another's search results). Full ingestion runs once
on install; after that, product webhooks keep individual rows in sync
without re-embedding the whole catalog.
"""

import re
from pathlib import Path

import lancedb
import pyarrow as pa
import requests
from fastembed import TextEmbedding

ADMIN_API_VERSION = "2024-01"
LANCE_DB_PATH = Path(__file__).parent / "data" / "disc_lancedb_multi"

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RUN_RE = re.compile(r"\s+")


def table_name_for_shop(shop: str) -> str:
    """myshop.myshopify.com -> shop_myshop_myshopify_com (LanceDB table
    names are restricted to a safe identifier charset)."""
    return "shop_" + re.sub(r"[^a-z0-9]+", "_", shop.lower()).strip("_")


def _strip_html(html: str | None) -> str:
    # Replacing each tag with a space (rather than deleting it outright)
    # avoids accidentally gluing adjacent words together across a tag
    # boundary — at the cost of leaving whitespace runs behind, which the
    # second pass collapses.
    no_tags = _HTML_TAG_RE.sub(" ", html or "")
    return _WHITESPACE_RUN_RE.sub(" ", no_tags).strip()


def product_to_record(product: dict) -> dict | None:
    """Admin API product JSON -> our flat record shape. Returns None for
    products with no purchasable variant (nothing to show a price for)."""
    variants = product.get("variants") or []
    if not variants:
        return None
    images = product.get("images") or []
    tags = [t.strip() for t in (product.get("tags") or "").split(",") if t.strip()]
    return {
        "id": str(product["id"]),
        "title": product.get("title", ""),
        "description": _strip_html(product.get("body_html")),
        "price": float(variants[0].get("price", 0) or 0),
        "image_url": images[0]["src"] if images else "",
        "tags": tags,
    }


def _embedding_text(record: dict) -> str:
    return f"{record['title']}. {record['description']} Tags: {', '.join(record['tags'])}"


def fetch_all_products(shop: str, access_token: str) -> list[dict]:
    """Paginate the Admin API's /products.json via its Link-header cursor."""
    products: list[dict] = []
    url = f"https://{shop}/admin/api/{ADMIN_API_VERSION}/products.json?limit=250"
    headers = {"X-Shopify-Access-Token": access_token}

    while url:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        products.extend(response.json().get("products", []))
        url = _next_page_url(response.headers.get("Link", ""))

    return products


def _next_page_url(link_header: str) -> str | None:
    for part in link_header.split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def ingest_shop(shop: str, access_token: str, embedder: TextEmbedding) -> int:
    """Full re-ingestion: fetch every product, embed, overwrite the shop's
    table. Returns the number of products indexed."""
    raw_products = fetch_all_products(shop, access_token)
    records = [r for r in (product_to_record(p) for p in raw_products) if r is not None]

    LANCE_DB_PATH.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(LANCE_DB_PATH))
    table_name = table_name_for_shop(shop)

    if not records:
        db.create_table(table_name, schema=_EMPTY_SCHEMA, mode="overwrite")
        return 0

    vectors = list(embedder.embed([_embedding_text(r) for r in records]))
    for record, vector in zip(records, vectors):
        record["vector"] = vector.tolist()

    db.create_table(table_name, data=records, mode="overwrite")
    return len(records)


def upsert_product(shop: str, product: dict, embedder: TextEmbedding) -> None:
    """Incremental sync for a single products/create|update webhook —
    re-embeds just that one product instead of the whole catalog."""
    record = product_to_record(product)
    if record is None:
        return
    record["vector"] = next(iter(embedder.embed([_embedding_text(record)]))).tolist()

    db = lancedb.connect(str(LANCE_DB_PATH))
    table_name = table_name_for_shop(shop)
    if table_name not in db.list_tables().tables:
        db.create_table(table_name, data=[record])
        return
    table = db.open_table(table_name)
    table.delete(f"id = '{record['id']}'")
    table.add([record])


def delete_product(shop: str, product_id: int | str) -> None:
    db = lancedb.connect(str(LANCE_DB_PATH))
    table_name = table_name_for_shop(shop)
    if table_name not in db.list_tables().tables:
        return
    db.open_table(table_name).delete(f"id = '{product_id}'")


def delete_shop_table(shop: str) -> None:
    db = lancedb.connect(str(LANCE_DB_PATH))
    table_name = table_name_for_shop(shop)
    if table_name in db.list_tables().tables:
        db.drop_table(table_name)


# Used only to create an empty, correctly-typed table for a shop with zero
# ingestible products, so later upsert_product() calls have a table to add to.
_EMPTY_SCHEMA = pa.schema(
    [
        pa.field("id", pa.string()),
        pa.field("title", pa.string()),
        pa.field("description", pa.string()),
        pa.field("price", pa.float64()),
        pa.field("image_url", pa.string()),
        pa.field("tags", pa.list_(pa.string())),
        pa.field("vector", pa.list_(pa.float32(), 384)),
    ]
)
