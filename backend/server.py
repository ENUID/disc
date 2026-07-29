"""Disc search API.

FastAPI service exposing POST /search for the Disc storefront widget, plus
the Shopify OAuth + webhook plumbing that makes Disc a real multi-tenant
app: each installed store gets its own isolated product index, built from
its actual catalog via the Admin API and kept in sync by product webhooks
— not the 15-item demo catalog every earlier version of this file served.

Pipeline per shop: OAuth install -> Admin API catalog fetch -> fastembed
embeddings -> per-shop LanceDB table -> /search scoped to that table ->
Ollama for the one-line match reasoning. Everything here runs on CPU with
open-source components; there is no OpenAI or other paid API in the loop.
"""

import json
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import lancedb
import requests
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastembed import TextEmbedding
from pydantic import BaseModel

import db
import multi_tenant_ingest
import shopify_auth
from models import SearchResult

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("disc.server")

DB_PATH = Path(__file__).parent / "data" / "disc_lancedb"
TABLE_NAME = "products"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi3"
OLLAMA_TIMEOUT_SECONDS = 4

ml_state: dict = {}

# OAuth CSRF protection: a short-lived map of state token -> shop, issued in
# /auth and consumed in /auth/callback. In-memory is fine for a single
# backend process; a multi-process deployment would need this in the
# shared shops.db (or Redis) instead.
_oauth_states: dict[str, str] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading fastembed model '%s'...", EMBED_MODEL)
    ml_state["embedder"] = TextEmbedding(model_name=EMBED_MODEL)
    logger.info("Connecting to LanceDB at %s...", DB_PATH)
    lance_db = lancedb.connect(str(DB_PATH))
    ml_state["table"] = lance_db.open_table(TABLE_NAME)
    logger.info("Disc search backend ready.")
    yield
    ml_state.clear()


app = FastAPI(title="Disc Search API", lifespan=lifespan)

# The widget runs embedded on arbitrary Shopify storefront domains, so the
# API must accept cross-origin requests from anywhere it's installed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SearchRequest(BaseModel):
    query: str
    limit: int = 3
    shop: str | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    # "ready": results (possibly empty) are final.
    # "syncing": the shop is a real install whose catalog hasn't finished
    # indexing yet — the widget should say so rather than imply "no matches".
    status: str = "ready"


def generate_ai_reasoning(query: str, item: dict) -> str:
    """Ask a local Ollama model for a one-sentence explanation of the match.

    Falls back to a deterministic templated sentence if Ollama isn't
    running, isn't reachable, or doesn't respond within the timeout — the
    caller always gets a usable string back, never an exception.
    """
    prompt = (
        "You are a fashion search assistant. In exactly one short sentence, "
        "explain why this product matches the shopper's search. Be specific "
        "and concrete, do not repeat the product title verbatim.\n\n"
        f"Shopper search: \"{query}\"\n"
        f"Product: {item['title']}\n"
        f"Description: {item['description']}\n"
        f"Tags: {', '.join(item['tags'])}\n\n"
        "One-sentence explanation:"
    )

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.4, "num_predict": 60},
            },
            timeout=OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        text = response.json().get("response", "").strip()
        if text:
            return text.split("\n")[0].strip()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Ollama unavailable (%s), using fallback reasoning.", exc)

    return _fallback_reasoning(query, item)


def _fallback_reasoning(query: str, item: dict) -> str:
    top_tags = ", ".join(item["tags"][:3]) if item["tags"] else "its design"
    return f'Matches "{query}" thanks to its {top_tags} qualities.'


def _resolve_table(shop: str | None):
    """Picks which LanceDB table a search should run against.

    Returns (table, status). `table` is None only when `status` is
    "syncing" (a real registered shop whose ingestion hasn't finished) —
    every other path returns a usable table, falling back to the shared
    demo catalog for unregistered/absent shop values so local dev and
    test.html keep working unchanged.
    """
    if not shop:
        return ml_state["table"], "ready"

    shop_record = db.get_shop(shop)
    if shop_record is None:
        return ml_state["table"], "ready"

    if shop_record["sync_status"] != "ready":
        return None, "syncing"

    table_name = multi_tenant_ingest.table_name_for_shop(shop)
    mt_db = lancedb.connect(str(multi_tenant_ingest.LANCE_DB_PATH))
    if table_name not in mt_db.list_tables().tables:
        return None, "syncing"
    return mt_db.open_table(table_name), "ready"


@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    embedder: TextEmbedding = ml_state["embedder"]
    table, status = _resolve_table(request.shop)

    if table is None:
        return SearchResponse(query=request.query, results=[], status=status)

    query_vector = next(iter(embedder.embed([request.query]))).tolist()

    hits = table.search(query_vector).limit(request.limit).to_list()

    results = []
    for hit in hits:
        # LanceDB returns L2 distance; convert to a bounded 0-1 similarity
        # score that's friendlier for the widget to render (e.g. as a bar).
        score = 1.0 / (1.0 + hit["_distance"])
        reasoning = generate_ai_reasoning(request.query, hit)
        results.append(
            SearchResult(
                id=hit["id"],
                title=hit["title"],
                description=hit["description"],
                price=hit["price"],
                image_url=hit["image_url"],
                tags=hit["tags"],
                score=round(score, 4),
                reasoning=reasoning,
            )
        )

    return SearchResponse(query=request.query, results=results, status="ready")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "disc-search"}


# ---------------------------------------------------------------------
# Shopify OAuth install flow.
# https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
# ---------------------------------------------------------------------


@app.get("/auth")
def auth_start(shop: str = Query(...)) -> RedirectResponse:
    if not shop.endswith(".myshopify.com"):
        raise HTTPException(400, "shop must be a *.myshopify.com domain")
    state = uuid.uuid4().hex
    _oauth_states[state] = shop
    return RedirectResponse(shopify_auth.build_authorize_url(shop, state))


@app.get("/auth/callback")
def auth_callback(request: Request, background_tasks: BackgroundTasks) -> dict:
    params = dict(request.query_params)
    shop = params.get("shop", "")
    state = params.get("state", "")
    code = params.get("code", "")

    if not shop or _oauth_states.get(state) != shop:
        raise HTTPException(403, "Invalid or expired OAuth state")
    del _oauth_states[state]

    if not shopify_auth.verify_oauth_callback_hmac(params):
        raise HTTPException(403, "Invalid HMAC on OAuth callback")

    token_data = shopify_auth.exchange_code_for_token(shop, code)
    access_token = token_data["access_token"]
    scope = token_data.get("scope", "")

    db.upsert_shop(shop, access_token, scope, datetime.now(timezone.utc).isoformat())
    shopify_auth.register_webhooks(shop, access_token)
    background_tasks.add_task(_run_full_ingestion, shop, access_token)

    return {
        "status": "installed",
        "shop": shop,
        "message": "Disc is now syncing your catalog. This usually takes a minute or two.",
    }


def _run_full_ingestion(shop: str, access_token: str) -> None:
    db.set_sync_status(shop, "syncing")
    try:
        count = multi_tenant_ingest.ingest_shop(shop, access_token, ml_state["embedder"])
        db.set_sync_status(
            shop, "ready", product_count=count, synced_at=datetime.now(timezone.utc).isoformat()
        )
        logger.info("Ingested %d products for %s", count, shop)
    except Exception:
        logger.exception("Ingestion failed for shop %s", shop)
        db.set_sync_status(shop, "error")


@app.get("/shops/{shop}/status")
def shop_status(shop: str) -> dict:
    """Lets the widget (or a merchant-facing status page) poll ingestion
    progress right after install, instead of guessing when to retry."""
    record = db.get_shop(shop)
    if record is None:
        raise HTTPException(404, "Shop not installed")
    return {
        "shop": shop,
        "sync_status": record["sync_status"],
        "product_count": record["product_count"],
        "last_synced_at": record["last_synced_at"],
    }


# ---------------------------------------------------------------------
# Webhooks. Every handler verifies the X-Shopify-Hmac-Sha256 header
# against the *raw* request body before touching the payload — this is
# a different HMAC scheme than the OAuth callback's, and it's the only
# thing standing between this endpoint and a forged request.
# ---------------------------------------------------------------------


async def _verify_and_parse_webhook(request: Request, x_shopify_hmac_sha256: str | None) -> dict:
    raw_body = await request.body()
    if not shopify_auth.verify_webhook_hmac(raw_body, x_shopify_hmac_sha256 or ""):
        raise HTTPException(401, "Invalid webhook HMAC")
    return json.loads(raw_body)


def _upsert_product_task(shop: str, product: dict) -> None:
    try:
        multi_tenant_ingest.upsert_product(shop, product, ml_state["embedder"])
    except Exception:
        logger.exception("Failed to upsert product for shop %s", shop)


@app.post("/webhooks/products/create")
async def webhook_product_create(
    request: Request,
    background_tasks: BackgroundTasks,
    x_shopify_shop_domain: str | None = Header(None),
    x_shopify_hmac_sha256: str | None = Header(None),
) -> dict:
    payload = await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    background_tasks.add_task(_upsert_product_task, x_shopify_shop_domain, payload)
    return {"status": "queued"}


@app.post("/webhooks/products/update")
async def webhook_product_update(
    request: Request,
    background_tasks: BackgroundTasks,
    x_shopify_shop_domain: str | None = Header(None),
    x_shopify_hmac_sha256: str | None = Header(None),
) -> dict:
    payload = await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    background_tasks.add_task(_upsert_product_task, x_shopify_shop_domain, payload)
    return {"status": "queued"}


@app.post("/webhooks/products/delete")
async def webhook_product_delete(
    request: Request,
    x_shopify_shop_domain: str | None = Header(None),
    x_shopify_hmac_sha256: str | None = Header(None),
) -> dict:
    payload = await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    multi_tenant_ingest.delete_product(x_shopify_shop_domain, payload["id"])
    return {"status": "deleted"}


@app.post("/webhooks/app/uninstalled")
async def webhook_app_uninstalled(
    request: Request,
    x_shopify_shop_domain: str | None = Header(None),
    x_shopify_hmac_sha256: str | None = Header(None),
) -> dict:
    await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    multi_tenant_ingest.delete_shop_table(x_shopify_shop_domain)
    db.delete_shop(x_shopify_shop_domain)
    return {"status": "cleaned up"}


# Mandatory GDPR webhooks. Shopify requires every app to register these
# three topics before it can go public, regardless of what data the app
# actually stores. Disc keeps no customer PII at all — only product
# catalog data — so these are acknowledgements, not real data operations,
# except shop/redact, which does need to delete that shop's index.
@app.post("/webhooks/customers/data_request")
async def webhook_customers_data_request(
    request: Request, x_shopify_hmac_sha256: str | None = Header(None)
) -> dict:
    await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    return {"status": "acknowledged"}


@app.post("/webhooks/customers/redact")
async def webhook_customers_redact(
    request: Request, x_shopify_hmac_sha256: str | None = Header(None)
) -> dict:
    await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    return {"status": "acknowledged"}


@app.post("/webhooks/shop/redact")
async def webhook_shop_redact(request: Request, x_shopify_hmac_sha256: str | None = Header(None)) -> dict:
    payload = await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    shop = payload.get("shop_domain", "")
    multi_tenant_ingest.delete_shop_table(shop)
    db.delete_shop(shop)
    return {"status": "shop data deleted"}
