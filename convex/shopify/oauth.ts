import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * OAuth CSRF state, persisted rather than held in memory.
 *
 * The prototype kept these in a module-level dict. Two consequences: it
 * grew without bound (entries only removed on a successful callback, so
 * every abandoned install leaked one for the process lifetime), and it
 * made the backend single-process by construction — a second worker
 * would reject callbacks whose state was minted by the first.
 */

export const saveState = internalMutation({
  args: {
    state: v.string(),
    shopDomain: v.string(),
    expiresAt: v.number(),
    // Carries an invitation through the round-trip to Shopify and back.
    // A hash, matching `invitations.tokenHash` — never the raw token.
    invitationTokenHash: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("oauthStates", args);
    return null;
  },
});

/**
 * Consume a state token exactly once.
 *
 * Deleted whether or not it matched, so a token cannot be replayed after
 * a failed attempt. Returns null for every failure mode — missing,
 * expired, wrong shop — so the caller cannot tell them apart. On
 * success, hands back whatever invitation hash rode along with the
 * state, so the callback can pass it on to tenant creation.
 */
export const consumeState = internalMutation({
  args: { state: v.string(), shopDomain: v.string() },
  returns: v.union(v.null(), v.object({ invitationTokenHash: v.optional(v.string()) })),
  handler: async (ctx, { state, shopDomain }) => {
    if (!state) return null;

    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row) return null;

    await ctx.db.delete(row._id);

    if (row.expiresAt < Date.now()) return null;
    if (row.shopDomain !== shopDomain) return null;
    return { invitationTokenHash: row.invitationTokenHash };
  },
});
