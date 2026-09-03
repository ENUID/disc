import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { randomToken, sha256Hex } from "./lib/crypto";
import { MERCHANT_SESSION_TTL_MS } from "./lib/env";

/**
 * Merchant authentication.
 *
 * This module exists because the prototype conflated two different
 * things. Its `site_key` shipped in every storefront's HTML — correctly
 * documented as "an identifier, not a secret" — and was then also the
 * only thing gating catalog resync, subscription status and Stripe
 * checkout. Anyone who viewed a merchant's page source could read that
 * key and use it. Verified against the running server: both
 * `POST /sites/{key}/resync` and `GET /sites/{key}/status` returned 200
 * given nothing but the public key.
 *
 * So:
 *   publicKey       → identifies a tenant to the widget. Read-only,
 *                     that shop's own catalog, nothing else.
 *   session token   → authenticates a merchant. Required for anything
 *                     that spends money, changes state or reveals
 *                     business data.
 *
 * Only the SHA-256 of a token is stored. A dump of this table does not
 * let anyone act as a merchant.
 */

export const issueSession = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.string(),
  handler: async (ctx, { tenantId }) => {
    const token = randomToken("dsk_");
    await ctx.db.insert("merchantSessions", {
      tenantId,
      tokenHash: await sha256Hex(token),
      expiresAt: Date.now() + MERCHANT_SESSION_TTL_MS,
      createdAt: Date.now(),
    });
    // The only time the raw token exists. It is returned once, to the
    // merchant's browser, and never stored or logged anywhere.
    return token;
  },
});

/**
 * Resolve a bearer token to a tenant, or null.
 *
 * Returns null rather than throwing for every failure mode — expired,
 * unknown, malformed — so callers cannot accidentally distinguish
 * "wrong token" from "no such tenant" and enumerate.
 */
export const tenantForToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.id("tenants"), v.null()),
  handler: async (ctx, { token }): Promise<Id<"tenants"> | null> => {
    if (!token) return null;
    // The raw token is never stored, so look up by its hash.
    const tokenHash = await sha256Hex(token);
    const session = await ctx.db
      .query("merchantSessions")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!session) return null;
    if (session.expiresAt < Date.now()) return null;
    return session.tenantId;
  },
});

export const revokeSessionsForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const sessions = await ctx.db
      .query("merchantSessions")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);
    return null;
  },
});

/** Expired-session sweep. Called by cron; keeps the table from growing forever. */
export const purgeExpiredSessions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("merchantSessions")
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .take(500);
    for (const s of expired) await ctx.db.delete(s._id);
    return expired.length;
  },
});

/**
 * OAuth state sweep.
 *
 * The prototype kept these in a module-level dict that was only ever
 * written to — entries were removed on a successful callback and
 * abandoned installs accumulated for the lifetime of the process. It
 * also broke outright with more than one worker, which is one of the
 * things that pinned that design to a single process.
 */
export const purgeExpiredOAuthStates = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("oauthStates")
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .take(500);
    for (const s of expired) await ctx.db.delete(s._id);
    return expired.length;
  },
});
