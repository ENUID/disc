"""Catalog ingestion without an app install.

Disc is distributed as a script tag from our own site, not as a Shopify
App Store listing, so there is no OAuth handshake and no Admin API token
to read a merchant's catalog with. The way in instead is the storefront's
own `/products.json`, which every Shopify store serves publicly by
default — the same data the theme itself renders, no credentials
involved.

What this costs, stated plainly because it decides what Disc can promise:

- **Published products only.** Drafts and unpublished products are
  invisible here. For a search widget that's the correct set anyway.
- **No webhooks.** Webhook registration needs an app. Catalogs are kept
  fresh by re-fetching on a schedule (`resync_due_shops`) instead of
  reacting to changes, so an edit shows up within the resync interval
  rather than instantly.
- **A merchant can switch it off.** Some stores disable the endpoint or
  put it behind a password/bot rule. `probe_storefront` checks at signup
  so they find out immediately, not after pasting the snippet.

Everything above is why the OAuth path in `shopify_auth.py` and
`multi_tenant_ingest.fetch_all_products` is kept rather than deleted: it
is strictly better on all three counts, and is the upgrade once an App
Store listing is approved. The record shape, embedding and per-shop table
are identical either way, so switching a shop over changes only where the
JSON came from.
"""

import logging

import requests
from fastembed import TextEmbedding

import multi_tenant_ingest

logger = logging.getLogger("disc.public_ingest")

PAGE_SIZE = 250
MAX_PAGES = 40  # 10,000 products; a guard against paginating forever

# Storefronts block unrecognised clients more often than not, and a bare
# python-requests UA is the first thing a bot rule rejects.
_HEADERS = {
    "User-Agent": "Disc/1.0 (+https://enuidlabs.com/disc; catalog indexer)",
    "Accept": "application/json",
}


def normalise_domain(raw: str) -> str:
    """'https://Shop.com/collections/all' -> 'shop.com'.

    Merchants paste whatever is in their address bar, so this accepts a
    bare domain, a full URL, a trailing slash or a path, and it lowercases
    — the domain is a database key, and 'Shop.com' and 'shop.com' must not
    become two tenants.
    """
    domain = (raw or "").strip().lower()
    for prefix in ("https://", "http://"):
        if domain.startswith(prefix):
            domain = domain[len(prefix) :]
    domain = domain.split("/")[0].split("?")[0]
    if domain.startswith("www."):
        domain = domain[4:]
    return domain


def fetch_public_products(domain: str) -> list[dict]:
    """Every published product, via the storefront's public JSON.

    Note this paginates with `?page=`, not the Admin API's Link-header
    cursor — the two endpoints look alike but page differently.
    """
    products: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        response = requests.get(
            f"https://{domain}/products.json",
            params={"limit": PAGE_SIZE, "page": page},
            headers=_HEADERS,
            timeout=30,
        )
        response.raise_for_status()
        batch = response.json().get("products", [])
        if not batch:
            break
        products.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
    return products


class StorefrontUnreachable(Exception):
    """The domain isn't a Shopify store we can read a catalog from."""


def probe_storefront(domain: str) -> int:
    """Confirm at signup that this really is a readable Shopify catalog.

    Signing someone up and only failing later — after they've pasted the
    snippet into their theme and are watching an empty bar — is the worst
    version of this. One request now turns that into an answer on the
    signup form.
    """
    try:
        response = requests.get(
            f"https://{domain}/products.json",
            params={"limit": 1},
            headers=_HEADERS,
            timeout=15,
        )
    except requests.RequestException as exc:
        raise StorefrontUnreachable(f"Couldn't reach {domain}: {exc}") from exc

    if response.status_code != 200:
        raise StorefrontUnreachable(
            f"{domain} returned {response.status_code} for /products.json. "
            "If this is a password-protected or non-Shopify store, Disc can't read it yet."
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise StorefrontUnreachable(
            f"{domain} didn't return product JSON — is it a Shopify store?"
        ) from exc

    if "products" not in payload:
        raise StorefrontUnreachable(f"{domain} didn't return a product list — is it Shopify?")
    return len(payload["products"])


def ingest_public_shop(domain: str, embedder: TextEmbedding) -> int:
    """Full re-ingestion from the public catalog into the shop's own table.

    Deliberately reuses `multi_tenant_ingest`'s record shape, embedding
    text and per-shop table naming, so a shop ingested this way is
    indistinguishable at search time from one ingested over OAuth — and
    per-shop isolation is enforced in exactly one place for both.
    """
    raw_products = fetch_public_products(domain)
    records = [
        r for r in (multi_tenant_ingest.product_to_record(p) for p in raw_products) if r is not None
    ]
    return multi_tenant_ingest.write_records(domain, records, embedder)
