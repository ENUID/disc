import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import {
  randomToken,
  verifyShopifyOAuthHmac,
  timingSafeEqual,
  verifyShopifyWebhookHmac,
  verifyStripeSignature,
} from "./lib/crypto";
import { encryptSecret } from "./lib/crypto";
// Interpretation moved into `recordStripeEvent` in P1.5: it has to
// happen in the same transaction as the deduplication check, so the
// route now only verifies and hands off.
import {
  ADMIN_KEY,
  DASHBOARD_URL,
  ENCRYPTION_KEY,
  OAUTH_STATE_TTL_MS,
  PUBLIC_URL,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  STRIPE_WEBHOOK_SECRET,
} from "./lib/env";
import {
  exchangeCodeUrl,
  isValidShopDomain,
  registerWebhooks,
} from "./shopify/admin";
import { parseDeliveryHeaders } from "./lib/webhooks";

/**
 * HTTP surface.
 *
 * Storefront routes are deliberately path- and shape-compatible with the
 * Python backend's, so `frontend/disc-widget.js` works against either
 * without a single edit and its Playwright suites stay valid. That is
 * what makes the migration reversible.
 *
 * The security boundary that the prototype lacked is enforced here:
 * storefront routes take a `publicKey` and can only read that shop's own
 * catalog; merchant routes require a bearer session token.
 */

const http = httpRouter();

/** Storefront requests come from arbitrary merchant domains. */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS }));

/**
 * Register the CORS preflight for a path, at most once.
 *
 * Idempotent on purpose. Convex's router throws on a duplicate
 * path/method at import time, and a path with both a GET and a POST
 * naturally wants its OPTIONS declared next to each — which is a
 * deploy-time crash the type checker cannot see. Two of these had
 * already accumulated before `http.itest.ts` was written.
 */
const preflightPaths = new Set<string>();
function allowPreflight(path: string) {
  if (preflightPaths.has(path)) return;
  preflightPaths.add(path);
  http.route({ path, method: "OPTIONS", handler: preflight });
}

// ---------------------------------------------------------------------
// Storefront API — public key only, read-only, that shop's own catalog.
// ---------------------------------------------------------------------

/**
 * Rate limiting (spec §90).
 *
 * Keyed on the public key rather than an IP: shoppers share NATs and
 * mobile carriers, so per-IP limits punish real customers, and the
 * tenant is the party whose costs this protects.
 *
 * Returns null when the request may proceed, or a 429 when it may not.
 */
async function rateLimited(
  ctx: MerchantCtx,
  rule: string,
  identifier: string,
): Promise<Response | null> {
  if (!identifier) return null;
  const decision = await ctx.runMutation(internal.billing.consumeRateLimit, {
    rule,
    tenantId: identifier,
  });
  if (decision.allowed) return null;

  return json({ detail: "Too many requests", status: "rate_limited" }, 429, {
    "Retry-After": String(decision.retryAfterSeconds),
  });
}

allowPreflight("/search");
http.route({
  path: "/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    const publicKey = body.site_key ?? body.publicKey ?? "";
    if (!publicKey) return json({ query: "", results: [], status: "unknown" });

    const limited = await rateLimited(ctx as MerchantCtx, "search", publicKey);
    if (limited) return limited;

    const result = await ctx.runAction(api.search.search, {
      publicKey,
      query: String(body.query ?? ""),
      limit: body.limit,
    });
    return json(result);
  }),
});

allowPreflight("/product");
http.route({
  pathPrefix: "/product/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const productId = decodeURIComponent(url.pathname.replace(/^\/product\//, ""));
    const publicKey = url.searchParams.get("site_key") ?? "";

    const product = await ctx.runAction(api.search.productDetail, {
      publicKey,
      productId,
    });
    if (!product) return json({ detail: "Product not found" }, 404);
    return json(product);
  }),
});

http.route({
  pathPrefix: "/look/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const productId = decodeURIComponent(url.pathname.replace(/^\/look\//, ""));
    const publicKey = url.searchParams.get("site_key") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "4");

    const result = await ctx.runAction(api.search.completeTheLook, {
      publicKey,
      productId,
      limit: Number.isFinite(limit) ? limit : 4,
    });
    return json(result);
  }),
});

/**
 * The decision engine (spec §43-§61).
 *
 * A new route rather than a change to `/look/{id}`: the existing one
 * returns a flat list of complementary products and the widget renders
 * it that way today. This returns structured outfits with explanations,
 * which is a different shape. Keeping both means the widget can adopt it
 * when its UI is ready, without a flag day.
 */
allowPreflight("/outfit");
http.route({
  path: "/outfit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    const publicKey = body.site_key ?? body.publicKey ?? "";
    if (!publicKey) return json({ outfits: [], status: "unknown" });

    // Tighter than /search: this path can reach a model.
    const limited = await rateLimited(ctx as MerchantCtx, "outfit", publicKey);
    if (limited) return limited;

    const result = await ctx.runAction(api.outfits.buildLook, {
      publicKey,
      query: body.query,
      anchorProductId: body.product_id,
      sessionKey: body.session_key,
      limit: body.limit,
    });
    return json(result);
  }),
});

/**
 * Boot config, resolved by shop domain.
 *
 * The theme app extension knows the shop but carries no key; this is
 * where it gets one. The widget calls this before hiding anything, so a
 * lapsed, unknown or not-yet-activated tenant never costs a storefront
 * its own search box.
 */
allowPreflight("/storefront/config");
http.route({
  path: "/storefront/config",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const shopDomain = new URL(request.url).searchParams.get("shop") ?? "";
    const config = shopDomain
      ? await ctx.runQuery(api.tenants.storefrontConfigByDomain, { shopDomain })
      : null;

    // An unknown shop resolves as inactive rather than 404: the widget
    // reads this as "stay dormant", which is the safe direction. A store
    // that has not finished installing must not lose its own search box.
    if (!config) {
      return json({ active: false, catalog_status: "unknown" }, 200, {
        "Cache-Control": "public, max-age=60",
      });
    }

    return json(
      {
        public_key: config.publicKey,
        active: config.active,
        catalog_status: config.catalogStatus,
        widget_status: config.widgetStatus,
        brand_tokens: config.brandTokens,
        widget_config: config.widgetConfig,
      },
      200,
      // Short enough that activating Disc shows up promptly, long enough
      // that a busy storefront is not re-asking on every page view.
      { "Cache-Control": "public, max-age=300" },
    );
  }),
});

/**
 * Boot check by public key. Kept alongside the domain route so an
 * install that already carries a key keeps working.
 */
http.route({
  pathPrefix: "/sites/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sites\/([^/]+)\/status$/);
    if (!match) return json({ detail: "Not found" }, 404);

    const config = await ctx.runQuery(api.tenants.storefrontConfig, {
      publicKey: decodeURIComponent(match[1]),
    });
    // An unknown key resolves as inactive rather than 404: the widget
    // treats it as "stay dormant", which is the safe direction.
    if (!config) return json({ active: false, catalog_status: "unknown" });

    return json({
      active: config.active,
      catalog_status: config.catalogStatus,
      widget_status: config.widgetStatus,
      brand_tokens: config.brandTokens,
      // The same config the domain route serves, from the same function.
      // Omitting it here would have made where Disc appears depend on
      // which boot path an install happened to use — a merchant who set
      // a floating button would have got a docked bar on a key-based
      // install and never known why.
      widget_config: config.widgetConfig,
    });
  }),
});

/**
 * Storefront event reporting (spec §80).
 *
 * Public by necessity — the widget runs on the merchant's own page, so
 * there is no credential it could hold that a shopper could not read.
 * Two consequences are handled rather than assumed away:
 *
 *   - only the safe subset of event types is accepted, so a forged
 *     request cannot write `purchase` and inflate a merchant's revenue
 *   - the payload is bounded, so one request cannot write an arbitrarily
 *     large document
 *
 * Always answers 204, even for a rejected event. A storefront must never
 * see an error from analytics; the shopper is not the one who needs to
 * know, and a failing beacon must not surface as a console error on a
 * merchant's shop.
 */
allowPreflight("/events");
http.route({
  path: "/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const noContent = new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      const body = await request.json();
      const publicKey = body.site_key ?? body.publicKey;
      if (!publicKey) return noContent;

      const tenant = await ctx.runQuery(internal.search.resolveStorefront, { publicKey });
      if (!tenant) return noContent;

      // A batch, so the widget can flush several events in one beacon
      // rather than one request per interaction.
      const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
      for (const event of events) {
        await ctx.runMutation(internal.analytics.recordEvent, {
          tenantId: tenant.tenantId,
          type: String(event?.type ?? ""),
          sessionKey: event?.session_key ? String(event.session_key) : undefined,
          recommendationId: event?.recommendation_id
            ? String(event.recommendation_id)
            : undefined,
          productIds: Array.isArray(event?.product_ids)
            ? event.product_ids.map((id: unknown) => String(id))
            : undefined,
          payload: event?.payload,
          fromClient: true,
        });
      }
    } catch {
      // Malformed body. Nothing to report to a storefront.
    }
    return noContent;
  }),
});

// ---------------------------------------------------------------------
// Shopify OAuth (custom distribution).
// ---------------------------------------------------------------------

http.route({
  path: "/auth",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const shop = new URL(request.url).searchParams.get("shop") ?? "";
    if (!isValidShopDomain(shop)) {
      return json({ detail: "shop must be a valid *.myshopify.com domain" }, 400);
    }

    const state = randomToken();
    await ctx.runMutation(internal.shopify.oauth.saveState, {
      state,
      shopDomain: shop,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });

    const params = new URLSearchParams({
      client_id: SHOPIFY_API_KEY(),
      scope: SHOPIFY_SCOPES(),
      redirect_uri: `${PUBLIC_URL()}/auth/callback`,
      state,
    });
    return Response.redirect(`https://${shop}/admin/oauth/authorize?${params}`, 302);
  }),
});

http.route({
  path: "/auth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (params[key] = value));

    const shop = params.shop ?? "";
    if (!isValidShopDomain(shop)) return json({ detail: "Invalid shop" }, 400);

    // State first (CSRF), then HMAC (authenticity). Both before the code
    // is exchanged for anything.
    const consumed = await ctx.runMutation(internal.shopify.oauth.consumeState, {
      state: params.state ?? "",
      shopDomain: shop,
    });
    if (!consumed) return json({ detail: "Invalid or expired OAuth state" }, 403);

    if (!(await verifyShopifyOAuthHmac(params, SHOPIFY_API_SECRET()))) {
      return json({ detail: "Invalid HMAC on OAuth callback" }, 403);
    }

    const tokenResponse = await fetch(exchangeCodeUrl(shop), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY(),
        client_secret: SHOPIFY_API_SECRET(),
        code: params.code,
      }),
    });
    if (!tokenResponse.ok) {
      return json({ detail: "Token exchange failed" }, 502);
    }
    const tokenData = await tokenResponse.json();

    // Encrypted before it is ever handed to the database. The plaintext
    // token exists only in this function's scope and is never logged.
    const cipher = await encryptSecret(tokenData.access_token, ENCRYPTION_KEY());

    const tenantId = await ctx.runMutation(internal.tenants.createOrUpdateFromInstall, {
      shopDomain: shop,
      accessTokenCipher: cipher,
      scopes: tokenData.scope ?? "",
    });

    // Best-effort: a webhook that fails to register degrades this tenant
    // to periodic resync, which is a slower catalog rather than a broken
    // install, so it must not fail the install.
    await registerWebhooks(shop, tokenData.access_token, PUBLIC_URL());

    // Enqueued rather than scheduled directly, so a merchant who
    // reinstalls twice in quick succession gets one first ingestion
    // rather than two racing full catalog reads.
    await ctx.runMutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    const sessionToken = await ctx.runMutation(internal.auth.issueSession, { tenantId });

    const dashboard = DASHBOARD_URL() || PUBLIC_URL();
    return Response.redirect(
      `${dashboard}/app?token=${encodeURIComponent(sessionToken)}`,
      302,
    );
  }),
});

// ---------------------------------------------------------------------
// Shopify webhooks. Raw body, verify, THEN parse — parse-then-verify
// would mean a forged payload had already been interpreted.
// ---------------------------------------------------------------------

/**
 * The resource version a product job is keyed on.
 *
 * Shopify's `updated_at` changes when and only when the product does, so
 * two deliveries of one edit share it and collapse to one job. It is NOT
 * the delivery identity — that is `X-Shopify-Webhook-Id`, handled by the
 * ledger — and it is NOT the event identity, which is
 * `X-Shopify-Event-Id` and is stored for correlation only.
 *
 * A missing timestamp falls back to something unique-per-delivery rather
 * than to the product id: keying on the id alone would make every edit of
 * a product look like the same work and permanently suppress real
 * updates. Losing deduplication is recoverable, losing an update is not.
 */
function productDiscriminator(payload: { updated_at?: unknown; id?: unknown }): string {
  if (typeof payload.updated_at === "string" && payload.updated_at) {
    return payload.updated_at;
  }
  return `nots-${Date.now()}`;
}

/** The payload's own `updated_at`, when it has one. */
function resourceUpdatedAt(payload: { updated_at?: unknown }): string | undefined {
  return typeof payload.updated_at === "string" && payload.updated_at
    ? payload.updated_at
    : undefined;
}

async function verifiedWebhook(
  request: Request,
): Promise<{ shopDomain: string; payload: any } | null> {
  const raw = await request.arrayBuffer();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!(await verifyShopifyWebhookHmac(raw, hmac, SHOPIFY_API_SECRET()))) return null;

  const shopDomain = request.headers.get("X-Shopify-Shop-Domain") ?? "";
  if (!isValidShopDomain(shopDomain)) return null;

  return { shopDomain, payload: JSON.parse(new TextDecoder().decode(raw)) };
}

/**
 * Verify, resolve the tenant, then hand the delivery to the ledger.
 *
 * The route decides only WHAT a topic means; `recordDelivery` decides
 * whether this particular delivery should cause it. Routes therefore
 * return an action rather than performing one — a route that did its own
 * work would be doing it outside the deduplication and freshness checks,
 * which is the shape of the bug this phase exists to remove.
 *
 * Ordering note: the ledger is written after the tenant is resolved, not
 * before. A delivery for a shop Disc does not have causes no work in any
 * case, so there is nothing to deduplicate, and keeping the table
 * strictly tenant-scoped is what lets `purgeTenant` clear it and the
 * privacy guard verify that it does.
 */
function shopifyWebhook(
  toAction: (payload: any) => Record<string, unknown>,
  topic: string,
) {
  return httpAction(async (ctx, request) => {
    const verified = await verifiedWebhook(request);
    if (!verified) return new Response("Unauthorized", { status: 401 });

    const headers = parseDeliveryHeaders(request.headers);

    const tenant = await ctx.runQuery(internal.tenants.getByShopDomain, {
      shopDomain: verified.shopDomain,
    });
    // 200 on an unknown shop: Shopify retries non-2xx, and retrying a
    // webhook for a tenant we do not have will never succeed.
    if (!tenant) return new Response("OK", { status: 200 });

    await ctx.runMutation(internal.webhooks.recordDelivery, {
      tenantId: tenant._id,
      webhookId: headers.webhookId ?? undefined,
      // Correlation only. Never compared, never deduplicated on: one
      // merchant action fans out to every subscribed topic, and treating
      // the second delivery as a duplicate would drop a topic.
      eventId: headers.eventId ?? undefined,
      topic: headers.topic ?? topic,
      triggeredAt: headers.triggeredAt,
      resourceUpdatedAt: resourceUpdatedAt(verified.payload),
      action: toAction(verified.payload),
    });

    // Acknowledge fast (spec §91); real work is scheduled, not inline.
    // A stale or duplicate delivery is also a 200 — Shopify retries a
    // non-2xx, and both would still be stale or duplicate next time.
    return new Response("OK", { status: 200 });
  });
}

/**
 * `products/create` and `products/update` are the same work.
 *
 * Deliberately identical handlers rather than one route: Shopify does not
 * guarantee ordering across topics for one resource, so an `update` can
 * arrive before the `create` it followed. Treating them differently would
 * mean the arrival order changed the outcome. Both re-read the product
 * from Shopify, so whichever lands first produces the correct state and
 * the other is either deduplicated or found stale.
 */
const productChanged = (payload: any) => ({
  kind: "product_sync" as const,
  shopifyProductId: String(payload.id),
  discriminator: productDiscriminator(payload),
});

http.route({
  path: "/webhooks/shopify/products/create",
  method: "POST",
  handler: shopifyWebhook(productChanged, "products/create"),
});

http.route({
  path: "/webhooks/shopify/products/update",
  method: "POST",
  handler: shopifyWebhook(productChanged, "products/update"),
});

http.route({
  path: "/webhooks/shopify/products/delete",
  method: "POST",
  handler: shopifyWebhook(
    (payload) => ({
      kind: "product_delete" as const,
      shopifyProductId: String(payload.id),
    }),
    "products/delete",
  ),
});

http.route({
  path: "/webhooks/shopify/app/uninstalled",
  method: "POST",
  handler: shopifyWebhook(() => ({ kind: "purge_tenant" as const }), "app/uninstalled"),
});

// Mandatory GDPR topics. Disc stores no customer PII — only catalog
// data — so two are acknowledgements; shop/redact really deletes.
http.route({
  path: "/webhooks/shopify/customers/data_request",
  method: "POST",
  handler: shopifyWebhook(() => ({ kind: "acknowledge" as const }), "customers/data_request"),
});
http.route({
  path: "/webhooks/shopify/customers/redact",
  method: "POST",
  handler: shopifyWebhook(() => ({ kind: "acknowledge" as const }), "customers/redact"),
});
http.route({
  path: "/webhooks/shopify/shop/redact",
  method: "POST",
  handler: shopifyWebhook(() => ({ kind: "purge_tenant" as const }), "shop/redact"),
});

// ---------------------------------------------------------------------
// Merchant control plane — bearer session token required.
//
// This is the boundary the prototype did not have: these actions were
// gated by the public site key, so anyone who read a storefront's HTML
// could trigger them.
// ---------------------------------------------------------------------

async function requireMerchant(ctx: any, request: Request) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return await ctx.runQuery(internal.auth.tenantForToken, { token });
}

allowPreflight("/merchant/overview");
http.route({
  path: "/merchant/overview",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const tenant = await ctx.runQuery(internal.tenants.getById, { tenantId });
    if (!tenant) return json({ detail: "Unauthorized" }, 401);

    // Note what is absent: no access token, no cipher, no public key.
    return json({
      shop_domain: tenant.shopDomain,
      catalog_status: tenant.catalogStatus,
      brand_brain_status: tenant.brandBrainStatus,
      widget_status: tenant.widgetStatus,
      product_count: tenant.productCount,
      last_synced_at: tenant.lastSyncedAt ?? null,
      subscription_status: tenant.subscriptionStatus,
      plan: tenant.plan ?? null,
      catalog_error: tenant.catalogError ?? null,
    });
  }),
});

allowPreflight("/merchant/resync");
http.route({
  path: "/merchant/resync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    // Tightest of the three rules. A full catalog re-read is minutes of
    // work and a whole catalog's worth of embedding spend; nothing
    // legitimate needs it more than a few times an hour.
    const limited = await rateLimited(ctx as MerchantCtx, "resync", String(tenantId));
    if (limited) return limited;

    // Closes audit P2-1. The rate limit permits four resyncs an hour,
    // and before this there was no concurrency guard at all: four clicks
    // meant four concurrent full syncs, four times the Shopify reads and
    // four times the embedding spend. Now they collapse to one job.
    // `explicit`: this route is a person pressing a button, which is the
    // one trigger allowed to re-drive a failed sync (P1.3). The cron
    // sweep calling the same helper without it still deduplicates
    // against a failed job, because an automatic sweep repeating itself
    // is not a new decision by anyone.
    const enqueued = await ctx.runMutation(internal.scheduling.enqueueCatalogSync, {
      tenantId,
      explicit: true,
    });
    return json({
      status: "queued",
      // Truthful about what happened: a merchant clicking twice should
      // not be told two syncs started.
      deduplicated: !enqueued.created,
      // And a merchant retrying a failed sync should be told that is
      // what happened, rather than seeing the same "queued" as a no-op.
      recovered: enqueued.recovered === true,
    });
  }),
});

/**
 * Dashboard sections (spec §70-§75).
 *
 * One GET each, all requiring the merchant token. Registered through a
 * small helper because the auth check is the only thing that must never
 * be forgotten on one of them, and repeating it by hand seven times is
 * how one eventually gets missed.
 */
function merchantRoute(
  path: string,
  handler: (ctx: MerchantCtx, tenantId: unknown, request: Request) => Promise<unknown>,
) {
  allowPreflight(path);
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const tenantId = await requireMerchant(ctx, request);
      if (!tenantId) return json({ detail: "Unauthorized" }, 401);
      return json(await handler(ctx as MerchantCtx, tenantId, request));
    }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MerchantCtx = any;

merchantRoute("/merchant/dashboard", async (ctx, tenantId) => {
  // Composed in one request: the dashboard's landing view needs all of
  // these and a merchant on a slow connection should not watch four
  // spinners resolve independently.
  const [overview, catalog, experience, brand] = await Promise.all([
    ctx.runQuery(internal.merchant.overview, { tenantId }),
    ctx.runQuery(internal.merchant.catalogHealth, { tenantId }),
    ctx.runQuery(internal.merchant.experience, { tenantId }),
    ctx.runQuery(internal.brand.currentBrain, { tenantId }),
  ]);
  return { overview, catalog, experience, brand };
});

merchantRoute("/merchant/catalog", async (ctx, tenantId) =>
  ctx.runQuery(internal.merchant.catalogHealth, { tenantId }),
);

merchantRoute("/merchant/brand", async (ctx, tenantId) =>
  ctx.runQuery(internal.brand.currentBrain, { tenantId }),
);

merchantRoute("/merchant/experience", async (ctx, tenantId) =>
  ctx.runQuery(internal.merchant.experience, { tenantId }),
);

merchantRoute("/merchant/settings", async (ctx, tenantId) =>
  ctx.runQuery(internal.merchant.settings, { tenantId }),
);

merchantRoute("/merchant/analytics", async (ctx, tenantId, request) => {
  const requested = Number(new URL(request.url).searchParams.get("days") ?? "30");
  // Clamped, and the clamped value is echoed back: a dashboard asking
  // for 365 days must not label 90 days of data as a year.
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 30, 1), 90);
  const metrics = await ctx.runQuery(internal.analytics.overview, {
    tenantId,
    since: Date.now() - days * 86400_000,
  });
  return { days, ...metrics };
});

allowPreflight("/merchant/experience");
http.route({
  path: "/merchant/experience",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const saved = await ctx.runMutation(internal.merchant.saveExperience, {
      tenantId,
      config: body,
    });
    return json(saved);
  }),
});

/**
 * Brand correction (spec §138).
 *
 * Creates a new Brand Brain version rather than mutating the current
 * one, so past recommendations continue to resolve against the version
 * that actually produced them.
 */
allowPreflight("/merchant/brand/correct");
http.route({
  path: "/merchant/brand/correct",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    // Only the four correctable facets are forwarded. A merchant cannot
    // set derivedFrom, confidence or the version number — those describe
    // how the brain was produced, and letting them be overwritten would
    // make the trace lie about its own provenance.
    const version = await ctx.runMutation(internal.brand.applyMerchantCorrection, {
      tenantId,
      styleVector: body.styleVector,
      palette: body.palette,
      voice: body.voice,
      summary: typeof body.summary === "string" ? body.summary.slice(0, 400) : undefined,
    });
    return json({ version });
  }),
});

// ---------------------------------------------------------------------
// Look Builder — teaching Disc a brand's own styling.
// ---------------------------------------------------------------------

merchantRoute("/merchant/looks", async (ctx, tenantId, request) => {
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  const [looks, stats] = await Promise.all([
    ctx.runQuery(internal.looks.listLooks, { tenantId, status }),
    ctx.runQuery(internal.looks.lookStats, { tenantId }),
  ]);
  return { looks, stats };
});

/** A direct-to-storage upload URL, so image bytes never pass through here. */
http.route({
  path: "/merchant/looks/upload-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);
    return json({ uploadUrl: await ctx.runMutation(internal.looks.generateUploadUrl, {}) });
  }),
});
allowPreflight("/merchant/looks/upload-url");

/**
 * Analyse an uploaded image.
 *
 * Returns detections and catalog *suggestions*. Nothing is saved and
 * nothing is assigned — the merchant maps the garments to products, and
 * their mapping is what the look is made of. A model that can see "a
 * white shirt" has no idea which of fourteen white shirts it is.
 */
http.route({
  path: "/merchant/looks/analyse",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    if (!body.storageId) return json({ detail: "storageId is required" }, 400);

    // Same rule as a catalog resync: analysing an image is a vision call
    // and nothing legitimate needs to do it in a tight loop.
    const limited = await rateLimited(ctx as MerchantCtx, "resync", String(tenantId));
    if (limited) return limited;

    return json(
      await ctx.runAction(internal.looks.analyseImage, {
        tenantId,
        storageId: body.storageId,
      }),
    );
  }),
});
allowPreflight("/merchant/looks/analyse");

/** Catalog candidates for a garment the merchant is mapping by hand. */
http.route({
  path: "/merchant/looks/suggest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    return json({
      suggestions: await ctx.runAction(internal.looks.suggestMatches, {
        tenantId,
        description: String(body.description ?? "").slice(0, 300),
        slot: body.slot ? String(body.slot) : undefined,
      }),
    });
  }),
});
allowPreflight("/merchant/looks/suggest");

http.route({
  path: "/merchant/looks/save",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const result = await ctx.runMutation(internal.looks.saveLook, {
      tenantId,
      lookId: body.lookId,
      title: String(body.title ?? ""),
      source: body.imageStorageId ? "uploaded" : "merchant_built",
      imageStorageId: body.imageStorageId,
      detected: body.detected,
      items: Array.isArray(body.items) ? body.items : [],
      occasion: body.occasion,
      style: body.style,
      formality: body.formality,
      season: body.season,
      notes: body.notes,
    });
    return json(result, "error" in result ? 400 : 200);
  }),
});
allowPreflight("/merchant/looks/save");

/**
 * Approve, un-approve or archive.
 *
 * The only call that changes what shoppers see — approval is what lets a
 * look into the outfit graph, and it is deliberately not a side effect
 * of saving.
 */
http.route({
  path: "/merchant/looks/status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const status = String(body.status ?? "");
    if (!["draft", "approved", "archived"].includes(status)) {
      return json({ detail: "Unknown status" }, 400);
    }

    const ok = await ctx.runMutation(internal.looks.setLookStatus, {
      tenantId,
      lookId: body.lookId,
      status,
    });
    return json({ ok }, ok ? 200 : 404);
  }),
});
allowPreflight("/merchant/looks/status");

http.route({
  path: "/merchant/looks/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const ok = await ctx.runMutation(internal.looks.deleteLook, {
      tenantId,
      lookId: body.lookId,
    });
    return json({ ok }, ok ? 200 : 404);
  }),
});
allowPreflight("/merchant/looks/delete");

// ---------------------------------------------------------------------
// Billing (spec §76, §133).
// ---------------------------------------------------------------------

merchantRoute("/merchant/billing", async (ctx, tenantId) => {
  const [plans, state, sessionsUsed] = await Promise.all([
    ctx.runQuery(internal.billing.plans, {}),
    ctx.runQuery(internal.billing.billingState, { tenantId }),
    // The one usage number a merchant may see. Sessions — not tokens,
    // not calls, not dollars (§79). It is also the unit plan limits
    // should be written in, because it is the thing they are buying.
    ctx.runQuery(internal.usage.sessionsUsed, {
      tenantId,
      since: Date.now() - 30 * 86400_000,
    }),
  ]);
  return { ...plans, state, sessionsUsed };
});

allowPreflight("/merchant/billing/checkout");
http.route({
  path: "/merchant/billing/checkout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const dashboard = DASHBOARD_URL() || PUBLIC_URL();
    const result = await ctx.runAction(internal.billing.startCheckout, {
      tenantId,
      plan: typeof body.plan === "string" ? body.plan : undefined,
      // Return urls are derived here, not taken from the request body: an
      // attacker-supplied success_url would turn Stripe's redirect into
      // an open redirect carrying the merchant's session.
      successUrl: `${dashboard}/app/billing?checkout=success`,
      cancelUrl: `${dashboard}/app/billing?checkout=cancelled`,
    });
    return json(result, "error" in result ? 400 : 200);
  }),
});

allowPreflight("/merchant/billing/portal");
http.route({
  path: "/merchant/billing/portal",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const dashboard = DASHBOARD_URL() || PUBLIC_URL();
    const result = await ctx.runAction(internal.billing.openPortal, {
      tenantId,
      returnUrl: `${dashboard}/app/billing`,
    });
    return json(result, "error" in result ? 400 : 200);
  }),
});

/**
 * Stripe webhooks.
 *
 * This is the load-bearing half of billing, not the checkout call:
 * `/search` reads the cached subscription status rather than asking
 * Stripe per query, so a cancellation only takes effect when this route
 * records it. Without it a cancelled merchant keeps the product forever
 * and a failed payment is never noticed.
 *
 * Raw body, verify, THEN parse — same order as the Shopify webhooks, and
 * for the same reason.
 */
http.route({
  path: "/webhooks/stripe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const signature = request.headers.get("Stripe-Signature");

    const secret = STRIPE_WEBHOOK_SECRET();
    if (!secret) {
      // Refuse rather than trust. Accepting unverified events would let
      // anyone who can reach this URL grant themselves a subscription.
      return new Response("Webhook secret not configured", { status: 503 });
    }
    if (!(await verifyStripeSignature(raw, signature, secret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return new Response("Malformed body", { status: 400 });
    }

    // The event id is the deduplication identity, on Stripe's own
    // advice. An event without one cannot be deduplicated and is
    // refused rather than applied: unlike a Shopify delivery, a Stripe
    // event that cannot be identified is one that could be replayed to
    // re-grant access, which is the failure this phase exists to close.
    const eventId =
      event && typeof event === "object" && typeof (event as { id?: unknown }).id === "string"
        ? (event as { id: string }).id
        : null;
    if (!eventId) return new Response("Missing event id", { status: 400 });

    // Deduplication, interpretation, tenant resolution, the transition
    // guard and the state change all happen in ONE mutation — see
    // `recordStripeEvent`. A duplicate, an unhandled type, an
    // unresolvable tenant and a refused transition are all 200: Stripe
    // retries non-2xx, and each of these stays the same on redelivery.
    await ctx.runMutation(internal.billing.recordStripeEvent, { eventId, event });
    return new Response("OK", { status: 200 });
  }),
});

/**
 * Unit economics. OPERATOR ONLY (spec §79).
 *
 * Deliberately outside `/merchant/*`: this shows every tenant's spend
 * and margin next to each other, so a merchant session token must never
 * be sufficient — and it is not, because this route does not consult
 * one. It takes a separate operator key, and when that key is unset the
 * route refuses rather than opening.
 *
 * No CORS preflight is registered, so no browser page on any merchant
 * origin can call it.
 */
http.route({
  path: "/admin/economics",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const expected = ADMIN_KEY();
    // Refuse when unconfigured. A missing secret must mean "closed",
    // never "no check to perform".
    if (!expected) {
      return new Response("Economics reporting is not configured", { status: 503 });
    }

    const header = request.headers.get("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!(timingSafeEqual(provided, expected))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "30") || 30, 1), 365);
    const since = Date.now() - days * 86400_000;

    const report = await ctx.runQuery(internal.usage.economics, {
      sinceDay: new Date(since).toISOString().slice(0, 10),
      since,
      limit: Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500),
    });

    return new Response(JSON.stringify({ days, ...report }, null, 2), {
      status: 200,
      // No CORS headers: this is not for a browser on someone's origin.
      headers: { "Content-Type": "application/json" },
    });
  }),
});

allowPreflight("/merchant/preview");
http.route({
  path: "/merchant/preview",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);
    await ctx.runMutation(internal.merchant.setPreviewing, { tenantId });
    return json({ status: "previewing" });
  }),
});

export default http;
