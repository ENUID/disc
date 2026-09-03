"""Shopify OAuth + webhook HMAC verification.

Everything here is standard Shopify app-auth plumbing:
https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

Requires three real values from a Shopify Partner Dashboard app
registration — SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and APP_URL (this
backend's own public HTTPS URL, used to build the OAuth redirect_uri).
None of those can be fabricated locally; see CLAUDE.md for the manual
setup steps that produce them.
"""

import base64
import hashlib
import hmac
import os
import urllib.parse

import requests

API_KEY = os.environ.get("SHOPIFY_API_KEY", "")
API_SECRET = os.environ.get("SHOPIFY_API_SECRET", "")
SCOPES = os.environ.get("SHOPIFY_SCOPES", "read_products")
APP_URL = os.environ.get("APP_URL", "http://localhost:8000")

ADMIN_API_VERSION = "2024-01"


def build_authorize_url(shop: str, state: str) -> str:
    redirect_uri = f"{APP_URL}/auth/callback"
    params = {
        "client_id": API_KEY,
        "scope": SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"https://{shop}/admin/oauth/authorize?" + urllib.parse.urlencode(params)


def verify_oauth_callback_hmac(query_params: dict) -> bool:
    """Verify the `hmac` query param Shopify attaches to the OAuth callback.

    Every other query param (sorted, `key=value`, joined with `&`) is
    HMAC-SHA256-signed with the app's client secret; a mismatch means the
    redirect wasn't actually issued by Shopify.
    """
    if not API_SECRET:
        return False
    params = dict(query_params)
    received = params.pop("hmac", None)
    if not received:
        return False
    message = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    computed = hmac.new(API_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(computed, received)


def verify_webhook_hmac(raw_body: bytes, header_hmac: str) -> bool:
    """Verify the X-Shopify-Hmac-Sha256 header Shopify sends on every webhook.

    This is a *different* HMAC scheme than the OAuth callback's: base64,
    computed over the exact raw request body (not parsed/re-serialized —
    any whitespace difference would break the signature).
    """
    if not API_SECRET or not header_hmac:
        return False
    computed = hmac.new(API_SECRET.encode(), raw_body, hashlib.sha256).digest()
    computed_b64 = base64.b64encode(computed).decode()
    return hmac.compare_digest(computed_b64, header_hmac)


def exchange_code_for_token(shop: str, code: str) -> dict:
    """POST to the shop's token endpoint; returns {"access_token", "scope"}."""
    response = requests.post(
        f"https://{shop}/admin/oauth/access_token",
        json={"client_id": API_KEY, "client_secret": API_SECRET, "code": code},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def register_webhooks(shop: str, access_token: str) -> None:
    """Register the product + uninstall webhooks this app relies on for
    incremental sync. GDPR webhooks (customers_data_request, customers_redact,
    shop_redact) are configured in the Partner Dashboard, not the Admin API,
    so they aren't registered here.
    """
    topics_and_paths = [
        ("products/create", "/webhooks/products/create"),
        ("products/update", "/webhooks/products/update"),
        ("products/delete", "/webhooks/products/delete"),
        ("app/uninstalled", "/webhooks/app/uninstalled"),
        # Billing state changes — a cancellation or a failed payment has
        # to reach us without waiting for the merchant to reopen the app.
        ("app_subscriptions/update", "/webhooks/app_subscriptions/update"),
    ]
    headers = {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
    }
    for topic, path in topics_and_paths:
        requests.post(
            f"https://{shop}/admin/api/{ADMIN_API_VERSION}/webhooks.json",
            headers=headers,
            json={"webhook": {"topic": topic, "address": f"{APP_URL}{path}", "format": "json"}},
            timeout=15,
        )
