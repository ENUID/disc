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
 * a failed attempt. Returns false for every failure mode — missing,
 * expired, wrong shop — so the caller cannot tell them apart.
 */
export const consumeState = internalMutation({
  args: { state: v.string(), shopDomain: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { state, shopDomain }) => {
    if (!state) return false;

    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row) return false;

    await ctx.db.delete(row._id);

    if (row.expiresAt < Date.now()) return false;
    if (row.shopDomain !== shopDomain) return false;
    return true;
  },
});
