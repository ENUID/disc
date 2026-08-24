import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import {
  randomToken,
  verifyShopifyOAuthHmac,
  verifyShopifyWebhookHmac,
} from "./lib/crypto";
import { encryptSecret } from "./lib/crypto";
import {
  DASHBOARD_URL,
  ENCRYPTION_KEY,
  OAUTH_STATE_TTL_MS,
  PUBLIC_URL,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
} from "./lib/env";
import {
  exchangeCodeUrl,
  isValidShopDomain,
  registerWebhooks,
} from "./shopify/admin";

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

// ---------------------------------------------------------------------
// Storefront API — public key only, read-only, that shop's own catalog.
// ---------------------------------------------------------------------

http.route({ path: "/search", method: "OPTIONS", handler: preflight });
http.route({
  path: "/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    const publicKey = body.site_key ?? body.publicKey ?? "";
    if (!publicKey) return json({ query: "", results: [], status: "unknown" });

    const result = await ctx.runAction(api.search.search, {
      publicKey,
      query: String(body.query ?? ""),
      limit: body.limit,
    });
    return json(result);
  }),
});

http.route({ path: "/product", method: "OPTIONS", handler: preflight });
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
http.route({ path: "/outfit", method: "OPTIONS", handler: preflight });
http.route({
  path: "/outfit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    const publicKey = body.site_key ?? body.publicKey ?? "";
    if (!publicKey) return json({ outfits: [], status: "unknown" });

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
 * Boot check. The widget calls this before hiding anything, so a lapsed
 * or unknown tenant never costs a storefront its own search box.
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
http.route({ path: "/events", method: "OPTIONS", handler: preflight });
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

    await ctx.scheduler.runAfter(0, internal.ingest.syncCatalog, { tenantId });

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

function shopifyWebhook(
  handler: (ctx: any, shopDomain: string, payload: any) => Promise<void>,
) {
  return httpAction(async (ctx, request) => {
    const verified = await verifiedWebhook(request);
    if (!verified) return new Response("Unauthorized", { status: 401 });

    const tenant = await ctx.runQuery(internal.tenants.getByShopDomain, {
      shopDomain: verified.shopDomain,
    });
    // 200 on an unknown shop: Shopify retries non-2xx, and retrying a
    // webhook for a tenant we do not have will never succeed.
    if (!tenant) return new Response("OK", { status: 200 });

    await handler(ctx, tenant._id, verified.payload);
    // Acknowledge fast (spec §91); real work is scheduled, not inline.
    return new Response("OK", { status: 200 });
  });
}

http.route({
  path: "/webhooks/shopify/products/create",
  method: "POST",
  handler: shopifyWebhook(async (ctx, tenantId, payload) => {
    await ctx.scheduler.runAfter(0, internal.ingest.syncSingleProduct, {
      tenantId,
      shopifyProductId: String(payload.id),
    });
  }),
});

http.route({
  path: "/webhooks/shopify/products/update",
  method: "POST",
  handler: shopifyWebhook(async (ctx, tenantId, payload) => {
    await ctx.scheduler.runAfter(0, internal.ingest.syncSingleProduct, {
      tenantId,
      shopifyProductId: String(payload.id),
    });
  }),
});

http.route({
  path: "/webhooks/shopify/products/delete",
  method: "POST",
  handler: shopifyWebhook(async (ctx, tenantId, payload) => {
    await ctx.runMutation(internal.products.deleteByShopifyId, {
      tenantId,
      shopifyProductId: String(payload.id),
    });
  }),
});

http.route({
  path: "/webhooks/shopify/app/uninstalled",
  method: "POST",
  handler: shopifyWebhook(async (ctx, tenantId) => {
    await ctx.runMutation(internal.tenants.purgeTenant, { tenantId });
  }),
});

// Mandatory GDPR topics. Disc stores no customer PII — only catalog
// data — so two are acknowledgements; shop/redact really deletes.
http.route({
  path: "/webhooks/shopify/customers/data_request",
  method: "POST",
  handler: shopifyWebhook(async () => {}),
});
http.route({
  path: "/webhooks/shopify/customers/redact",
  method: "POST",
  handler: shopifyWebhook(async () => {}),
});
http.route({
  path: "/webhooks/shopify/shop/redact",
  method: "POST",
  handler: shopifyWebhook(async (ctx, tenantId) => {
    await ctx.runMutation(internal.tenants.purgeTenant, { tenantId });
  }),
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

http.route({ path: "/merchant/overview", method: "OPTIONS", handler: preflight });
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

http.route({ path: "/merchant/analytics", method: "OPTIONS", handler: preflight });
http.route({
  path: "/merchant/analytics",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    const url = new URL(request.url);
    const days = Math.min(Number(url.searchParams.get("days") ?? "30") || 30, 365);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const metrics = await ctx.runQuery(internal.analytics.overview, { tenantId, since });
    return json({ days, ...metrics });
  }),
});

http.route({ path: "/merchant/resync", method: "OPTIONS", handler: preflight });
http.route({
  path: "/merchant/resync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const tenantId = await requireMerchant(ctx, request);
    if (!tenantId) return json({ detail: "Unauthorized" }, 401);

    await ctx.scheduler.runAfter(0, internal.ingest.syncCatalog, { tenantId });
    return json({ status: "queued" });
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
  http.route({ path, method: "OPTIONS", handler: preflight });
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
  const days = Number(new URL(request.url).searchParams.get("days") ?? "30");
  return await ctx.runQuery(internal.analytics.overview, {
    tenantId,
    since: Date.now() - Math.min(Math.max(days, 1), 90) * 86400_000,
  });
});

http.route({ path: "/merchant/experience", method: "OPTIONS", handler: preflight });
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
http.route({ path: "/merchant/brand/correct", method: "OPTIONS", handler: preflight });
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

http.route({ path: "/merchant/preview", method: "OPTIONS", handler: preflight });
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
