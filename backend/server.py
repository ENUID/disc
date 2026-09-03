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

import asyncio
import json
import logging
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import lancedb
import requests
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastembed import TextEmbedding
from pydantic import BaseModel

import billing
import db
import multi_tenant_ingest
import public_ingest
import shopify_auth
from models import SearchResult, Variant

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
    # PUBLIC_URL is baked into every snippet /embed.js hands a merchant,
    # so if it's still pointing at localhost in a real deployment, every
    # merchant gets a script tag their storefront can't load — and it
    # fails silently, on their site, not ours.
    if "localhost" in PUBLIC_URL or "127.0.0.1" in PUBLIC_URL:
        logger.warning(
            "PUBLIC_URL is %s — install snippets will point there. Set PUBLIC_URL to "
            "this backend's real public HTTPS address before onboarding any merchant.",
            PUBLIC_URL,
        )
    logger.info("Disc search backend ready.")
    resync = asyncio.create_task(_resync_loop())
    yield
    resync.cancel()
    ml_state.clear()


async def _resync_loop() -> None:
    """Re-read self-serve catalogs on a schedule.

    A self-serve install has no product webhooks — those need an app — so
    this loop is the only thing keeping a merchant's index in step with
    their catalog. It sleeps first so a restart doesn't stampede every
    shop at once, and it never lets one shop's failure stop the others.
    """
    while True:
        try:
            await asyncio.sleep(RESYNC_INTERVAL_HOURS * 3600)
            cutoff = datetime.now(timezone.utc) - timedelta(hours=RESYNC_INTERVAL_HOURS)
            due = db.shops_due_for_resync(cutoff.isoformat())
            logger.info("Resyncing %d catalogs", len(due))
            for record in due:
                await asyncio.to_thread(_run_public_ingestion, record["shop"])
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Resync sweep failed; will retry next interval")


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
    # Which tenant this search belongs to. `site_key` is the self-serve
    # identifier, issued at signup and carried by the merchant's script
    # tag. `shop` is the older OAuth-install identifier, still accepted so
    # an app-installed store keeps working; `site_key` wins when both are
    # present. Neither means the shared demo catalog.
    site_key: str | None = None
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


def _resolve_tenant(site_key: str | None, shop: str | None):
    """The one place a request turns into a tenant.

    Two identifiers reach this. `site_key` is the self-serve one, issued
    at signup and pasted into the merchant's theme inside the script tag.
    `shop` predates it and comes from an OAuth install. A key wins over a
    domain when both arrive, because a key was actually issued by us
    whereas a domain is just a string the page claimed.
    """
    if site_key:
        return db.get_shop_by_site_key(site_key)
    if shop:
        return db.get_shop(shop)
    return None


def _resolve_table(shop: str | None = None, site_key: str | None = None):
    """Picks which LanceDB table a search should run against.

    Returns (table, status). `table` is None when `status` is "syncing"
    (a registered shop whose ingestion hasn't finished) or "inactive" (a
    registered shop with no live subscription) — every other path returns
    a usable table, falling back to the shared demo catalog when no
    tenant is identified, so local dev and test.html keep working
    unchanged.
    """
    shop_record = _resolve_tenant(site_key, shop)
    if shop_record is None:
        return ml_state["table"], "ready"

    # A lapsed subscription must not leave the storefront worse than it
    # was before Disc: "inactive" tells the widget to stay dormant AND to
    # put the theme's own search input back, rather than hiding it on
    # behalf of a bar that no longer answers.
    if not _is_active(shop_record):
        return None, "inactive"

    if shop_record["sync_status"] != "ready":
        return None, "syncing"

    shop = shop_record["shop"]

    table_name = multi_tenant_ingest.table_name_for_shop(shop)
    mt_db = lancedb.connect(str(multi_tenant_ingest.LANCE_DB_PATH))
    if table_name not in mt_db.list_tables().tables:
        return None, "syncing"
    return mt_db.open_table(table_name), "ready"


@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    embedder: TextEmbedding = ml_state["embedder"]
    table, status = _resolve_table(request.shop, request.site_key)

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
        results.append(_hit_to_result(hit, score=round(score, 4), reasoning=reasoning))

    return SearchResponse(query=request.query, results=results, status="ready")


def _hit_to_result(hit: dict, score: float = 1.0, reasoning: str = "") -> SearchResult:
    """One place that maps a stored row onto the wire format.

    Tables written before the storefront fields existed won't have them,
    so every added field is read defensively — an older shop table should
    degrade to a plain result, not 500 the whole search.
    """
    return SearchResult(
        id=hit["id"],
        title=hit["title"],
        description=hit["description"],
        price=hit["price"],
        image_url=hit["image_url"],
        tags=list(hit.get("tags") or []),
        score=score,
        reasoning=reasoning,
        handle=hit.get("handle") or "",
        product_type=hit.get("product_type") or "",
        images=list(hit.get("images") or []) or [hit["image_url"]],
        variants=[Variant(**v) for v in (hit.get("variants") or [])],
        colour=hit.get("colour") or "",
    )


def _fetch_by_id(table, product_id: str) -> dict | None:
    rows = table.search().where(f"id = '{product_id}'").limit(1).to_list()
    return rows[0] if rows else None


@app.get("/product/{product_id}", response_model=SearchResult)
def product_detail(
    product_id: str,
    shop: str | None = Query(None),
    site_key: str | None = Query(None),
) -> SearchResult:
    """Everything the detail overlay needs: image set, variants, colour.

    HOW TO STYLE copy is generated here rather than at ingest time — it's
    one short Ollama call, and generating it for every product in a
    catalog upfront would be wasted work for products nobody opens.
    """
    table, status = _resolve_table(shop, site_key)
    if table is None:
        raise HTTPException(409, f"Catalog unavailable ({status})")

    row = _fetch_by_id(table, product_id)
    if row is None:
        raise HTTPException(404, "Product not found")

    return _hit_to_result(row, score=1.0, reasoning=generate_styling_note(row))


def generate_styling_note(item: dict) -> str:
    """The 'HOW TO STYLE' copy. Same Ollama-with-fallback contract as the
    match reasoning: the widget always gets a usable sentence."""
    prompt = (
        "You are a fashion stylist writing for a luxury boutique. In one or two "
        "short sentences, say how to style this piece — what to wear it with and "
        "when. Be specific and understated. Do not use bullet points.\n\n"
        f"Product: {item['title']}\n"
        f"Description: {item['description']}\n"
        f"Tags: {', '.join(item.get('tags') or [])}\n\n"
        "Styling note:"
    )
    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.6, "num_predict": 90},
            },
            timeout=OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        text = response.json().get("response", "").strip()
        if text:
            return " ".join(text.split("\n")).strip()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Ollama unavailable (%s), using fallback styling note.", exc)

    tags = item.get("tags") or []
    lead = ", ".join(tags[:2]) if tags else "considered"
    return (
        f"Its {lead} character makes it easy to build around — pair it with "
        "quiet, well-cut basics and let the piece lead."
    )


@app.get("/look/{product_id}", response_model=SearchResponse)
def complete_the_look(
    product_id: str,
    shop: str | None = Query(None),
    site_key: str | None = Query(None),
    limit: int = 4
) -> SearchResponse:
    """Complementary pieces, not more of the same thing.

    Nearest-neighbour search on its own returns near-duplicates — search
    with a cardigan's vector and you get four more cardigans, which is
    useless as an outfit. So we search wide in the same embedding space
    (which already encodes style, season and material affinity) and then
    filter *out* the item's own product_type, keeping the closest match
    from each remaining category. That yields trousers/shoes/a bag that
    share the piece's character.
    """
    table, status = _resolve_table(shop, site_key)
    if table is None:
        return SearchResponse(query="", results=[], status=status)

    row = _fetch_by_id(table, product_id)
    if row is None:
        raise HTTPException(404, "Product not found")

    own_type = (row.get("product_type") or "").lower()

    # The candidate pool has to be wide enough to reach past the anchor's
    # own category, and how wide that is depends on the shop. A fixed 40
    # was enough for the balanced demo catalog but returns nothing on a
    # real specialist store: on a shoe brand where 200 of 250 products are
    # Shoes, a shoe's 40 nearest neighbours are all shoes, every one of
    # them gets filtered out, and the panel comes back empty. Scanning the
    # whole table is affordable here — it's a local vector search over a
    # single shop's catalog with no network hop.
    pool = min(table.count_rows(), max(200, limit * 50))
    candidates = table.search(row["vector"]).limit(pool).to_list()

    seen_types: set[str] = set()
    results: list[SearchResult] = []
    for hit in candidates:
        if hit["id"] == product_id:
            continue
        hit_type = (hit.get("product_type") or "").lower()
        if own_type and hit_type == own_type:
            continue
        # One piece per category, so a "look" reads as an outfit rather
        # than three variations on the same garment.
        if hit_type and hit_type in seen_types:
            continue
        seen_types.add(hit_type)
        score = 1.0 / (1.0 + hit["_distance"])
        results.append(_hit_to_result(hit, score=round(score, 4)))
        if len(results) >= limit:
            break

    return SearchResponse(query=row["title"], results=results, status="ready")


@app.get("/placeholder/{name}")
def placeholder_image(name: str) -> Response:
    """Generated stand-in imagery for the demo catalog.

    The sample catalog has no real photography, and a grid of broken
    images makes the whole experience look broken. This renders a calm,
    deterministic SVG per product instead. Real shops never hit this —
    their records carry real CDN URLs.
    """
    seed = sum(ord(c) for c in name)
    hue = seed % 40 + 20  # warm stone/sand range, never a jarring colour
    light = f"hsl({hue}, 14%, {88 - seed % 6}%)"
    dark = f"hsl({hue}, 12%, {74 - seed % 8}%)"
    label = name.rsplit("-", 1)[0].replace("-", " ").title()

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="{light}"/>
      <stop offset="100%" stop-color="{dark}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="800" fill="url(#g)"/>
  <ellipse cx="300" cy="330" rx="120" ry="150" fill="rgba(255,255,255,0.22)"/>
  <rect x="228" y="430" width="144" height="250" rx="16" fill="rgba(255,255,255,0.16)"/>
  <text x="300" y="742" text-anchor="middle" font-family="Georgia, serif"
        font-size="26" fill="rgba(0,0,0,0.42)">{label}</text>
</svg>"""
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


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
def auth_callback(request: Request, background_tasks: BackgroundTasks):
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

    # Ingestion runs in the background so this redirect returns straight
    # away; the merchant approves the charge while their catalog embeds.
    if billing.enabled():
        return RedirectResponse(f"/billing/start?shop={shop}")
    return RedirectResponse(f"/app?shop={shop}")


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


# ---------------------------------------------------------------------
# Self-serve signup. This is the install path Disc actually ships on:
# the merchant signs up here, pastes one script tag into their theme,
# and never installs a Shopify app. The OAuth flow above stays for the
# day an App Store listing exists — it reads richer data and gets real
# product webhooks — but nothing below depends on it.
# ---------------------------------------------------------------------

PUBLIC_URL = os.environ.get("PUBLIC_URL", shopify_auth.APP_URL).rstrip("/")

# Resync cadence for self-serve shops. There are no product webhooks
# without an app, so this interval *is* how stale a merchant's catalog
# can get after they edit a product.
RESYNC_INTERVAL_HOURS = int(os.environ.get("DISC_RESYNC_HOURS", "6"))


def _new_site_key() -> str:
    """A public identifier, not a secret.

    It ships in a script tag on a public storefront, so anyone can read
    it — it identifies a tenant, it doesn't authenticate one. It's random
    to stop people guessing *other* merchants' keys, and prefixed so it's
    recognisable in a log or a support email.
    """
    return "disc_" + secrets.token_hex(16)


class SignupRequest(BaseModel):
    domain: str
    email: str | None = None


@app.post("/sites")
def create_site(request: SignupRequest, background_tasks: BackgroundTasks) -> dict:
    """Register a store and issue its site key.

    The storefront is probed before anything is written: a domain that
    doesn't serve a readable catalog can't be made to work later, and
    failing here — on the signup form — beats failing after they've
    pasted the snippet into their theme and are staring at an empty bar.
    """
    domain = public_ingest.normalise_domain(request.domain)
    if not domain or "." not in domain:
        raise HTTPException(400, "Enter your store's domain, e.g. yourstore.com")

    try:
        public_ingest.probe_storefront(domain)
    except public_ingest.StorefrontUnreachable as exc:
        raise HTTPException(400, str(exc)) from exc

    existing = db.get_shop(domain)
    # Re-signing up must not mint a new key: the old one is already
    # pasted into a live theme, and rotating it would silently kill Disc
    # on that storefront.
    site_key = (existing["site_key"] if existing else None) or _new_site_key()
    db.create_site(domain, site_key, request.email)

    background_tasks.add_task(_run_public_ingestion, domain)
    return {
        "domain": domain,
        "site_key": site_key,
        "snippet": _snippet_for(site_key),
        "install_url": f"{PUBLIC_URL}/install?k={site_key}",
    }


def _snippet_for(site_key: str) -> str:
    return f'<script src="{PUBLIC_URL}/embed.js?k={site_key}" defer></script>'


def _run_public_ingestion(domain: str) -> None:
    db.set_sync_status(domain, "syncing")
    try:
        count = public_ingest.ingest_public_shop(domain, ml_state["embedder"])
        db.set_sync_status(
            domain, "ready", product_count=count, synced_at=datetime.now(timezone.utc).isoformat()
        )
        logger.info("Indexed %d products for %s", count, domain)
    except Exception:
        logger.exception("Public ingestion failed for %s", domain)
        db.set_sync_status(domain, "error")


@app.get("/embed.js")
def embed_js(k: str = Query(...)) -> Response:
    """The one URL a merchant ever pastes.

    Serving the widget from here rather than handing over a static file
    means the API URL and site key are baked in at request time, so the
    merchant's snippet carries no configuration they could get wrong, and
    a widget update reaches every store without anyone editing a theme.

    An unknown key still serves the widget rather than 404ing: the script
    tag is in a live storefront's HTML, and a hard failure there is a JS
    error on a merchant's shop. It boots dormant instead, and /search
    tells it so.
    """
    widget_path = Path(__file__).parent.parent / "frontend" / "disc-widget.js"
    prelude = (
        "/* Disc — configured at serve time by /embed.js */\n"
        "window.DiscConfig = Object.assign({}, window.DiscConfig, {\n"
        f"  apiUrl: {json.dumps(PUBLIC_URL)},\n"
        f"  siteKey: {json.dumps(k)}\n"
        "});\n"
    )
    return Response(
        content=prelude + widget_path.read_text(),
        media_type="application/javascript",
        # Long enough that repeat shoppers don't refetch it, short enough
        # that a widget fix reaches storefronts the same day.
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/", response_class=HTMLResponse)
def landing() -> HTMLResponse:
    return HTMLResponse(_SIGNUP_PAGE.replace("{{api}}", PUBLIC_URL))


@app.get("/install", response_class=HTMLResponse)
def install_page(k: str = Query(...)) -> HTMLResponse:
    """Where a merchant gets their snippet and watches indexing finish."""
    record = db.get_shop_by_site_key(k)
    if record is None:
        raise HTTPException(404, "Unknown site key")

    plan_key = record["plan"] or billing.plan_for_catalog(record["product_count"])
    plan = billing.PLANS.get(plan_key, billing.PLANS[billing.DEFAULT_PLAN])
    paying = record["subscription_status"] in billing.ACTIVE_STATUSES or not billing.enabled()

    return HTMLResponse(
        _INSTALL_PAGE.replace("{{domain}}", record["shop"])
        .replace("{{key}}", k)
        .replace("{{snippet}}", _snippet_for(k).replace("<", "&lt;"))
        .replace("{{api}}", PUBLIC_URL)
        .replace("{{plan}}", plan["name"])
        .replace("{{price}}", f"{plan['price']:.0f}")
        .replace(
            "{{billing}}",
            "<p class='note'>Billing isn't configured on this deployment, so Disc runs unmetered.</p>"
            if not billing.enabled()
            else (
                f"<p class='note'>On {plan['name']} — ${plan['price']:.0f}/month.</p>"
                if paying
                else f"<a class='btn' href='/billing/checkout?k={k}'>Start {billing.TRIAL_DAYS}-day free trial</a>"
            ),
        )
    )


def _is_active(record) -> bool:
    """Whether this tenant's Disc should run at all.

    One definition, used by both `_resolve_table` and the status endpoint
    the widget boots against — if these two ever disagreed, a storefront
    could hide its own search box for a bar that then refuses to answer.
    """
    if not billing.enabled():
        return True
    return record["subscription_status"] in billing.ACTIVE_STATUSES


@app.get("/sites/{site_key}/status")
def site_status(site_key: str) -> dict:
    """Two callers: the install page, polling while the first ingestion
    runs, and the widget on every storefront page load, deciding whether
    to mount at all."""
    record = db.get_shop_by_site_key(site_key)
    if record is None:
        raise HTTPException(404, "Unknown site key")
    return {
        "domain": record["shop"],
        "sync_status": record["sync_status"],
        "product_count": record["product_count"],
        "last_synced_at": record["last_synced_at"],
        "subscription_status": record["subscription_status"],
        "plan": record["plan"],
        # The widget acts on this rather than reading the raw
        # subscription status, so payment-provider vocabulary stays out
        # of the storefront.
        "active": _is_active(record),
    }


@app.get("/shops/{shop}/status")
def shop_status(shop: str) -> dict:
    """The same status by domain, for OAuth-installed shops."""
    record = db.get_shop(shop)
    if record is None:
        raise HTTPException(404, "Shop not installed")
    return {
        "shop": shop,
        "sync_status": record["sync_status"],
        "product_count": record["product_count"],
        "last_synced_at": record["last_synced_at"],
        "subscription_status": record["subscription_status"],
        "plan": record["plan"],
    }


@app.post("/sites/{site_key}/resync")
def resync_site(site_key: str, background_tasks: BackgroundTasks) -> dict:
    """Re-read the catalog now, rather than waiting for the schedule."""
    record = db.get_shop_by_site_key(site_key)
    if record is None:
        raise HTTPException(404, "Unknown site key")
    background_tasks.add_task(_run_public_ingestion, record["shop"])
    return {"status": "queued"}


# ---------------------------------------------------------------------
# Billing via Stripe. Selling direct means Shopify's Billing API isn't
# available — see billing.py for what that trades away.
# ---------------------------------------------------------------------


@app.get("/billing/plans")
def billing_plans() -> dict:
    return {
        "plans": {
            k: {"name": v["name"], "price": v["price"], "limit": v["limit"]}
            for k, v in billing.PLANS.items()
        },
        "currency": billing.CURRENCY,
        "trial_days": billing.TRIAL_DAYS,
        "enabled": billing.enabled(),
    }


@app.get("/billing/checkout")
def billing_checkout(k: str = Query(...), plan: str | None = Query(None)):
    """Send the merchant to Stripe to start a subscription.

    The plan defaults to the cheapest tier that covers the catalog we
    just counted, so a merchant with 80 products is never quoted the
    price of a 5,000-product store.
    """
    record = db.get_shop_by_site_key(k)
    if record is None:
        raise HTTPException(404, "Unknown site key")
    if not billing.enabled():
        raise HTTPException(503, "Billing isn't configured on this deployment")

    plan_key = plan or billing.plan_for_catalog(record["product_count"])
    try:
        url = billing.create_checkout_session(
            record["shop"],
            plan_key,
            success_url=f"{PUBLIC_URL}/install?k={k}",
            cancel_url=f"{PUBLIC_URL}/install?k={k}",
        )
    except Exception as exc:
        logger.exception("Stripe checkout failed for %s", record["shop"])
        raise HTTPException(502, f"Could not start checkout: {exc}") from exc

    db.set_subscription(record["shop"], "pending", plan=plan_key)
    return RedirectResponse(url)


@app.post("/webhooks/stripe")
async def stripe_webhook(request: Request, stripe_signature: str | None = Header(None)) -> dict:
    """Stripe's report on the subscription lifecycle.

    Verified against the *raw* body before parsing, for the same reason
    the Shopify webhooks are: parsing first would let a forged request
    through. This is what makes a cancellation or a failed payment
    actually take effect, since /search reads the cached status rather
    than calling Stripe on every query.
    """
    raw_body = await request.body()
    if not billing.verify_webhook_signature(raw_body, stripe_signature or ""):
        raise HTTPException(401, "Invalid Stripe signature")

    event = json.loads(raw_body)
    obj = event.get("data", {}).get("object", {})
    metadata = obj.get("metadata") or {}
    shop = metadata.get("shop") or obj.get("client_reference_id")
    if not shop:
        return {"status": "ignored"}

    event_type = event.get("type", "")
    if event_type == "checkout.session.completed":
        db.set_subscription(
            shop, "active", plan=metadata.get("plan"), subscription_id=obj.get("subscription")
        )
    elif event_type.startswith("customer.subscription."):
        status = "canceled" if event_type.endswith("deleted") else obj.get("status", "none")
        db.set_subscription(shop, status, subscription_id=obj.get("id"))
    else:
        return {"status": "ignored"}

    logger.info("Stripe %s -> %s", event_type, shop)
    return {"status": "recorded"}


_SIGNUP_PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Disc — a personalized commerce layer for your store</title>
<style>
  body { font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
         max-width: 640px; margin: 72px auto; padding: 0 24px; color: #141414; }
  h1 { font-size: 34px; letter-spacing: -0.03em; margin-bottom: 8px; }
  .sub { color: #666; margin-bottom: 40px; }
  input { width: 100%; padding: 15px 16px; font-size: 16px; border: 1px solid #ddd;
          border-radius: 11px; outline: none; margin-bottom: 12px; }
  input:focus { border-color: #141414; }
  button { width: 100%; padding: 15px; font-size: 16px; font-weight: 600; border: none;
           border-radius: 11px; background: #141414; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  .err { color: #b91c1c; margin-top: 14px; }
  .note { color: #777; font-size: 14px; }
</style>
<h1>Disc</h1>
<div class="sub">An AI-native personalized commerce layer for your Shopify store.
  One line of code, no app install.</div>

<input id="domain" placeholder="yourstore.com" autocomplete="url">
<input id="email" placeholder="you@yourstore.com (optional)" autocomplete="email">
<button id="go">Read my catalog</button>
<div class="err" id="err"></div>
<p class="note">Disc reads your public product catalog to build the index.
  Nothing is written to your store, and no customer data is touched.</p>

<script>
  var go = document.getElementById("go");
  go.onclick = function () {
    var err = document.getElementById("err");
    err.textContent = "";
    go.disabled = true;
    go.textContent = "Checking your store...";
    fetch("{{api}}/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: document.getElementById("domain").value,
        email: document.getElementById("email").value || null
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.b.detail || "Something went wrong");
        window.location = res.b.install_url;
      })
      .catch(function (e) {
        err.textContent = e.message;
        go.disabled = false;
        go.textContent = "Read my catalog";
      });
  };
</script>
"""

_INSTALL_PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Disc on {{domain}}</title>
<style>
  body { font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
         max-width: 680px; margin: 64px auto; padding: 0 24px; color: #141414; }
  h1 { font-size: 28px; letter-spacing: -0.02em; margin-bottom: 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: #888; margin: 40px 0 10px; }
  .domain { color: #777; margin-bottom: 8px; }
  pre { background: #f5f5f4; padding: 16px; border-radius: 11px; overflow-x: auto;
        font-size: 13.5px; }
  ol { padding-left: 20px; } li { margin-bottom: 7px; }
  .btn { display: inline-block; margin-top: 8px; padding: 12px 22px; border-radius: 10px;
         background: #141414; color: #fff; text-decoration: none; font-weight: 600; }
  .note { color: #777; font-size: 14px; }
  #status { font-weight: 600; }
</style>
<h1>Disc is reading {{domain}}</h1>
<div class="domain">Status: <span id="status">checking…</span></div>

<h2>Add this to your theme</h2>
<pre>{{snippet}}</pre>
<ol>
  <li>Shopify admin → <b>Online Store → Themes</b></li>
  <li>On your live theme: <b>… → Edit code</b></li>
  <li>Open <b>layout/theme.liquid</b></li>
  <li>Paste the line above just before <code>&lt;/body&gt;</code>, and Save</li>
</ol>
<p class="note">Your theme's own search box hides itself once Disc loads —
  shoppers don't need two. Remove the line to put it back.</p>

<h2>Plan</h2>
{{billing}}

<script>
  function poll() {
    fetch("{{api}}/sites/{{key}}/status")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var el = document.getElementById("status");
        if (s.sync_status === "ready") {
          el.textContent = s.product_count + " products indexed — ready";
          return;
        }
        if (s.sync_status === "error") {
          el.textContent = "couldn't read the catalog — check the domain";
          return;
        }
        el.textContent = "indexing…";
        setTimeout(poll, 3000);
      })
      .catch(function () { setTimeout(poll, 5000); });
  }
  poll();
</script>
"""


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


@app.post("/webhooks/app_subscriptions/update")
async def webhook_subscription_update(
    request: Request,
    x_shopify_shop_domain: str | None = Header(None),
    x_shopify_hmac_sha256: str | None = Header(None),
) -> dict:
    """Fires whenever a subscription changes — accepted, declined,
    cancelled, frozen for non-payment, or expired at the end of a trial.

    Without this, a cancellation would keep working until the merchant
    happened to reopen the app, because /search reads the cached status
    rather than calling Shopify on every query.
    """
    payload = await _verify_and_parse_webhook(request, x_shopify_hmac_sha256)
    subscription = payload.get("app_subscription") or {}
    status = subscription.get("status", "none")
    db.set_subscription(
        x_shopify_shop_domain, status, subscription_id=subscription.get("admin_graphql_api_id")
    )
    logger.info("Subscription for %s is now %s", x_shopify_shop_domain, status)
    return {"status": "recorded"}


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
