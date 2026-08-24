import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { randomToken } from "./lib/crypto";
import { billingEnabled } from "./lib/env";
import { storefrontStatus, tenantByPublicKey, tenantByShopDomain } from "./lib/tenancy";

/**
 * Tenant lifecycle.
 *
 * Everything a merchant owns hangs off a tenant document id. The shop
 * domain is an attribute, not the key — the prototype used
 * `shop TEXT PRIMARY KEY` and a merchant changing domains would have
 * orphaned their catalog, embeddings and subscription with no way to
 * reconnect them.
 */

export const getByShopDomain = internalQuery({
  args: { shopDomain: v.string() },
  handler: async (ctx, { shopDomain }) => tenantByShopDomain(ctx, shopDomain),
});

export const getById = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => await ctx.db.get(tenantId),
});

/**
 * What the storefront widget is allowed to know, keyed by the public key.
 *
 * Deliberately minimal: active, catalog state, widget state, brand
 * tokens. No product count, no plan, no subscription vocabulary, no
 * email. The prototype's equivalent returned plan and subscription
 * status to anyone who could read a storefront's HTML.
 *
 * `active` is computed here rather than exposing the raw subscription
 * status, so payment-provider vocabulary never reaches a storefront and
 * the widget has exactly one thing to branch on.
 */
export const storefrontConfig = query({
  args: { publicKey: v.string() },
  handler: async (ctx, { publicKey }) => {
    const tenant = await tenantByPublicKey(ctx, publicKey);
    if (!tenant) return null;
    return storefrontStatus(tenant, billingEnabled());
  },
});

/**
 * Storefront config resolved by shop domain.
 *
 * This is what lets the theme app extension carry no key at all. Shopify
 * gives the theme `shop.permanent_domain`; Disc maps that to the tenant
 * and hands back the public key the widget then uses for everything
 * else. Nothing for a merchant to paste, and nothing they can paste
 * wrong.
 *
 * Safe to serve to anyone: every field here is already visible in the
 * shop's own page source once Disc is live.
 */
export const storefrontConfigByDomain = query({
  args: { shopDomain: v.string() },
  handler: async (ctx, { shopDomain }) => {
    const tenant = await tenantByShopDomain(ctx, shopDomain);
    if (!tenant) return null;
    return storefrontStatus(tenant, billingEnabled());
  },
});

export const createOrUpdateFromInstall = internalMutation({
  args: {
    shopDomain: v.string(),
    shopifyShopId: v.optional(v.string()),
    accessTokenCipher: v.string(),
    scopes: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await tenantByShopDomain(ctx, args.shopDomain);
    const now = Date.now();

    if (existing) {
      // Reinstalling must NOT mint a new public key. The old one may
      // already be live in a theme, and rotating it would silently kill
      // Disc on that storefront.
      await ctx.db.patch(existing._id, {
        accessTokenCipher: args.accessTokenCipher,
        scopes: args.scopes,
        shopifyShopId: args.shopifyShopId ?? existing.shopifyShopId,
        source: "shopify_oauth",
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("tenants", {
      shopDomain: args.shopDomain,
      shopifyShopId: args.shopifyShopId,
      publicKey: randomToken("disc_"),
      accessTokenCipher: args.accessTokenCipher,
      scopes: args.scopes,
      source: "shopify_oauth",
      catalogStatus: "pending",
      brandBrainStatus: "pending",
      widgetStatus: "inactive",
      subscriptionStatus: "none",
      productCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setCatalogStatus = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    catalogStatus: v.union(
      v.literal("pending"),
      v.literal("syncing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    productCount: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      catalogStatus: args.catalogStatus,
      updatedAt: Date.now(),
      catalogError: args.error,
    };
    if (args.productCount !== undefined) patch.productCount = args.productCount;
    if (args.catalogStatus === "ready") patch.lastSyncedAt = Date.now();
    await ctx.db.patch(args.tenantId, patch);
    return null;
  },
});

export const setSubscription = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    subscriptionStatus: v.string(),
    plan: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, ...rest } = args;
    await ctx.db.patch(tenantId, { ...rest, updatedAt: Date.now() });
    return null;
  },
});

/** Tenants whose catalog hasn't been refreshed recently. Drives the resync cron. */
export const dueForResync = internalQuery({
  args: { olderThan: v.number(), limit: v.number() },
  handler: async (ctx, { olderThan, limit }) => {
    const candidates = await ctx.db
      .query("tenants")
      .filter((q) => q.neq(q.field("catalogStatus"), "syncing"))
      .take(limit * 4);
    // `lastSyncedAt` unset is included on purpose: a tenant whose first
    // ingest crashed would otherwise sit stale forever.
    return candidates
      .filter((t) => t.lastSyncedAt === undefined || t.lastSyncedAt < olderThan)
      .slice(0, limit);
  },
});

/**
 * Full tenant teardown, for app/uninstalled and shop/redact.
 *
 * Deletes products, embeddings, sessions and events before the tenant
 * itself, so a failure part-way through never leaves rows pointing at a
 * tenant that no longer exists.
 */
export const purgeTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    // Each table is drained explicitly. A generic loop needs the index
    // name to vary per table, which only type-checks behind casts — and
    // a cast here would hide exactly the mistake that matters: deleting
    // by the wrong index, and so deleting another tenant's rows.
    for (;;) {
      const batch = await ctx.db
        .query("productEmbeddings")
        .withIndex("by_tenant_and_product", (q) => q.eq("tenantId", tenantId))
        .take(500);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
    }

    for (;;) {
      const batch = await ctx.db
        .query("products")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .take(500);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
    }

    for (;;) {
      const batch = await ctx.db
        .query("events")
        .withIndex("by_tenant_and_at", (q) => q.eq("tenantId", tenantId))
        .take(500);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
    }

    for (;;) {
      const batch = await ctx.db
        .query("shopperSessions")
        .withIndex("by_tenant_and_key", (q) => q.eq("tenantId", tenantId))
        .take(500);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
    }

    const sessions = await ctx.db
      .query("merchantSessions")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    await ctx.db.delete(tenantId);
    return null;
  },
});
