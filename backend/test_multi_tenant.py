"""Tests for the multi-tenant OAuth app plumbing that don't require a real
Shopify Partner app, real credentials, or a publicly reachable deployment:

- HMAC verification (OAuth callback + webhook flavors), against
  self-computed signatures rather than ones Shopify actually issued.
- Admin API product JSON -> our record shape, against a fixture matching
  the real API's response shape.
- Full per-shop isolation: two fake shops are ingested (Admin API fetch
  monkeypatched to fixture data, since the real endpoint needs real
  credentials/network access) through the actual ingest_shop() function,
  then queried through the live, running /search endpoint to confirm one
  shop's results never leak into another's.

What this deliberately does NOT and CANNOT verify: that the real OAuth
authorize/token-exchange round trip works against Shopify's servers, or
that registered webhooks actually fire from a real store. Those need a
registered Partner app and a publicly reachable deployment — see
CLAUDE.md for exactly what's left to do to get there.

Run with the server already up (`uvicorn server:app --port 8000`):
    python test_multi_tenant.py
"""

import base64
import hashlib
import hmac
import json
import sys
import time
from datetime import datetime, timezone

import requests

import billing
import db
import multi_tenant_ingest
import public_ingest
import shopify_auth

API_URL = "http://localhost:8000"

_EMBEDDER = None


def _embedder():
    """One shared fastembed instance — loading the model twice in a test
    run costs more than the rest of the suite put together."""
    global _EMBEDDER
    if _EMBEDDER is None:
        from fastembed import TextEmbedding

        _EMBEDDER = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    return _EMBEDDER


FAILURES = []


def check(condition: bool, description: str) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"{status}: {description}")
    if not condition:
        FAILURES.append(description)


def test_oauth_callback_hmac() -> None:
    shopify_auth.API_SECRET = "test_secret_for_local_verification"
    params = {
        "shop": "test-shop.myshopify.com",
        "code": "abc123",
        "state": "xyz",
        "timestamp": "1234567890",
    }
    message = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    valid_hmac = hmac.new(shopify_auth.API_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()

    check(
        shopify_auth.verify_oauth_callback_hmac(dict(params, hmac=valid_hmac)) is True,
        "OAuth callback HMAC: accepts a correctly-signed set of params",
    )
    check(
        shopify_auth.verify_oauth_callback_hmac(dict(params, code="tampered", hmac=valid_hmac)) is False,
        "OAuth callback HMAC: rejects params tampered with after signing",
    )
    check(
        shopify_auth.verify_oauth_callback_hmac(dict(params)) is False,
        "OAuth callback HMAC: rejects a request with no hmac param at all",
    )


def test_webhook_hmac() -> None:
    shopify_auth.API_SECRET = "test_secret_for_local_verification"
    body = json.dumps({"id": 123, "title": "Test Product"}).encode()
    valid = base64.b64encode(
        hmac.new(shopify_auth.API_SECRET.encode(), body, hashlib.sha256).digest()
    ).decode()

    check(shopify_auth.verify_webhook_hmac(body, valid) is True, "Webhook HMAC: accepts a correctly-signed body")
    check(
        shopify_auth.verify_webhook_hmac(body + b"tampered", valid) is False,
        "Webhook HMAC: rejects a body modified after signing",
    )
    check(
        shopify_auth.verify_webhook_hmac(body, "not-the-right-signature") is False,
        "Webhook HMAC: rejects a mismatched signature",
    )


def test_product_json_parsing() -> None:
    fixture_product = {
        "id": 123456789,
        "title": "Wool Beanie",
        "body_html": "<p>A <strong>warm</strong> wool beanie for winter.</p>",
        "tags": "winter, wool, accessories",
        "variants": [{"price": "34.99"}],
        "images": [{"src": "https://cdn.shopify.com/example.jpg"}],
    }
    record = multi_tenant_ingest.product_to_record(fixture_product)
    check(record is not None, "product_to_record: returns a record for a normal product")
    check(record["id"] == "123456789", "product_to_record: id is stringified")
    check(
        record["description"] == "A warm wool beanie for winter.",
        "product_to_record: HTML tags stripped from body_html",
    )
    check(record["price"] == 34.99, "product_to_record: price parsed as float from the first variant")
    check(
        record["tags"] == ["winter", "wool", "accessories"],
        "product_to_record: comma-separated tag string split into a list",
    )
    check(
        multi_tenant_ingest.product_to_record({"id": 1, "title": "x", "variants": []}) is None,
        "product_to_record: a product with no variants (nothing purchasable) is excluded",
    )
    check(
        multi_tenant_ingest.table_name_for_shop("my-shop.myshopify.com") == "shop_my_shop_myshopify_com",
        "table_name_for_shop: sanitizes a shop domain into a safe LanceDB identifier",
    )


def test_multi_tenant_isolation() -> None:
    """Ingests two fake shops (Admin API call monkeypatched to fixture
    data) through the real ingest_shop() function, then confirms via the
    live /search endpoint that each shop only ever sees its own catalog.
    """
    shop_a = "test-shop-a.myshopify.com"
    shop_b = "test-shop-b.myshopify.com"

    products_a = [
        {
            "id": 1001,
            "title": "Alpha Store Denim Jacket",
            "body_html": "<p>A rugged denim jacket, exclusive to shop A.</p>",
            "tags": "denim, jacket",
            "variants": [{"price": "89.00"}],
            "images": [{"src": "https://cdn.example.com/a.jpg"}],
        }
    ]
    products_b = [
        {
            "id": 2001,
            "title": "Beta Store Silk Scarf",
            "body_html": "<p>An elegant silk scarf, exclusive to shop B.</p>",
            "tags": "silk, scarf",
            "variants": [{"price": "45.00"}],
            "images": [{"src": "https://cdn.example.com/b.jpg"}],
        }
    ]

    original_fetch = multi_tenant_ingest.fetch_all_products
    try:
        embedder = _embedder()

        multi_tenant_ingest.fetch_all_products = lambda shop, token: (
            products_a if shop == shop_a else products_b
        )
        count_a = multi_tenant_ingest.ingest_shop(shop_a, "fake-token-a", embedder)
        count_b = multi_tenant_ingest.ingest_shop(shop_b, "fake-token-b", embedder)
        check(count_a == 1 and count_b == 1, "ingest_shop: indexed exactly one product per fake shop")
    finally:
        multi_tenant_ingest.fetch_all_products = original_fetch

    now = datetime.now(timezone.utc).isoformat()
    db.upsert_shop(shop_a, "fake-token-a", "read_products", now)
    db.set_sync_status(shop_a, "ready", product_count=1, synced_at=now)
    db.upsert_shop(shop_b, "fake-token-b", "read_products", now)
    db.set_sync_status(shop_b, "ready", product_count=1, synced_at=now)

    resp_a = requests.post(f"{API_URL}/search", json={"query": "jacket", "limit": 5, "shop": shop_a}).json()
    resp_b = requests.post(f"{API_URL}/search", json={"query": "jacket", "limit": 5, "shop": shop_b}).json()

    titles_a = [r["title"] for r in resp_a["results"]]
    titles_b = [r["title"] for r in resp_b["results"]]

    check(
        "Alpha Store Denim Jacket" in titles_a and "Beta Store Silk Scarf" not in titles_a,
        "Isolation: shop A's search sees its own product, never shop B's",
    )
    check(
        "Beta Store Silk Scarf" in titles_b and "Alpha Store Denim Jacket" not in titles_b,
        "Isolation: shop B's search sees its own product, never shop A's",
    )

    # A shop registered but not yet synced should read as "syncing", not "no results".
    pending_shop = "test-shop-pending.myshopify.com"
    db.upsert_shop(pending_shop, "fake-token-c", "read_products", now)
    resp_pending = requests.post(
        f"{API_URL}/search", json={"query": "anything", "limit": 5, "shop": pending_shop}
    ).json()
    check(
        resp_pending["status"] == "syncing" and resp_pending["results"] == [],
        "A registered-but-not-yet-synced shop returns status='syncing', not empty-as-in-no-matches",
    )

    # Cleanup so repeated test runs don't accumulate fixture shops.
    for shop in (shop_a, shop_b, pending_shop):
        multi_tenant_ingest.delete_shop_table(shop)
        db.delete_shop(shop)


def test_webhook_rejects_bad_signature() -> None:
    resp = requests.post(
        f"{API_URL}/webhooks/products/create",
        headers={"X-Shopify-Hmac-Sha256": "not-a-real-signature", "X-Shopify-Shop-Domain": "x.myshopify.com"},
        json={"id": 1, "title": "x"},
    )
    check(resp.status_code == 401, "Webhook endpoint rejects a request with an invalid HMAC signature (401)")


def test_storefront_endpoints() -> None:
    """The surfaces the boutique UI depends on: a detail payload rich
    enough to render a product page, and a 'look' that's an outfit rather
    than four more of the same garment."""
    detail = requests.get(f"{API_URL}/product/p001", timeout=30).json()
    check(detail["id"] == "p001", "/product returns the requested product")
    check(len(detail["images"]) > 1, "/product returns a full image set, not just one thumbnail")
    check(len(detail["variants"]) > 1, "/product returns purchasable variants for the size picker")
    check(
        any(not v["available"] for v in detail["variants"]),
        "/product preserves per-variant availability so sold-out sizes can be shown as such",
    )
    check(bool(detail["handle"]), "/product returns a handle for real storefront links")
    check(bool(detail["reasoning"]), "/product returns HOW TO STYLE copy")

    look = requests.get(f"{API_URL}/look/p001", timeout=30).json()
    types = [r["product_type"] for r in look["results"]]
    check(len(look["results"]) > 0, "/look returns complementary pieces")
    check(
        detail["product_type"] not in types,
        "/look excludes the item's own category — an outfit, not near-duplicates",
    )
    check(len(types) == len(set(types)), "/look returns at most one piece per category")
    check(
        all(r["id"] != "p001" for r in look["results"]),
        "/look never recommends the item you're already looking at",
    )

    missing = requests.get(f"{API_URL}/product/does-not-exist", timeout=30)
    check(missing.status_code == 404, "/product 404s on an unknown id rather than 500ing")


def test_public_catalog_parsing() -> None:
    """The storefront's public products.json differs from the Admin API in
    exactly two ways, and both silently corrupt a shop's index rather than
    raising, so both are pinned here."""
    public_product = {
        "id": 987654321,
        "title": "Merino Runner",
        "body_html": "<p>Light <b>wool</b> sneakers.</p>",
        # A real list, where the Admin API sends "a, b, c"
        "tags": ["wool", "shoes", "everyday"],
        "product_type": "Shoes",
        "handle": "merino-runner",
        "variants": [
            # An explicit availability flag, where the Admin API sends
            # inventory numbers instead
            {"id": 1, "title": "8", "price": "98.00", "available": True, "option1": "Grey"},
            {"id": 2, "title": "9", "price": "98.00", "available": False},
        ],
        "images": [{"src": "https://cdn.shopify.com/a.jpg"}, {"src": "https://cdn.shopify.com/b.jpg"}],
    }
    record = multi_tenant_ingest.product_to_record(public_product)
    check(
        record["tags"] == ["wool", "shoes", "everyday"],
        "public JSON: a tag list is kept as a list (Admin API sends a string)",
    )
    check(
        [v["available"] for v in record["variants"]] == [True, False],
        "public JSON: the explicit `available` flag is honoured, so sold-out sizes stay sold out",
    )
    check(
        record["colour"] == "Grey" and len(record["images"]) == 2,
        "public JSON: colour and the full image set survive ingestion",
    )

    # The Admin API shape must keep working — both sources share this function.
    admin_record = multi_tenant_ingest.product_to_record(
        {
            "id": 5,
            "title": "x",
            "tags": "a, b",
            "variants": [{"id": 9, "price": "1.00", "inventory_management": None}],
        }
    )
    check(
        admin_record["tags"] == ["a", "b"] and admin_record["variants"][0]["available"] is True,
        "Admin API shape still parses: comma tags split, untracked inventory means buyable",
    )

    check(
        public_ingest.normalise_domain("https://WWW.Shop.com/collections/all?x=1") == "shop.com",
        "normalise_domain: strips scheme, www, path and query, and lowercases",
    )


def test_self_serve_signup() -> None:
    """The signup -> site key -> scoped search path, without touching
    Shopify OAuth or Stripe.

    The storefront fetch is monkeypatched, so this doesn't depend on a
    third-party store being up — but the domain probe, key issuance, key
    persistence and per-key search scoping are all the real code paths.
    """
    domain = "test-selfserve-shop.example"
    fixture = [
        {
            "id": 7001,
            "title": "Selfserve Store Cashmere Scarf",
            "body_html": "<p>A soft scarf, only in the self-serve fixture shop.</p>",
            "tags": ["cashmere", "scarf"],
            "product_type": "Accessories",
            "variants": [{"id": 1, "title": "One size", "price": "120.00", "available": True}],
            "images": [{"src": "https://cdn.example.com/scarf.jpg"}],
        }
    ]

    original_fetch = public_ingest.fetch_public_products
    original_probe = public_ingest.probe_storefront
    public_ingest.fetch_public_products = lambda d: fixture
    public_ingest.probe_storefront = lambda d: len(fixture)
    try:
        site_key = "disc_" + "f" * 32
        db.create_site(domain, site_key, "merchant@example.com")
        count = public_ingest.ingest_public_shop(domain, _embedder())
        db.set_sync_status(
            domain, "ready", product_count=count, synced_at=datetime.now(timezone.utc).isoformat()
        )
        check(count == 1, "ingest_public_shop: indexes the public catalog into the shop's own table")

        # Re-signing up must not rotate the key — it's already pasted into
        # a live theme, and a new one would silently kill Disc there.
        db.create_site(domain, "disc_" + "e" * 32, None)
        check(
            db.get_shop(domain)["site_key"] == site_key,
            "create_site: signing up again keeps the existing site key",
        )
        check(
            db.get_shop_by_site_key(site_key)["shop"] == domain,
            "get_shop_by_site_key: a site key resolves back to its shop",
        )

        scoped = requests.post(
            f"{API_URL}/search",
            json={"query": "soft scarf", "limit": 5, "site_key": site_key},
            timeout=60,
        ).json()
        titles = [r["title"] for r in scoped["results"]]
        check(
            titles == ["Selfserve Store Cashmere Scarf"],
            "/search scoped by site_key returns only that shop's catalog",
        )

        status = requests.get(f"{API_URL}/sites/{site_key}/status", timeout=30).json()
        check(
            status["domain"] == domain and status["sync_status"] == "ready",
            "/sites/{key}/status reports the shop's indexing state",
        )
        check(
            status["active"] is True,
            "/sites/{key}/status reports active when billing isn't configured, "
            "so a keyless dev deployment isn't locked out",
        )

        embed = requests.get(f"{API_URL}/embed.js", params={"k": site_key}, timeout=30)
        check(
            embed.status_code == 200 and site_key in embed.text and "disc-search-bar" in embed.text,
            "/embed.js serves the widget with the site key baked in",
        )
        unknown = requests.get(f"{API_URL}/embed.js", params={"k": "disc_nope"}, timeout=30)
        check(
            unknown.status_code == 200,
            "/embed.js still serves for an unknown key — a hard failure would "
            "throw a JS error on a live storefront",
        )

        bad = requests.get(f"{API_URL}/sites/disc_nope/status", timeout=30)
        check(bad.status_code == 404, "/sites/{key}/status 404s on an unknown key")
    finally:
        public_ingest.fetch_public_products = original_fetch
        public_ingest.probe_storefront = original_probe
        multi_tenant_ingest.delete_shop_table(domain)
        db.delete_shop(domain)


def test_stripe_webhook_signature() -> None:
    """Stripe's signature scheme, which is a third distinct one from the
    two Shopify schemes already covered above."""
    secret = "whsec_test_secret"
    original = billing.STRIPE_WEBHOOK_SECRET
    billing.STRIPE_WEBHOOK_SECRET = secret
    try:
        body = b'{"type":"checkout.session.completed"}'
        timestamp = str(int(time.time()))
        signed = f"{timestamp}.".encode() + body
        digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

        check(
            billing.verify_webhook_signature(body, f"t={timestamp},v1={digest}"),
            "Stripe webhook: accepts a correctly-signed request",
        )
        check(
            not billing.verify_webhook_signature(body + b" ", f"t={timestamp},v1={digest}"),
            "Stripe webhook: rejects a tampered body",
        )
        check(
            not billing.verify_webhook_signature(body, f"t={timestamp},v1={'0' * 64}"),
            "Stripe webhook: rejects a bad signature",
        )
        old = str(int(time.time()) - 9999)
        old_digest = hmac.new(
            secret.encode(), f"{old}.".encode() + body, hashlib.sha256
        ).hexdigest()
        check(
            not billing.verify_webhook_signature(body, f"t={old},v1={old_digest}"),
            "Stripe webhook: rejects a correctly-signed but stale request (replay guard)",
        )

        rejected = requests.post(
            f"{API_URL}/webhooks/stripe", data=body, headers={"Stripe-Signature": "t=1,v1=bad"},
            timeout=30,
        )
        check(
            rejected.status_code == 401,
            "/webhooks/stripe rejects an unsigned request before parsing it",
        )
    finally:
        billing.STRIPE_WEBHOOK_SECRET = original


def test_plan_selection() -> None:
    check(billing.plan_for_catalog(80) == "starter", "plan_for_catalog: a small catalog gets Starter")
    check(
        billing.plan_for_catalog(3000) == "growth",
        "plan_for_catalog: a mid catalog gets the next tier up",
    )
    check(
        billing.plan_for_catalog(50000) == "boutique",
        "plan_for_catalog: an unlimited-tier catalog gets Boutique",
    )
    check(
        not billing.enabled(),
        "billing.enabled() is False without a Stripe key, so dev and tests aren't gated",
    )


def main() -> int:
    test_oauth_callback_hmac()
    test_webhook_hmac()
    test_product_json_parsing()
    test_public_catalog_parsing()
    test_multi_tenant_isolation()
    test_self_serve_signup()
    test_stripe_webhook_signature()
    test_plan_selection()
    test_webhook_rejects_bad_signature()
    test_storefront_endpoints()

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s) did not pass:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
