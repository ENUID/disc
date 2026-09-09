import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { randomToken, sha256Hex } from "./lib/crypto";
import { INVITATION_TTL_MS } from "./lib/env";

/**
 * Invitations — the secure handoff from the public application funnel
 * (disc-site, a separate application) into Disc itself.
 *
 * Mirrors `auth.ts`'s session-token discipline exactly: the raw token
 * exists only for the instant it is minted, is returned to the caller
 * once, and is never stored. Everything held and looked up afterwards is
 * its SHA-256 hash, so a dump of this table cannot be redeemed by anyone
 * who reads it.
 *
 * `createInvitation` is the intended integration point for disc-site —
 * not called from here, since this repo does not talk to disc-site
 * directly, but reachable over HTTP at `POST /admin/invitations`
 * (see http.ts) using the same operator credential as `/admin/economics`.
 * That is the secure channel: a shared server-side secret over HTTPS,
 * never a browser, and disc-site sends only `referenceCode`/`email` —
 * never its own internal application id.
 */

export const createInvitation = internalMutation({
  args: {
    referenceCode: v.string(),
    email: v.optional(v.string()),
  },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const token = randomToken("inv_");
    const expiresAt = Date.now() + INVITATION_TTL_MS;
    await ctx.db.insert("invitations", {
      tokenHash: await sha256Hex(token),
      referenceCode: args.referenceCode,
      email: args.email,
      status: "pending",
      expiresAt,
      createdAt: Date.now(),
    });
    // The only time the raw token exists — handed back once, to become
    // the link disc-site emails the applicant.
    return { token, expiresAt };
  },
});

/**
 * Whether a token is currently redeemable. Public and unauthenticated by
 * design — the token itself is the credential, exactly like a
 * password-reset link, and it is 32 bytes of CSPRNG so guessing one is
 * not a practical concern.
 *
 * Deliberately returns nothing beyond a boolean: no reference code, no
 * email, no internal id. A dashboard page uses this to decide which of
 * two static messages to show before a merchant starts Shopify OAuth —
 * it is a UX nicety, not part of the security boundary, which is why
 * `createOrUpdateFromInstall` independently re-validates the same token
 * rather than trusting that this was called first.
 */
export const checkToken = query({
  args: { token: v.string() },
  returns: v.object({ valid: v.boolean() }),
  handler: async (ctx, { token }) => {
    if (!token) return { valid: false };
    const tokenHash = await sha256Hex(token);
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    const valid =
      invitation !== null &&
      invitation.status === "pending" &&
      invitation.expiresAt > Date.now();
    return { valid };
  },
});

/** Expired, never-redeemed invitations. Redeemed ones are kept — they are the audit trail of who is attached to which tenant. */
export const purgeExpiredInvitations = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("invitations")
      .filter((q) =>
        q.and(q.eq(q.field("status"), "pending"), q.lt(q.field("expiresAt"), now)),
      )
      .take(500);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});
