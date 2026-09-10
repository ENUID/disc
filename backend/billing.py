"""Billing via Stripe.

Disc is sold direct from our own site, not through the Shopify App
Store, so Shopify's Billing API isn't available to us — that one is only
for installed apps, and it's the reason this is Stripe instead. The
trade-offs of going direct, since they're the flip side of not waiting
on app review:

- We keep 100% minus Stripe's ~2.9% + 30c, with no Shopify revenue share
  and no $19 Partner registration.
- We also don't get Shopify's billing UI, its App Store distribution, or
  charges appearing on the merchant's existing Shopify invoice. The
  merchant enters a card on a Stripe Checkout page instead.
- Dunning, failed payments and cancellations are Stripe's to report and
  ours to react to, which is what the webhook below is for.

Talking to Stripe over `requests` rather than the `stripe` SDK keeps
requirements.txt to what's already there; the only non-obvious part is
webhook signature verification, which is implemented and tested here
rather than trusted blindly.

Pricing is tiered on **catalog size**, because catalog size is the only
thing about a shop that costs us anything real: embedding a product is a
one-time CPU cost and each shop's vectors sit in their own LanceDB table
on disk. Queries are effectively free — fastembed runs locally and there
is no per-search API call to anyone — so charging per search would be
taxing the part that costs nothing.
"""

import hashlib
import hmac
import logging
import os
import time

import requests

logger = logging.getLogger("disc.billing")

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_API = "https://api.stripe.com/v1"

TRIAL_DAYS = int(os.environ.get("DISC_TRIAL_DAYS", "14"))
CURRENCY = os.environ.get("DISC_CURRENCY", "usd")

# Stripe treats a subscription in its trial as fully live, so trials need
# no special case here.
ACTIVE_STATUSES = {"active", "trialing"}

# Placeholder economics — set these to whatever you actually want to
# charge, and create the matching Price objects in the Stripe dashboard.
# `limit` is the catalog ceiling the plan covers; None means unlimited.
# `price_id` is Stripe's `price_...` identifier; without it a plan can be
# displayed but not checked out.
PLANS = {
    "starter": {
        "name": "Disc Starter",
        "price": 29.0,
        "limit": 500,
        "price_id": os.environ.get("STRIPE_PRICE_STARTER", ""),
    },
    "growth": {
        "name": "Disc Growth",
        "price": 79.0,
        "limit": 5000,
        "price_id": os.environ.get("STRIPE_PRICE_GROWTH", ""),
    },
    "boutique": {
        "name": "Disc Boutique",
        "price": 199.0,
        "limit": None,
        "price_id": os.environ.get("STRIPE_PRICE_BOUTIQUE", ""),
    },
}
DEFAULT_PLAN = "starter"


def enabled() -> bool:
    """Whether billing can be enforced at all.

    Without a Stripe secret key there is nothing to charge through, so
    enforcing a subscription would lock out the only environments that
    can't have one: local development and the test suite. Gating on this
    keeps `test_multi_tenant.py` and `test.html` working exactly as
    before, while a deployed instance with real keys charges properly.
    """
    return bool(STRIPE_SECRET_KEY)


def plan_for_catalog(product_count: int) -> str:
    """The cheapest plan whose ceiling covers this catalog."""
    for key in ("starter", "growth", "boutique"):
        limit = PLANS[key]["limit"]
        if limit is None or product_count <= limit:
            return key
    return "boutique"


def _post(path: str, data: list[tuple[str, str]]) -> dict:
    response = requests.post(
        f"{STRIPE_API}{path}",
        auth=(STRIPE_SECRET_KEY, ""),
        data=data,
        timeout=20,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Stripe {response.status_code}: {response.text[:300]}")
    return response.json()


def create_checkout_session(shop: str, plan_key: str, success_url: str, cancel_url: str) -> str:
    """Start a subscription and return the Stripe-hosted page to pay on.

    The shop domain rides along as `client_reference_id` and as metadata,
    because the webhook that confirms payment arrives from Stripe with no
    idea which tenant it belongs to otherwise.
    """
    plan = PLANS.get(plan_key) or PLANS[DEFAULT_PLAN]
    if not plan["price_id"]:
        raise RuntimeError(
            f"No Stripe price configured for the {plan_key} plan — "
            f"set STRIPE_PRICE_{plan_key.upper()}"
        )

    payload = [
        ("mode", "subscription"),
        ("line_items[0][price]", plan["price_id"]),
        ("line_items[0][quantity]", "1"),
        ("success_url", success_url),
        ("cancel_url", cancel_url),
        ("client_reference_id", shop),
        ("metadata[shop]", shop),
        ("metadata[plan]", plan_key),
        ("subscription_data[metadata][shop]", shop),
        ("subscription_data[metadata][plan]", plan_key),
    ]
    if TRIAL_DAYS > 0:
        payload.append(("subscription_data[trial_period_days]", str(TRIAL_DAYS)))

    return _post("/checkout/sessions", payload)["url"]


def create_billing_portal_session(customer_id: str, return_url: str) -> str:
    """Stripe's own page for changing card, plan or cancelling.

    Worth using rather than building: cancellation and card updates are
    exactly the flows that are painful to get right and that Stripe
    already handles, including the resulting webhooks.
    """
    return _post(
        "/billing_portal/sessions",
        [("customer", customer_id), ("return_url", return_url)],
    )["url"]


def verify_webhook_signature(raw_body: bytes, signature_header: str, tolerance: int = 300) -> bool:
    """Verify Stripe's `Stripe-Signature` header against the raw body.

    Stripe signs `{timestamp}.{raw body}` with the endpoint's signing
    secret, sending `t=<ts>,v1=<hex>` (sometimes several v1s during a
    secret rotation, so any match counts). Two things this must not skip:
    the body has to be the *raw* bytes — parsing and re-serialising
    changes whitespace and breaks the signature — and the timestamp has
    to be checked, or a captured request stays replayable forever.
    """
    if not STRIPE_WEBHOOK_SECRET or not signature_header:
        return False

    timestamp = ""
    signatures = []
    for part in signature_header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)

    if not timestamp or not signatures:
        return False

    try:
        if abs(time.time() - int(timestamp)) > tolerance:
            return False
    except ValueError:
        return False

    signed = timestamp.encode() + b"." + raw_body
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, candidate) for candidate in signatures)
