import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";

/**
 * Invitations — the secure handoff from disc-site into Disc — against
 * the real runtime.
 *
 * The property that matters most: INVITATION != TENANT. A tenant is
 * only ever created by `createOrUpdateFromInstall`, which only runs
 * after Shopify's own OAuth proves a shop domain. Nothing here ever
 * lets an invitation name a shop domain itself — that is what stops an
 * invitation link from being used to impersonate an arbitrary shop.
 */

const modules = import.meta.glob("./**/*.ts");

async function insertInvitation(
  t: ReturnType<typeof convexTest>,
  over: Partial<{
    tokenHash: string;
    referenceCode: string;
    status: "pending" | "redeemed" | "revoked";
    expiresAt: number;
    tenantId: import("./_generated/dataModel").Id<"tenants">;
  }> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("invitations", {
      tokenHash: over.tokenHash ?? "hash-placeholder",
      referenceCode: over.referenceCode ?? "REF-001",
      status: over.status ?? "pending",
      expiresAt: over.expiresAt ?? Date.now() + 60_000,
      createdAt: Date.now(),
      tenantId: over.tenantId,
    });
  });
}

function install(
  t: ReturnType<typeof convexTest>,
  shopDomain: string,
  invitationTokenHash?: string,
) {
  return t.mutation(internal.tenants.createOrUpdateFromInstall, {
    shopDomain,
    accessTokenCipher: "cipher",
    scopes: "read_products",
    invitationTokenHash,
  });
}

async function tenantRow(t: ReturnType<typeof convexTest>, tenantId: unknown) {
  return await t.run(async (ctx) => await ctx.db.get(tenantId as any));
}

describe("invitation lifecycle", () => {
  test("created: mints a pending row and returns the raw token once", async () => {
    const t = convexTest(schema, modules);
    const { token, expiresAt } = await t.mutation(internal.invitations.createInvitation, {
      referenceCode: "REF-100",
      email: "founder@brand.com",
    });

    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const rows = await t.run(async (ctx) => await ctx.db.query("invitations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].referenceCode).toBe("REF-100");
    // The raw token is never stored — only its hash.
    expect(rows[0].tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  test("random: two invitations never share a token", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(internal.invitations.createInvitation, { referenceCode: "A" });
    const b = await t.mutation(internal.invitations.createInvitation, { referenceCode: "B" });
    expect(a.token).not.toBe(b.token);
  });

  test("expires: an expired invitation is not redeemable", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("expired-token");
    await insertInvitation(t, { tokenHash, expiresAt: Date.now() - 1000 });

    const tenantId = await install(t, "late.myshopify.com", tokenHash);
    const tenant = await tenantRow(t, tenantId);
    expect(tenant?.invitationId).toBeUndefined();
    expect(tenant?.setupFeeStatus).toBeUndefined();

    // The invitation itself is untouched — a bad token never has a side effect.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(row?.status).toBe("pending");
  });

  test("single-use + atomic redemption: two installs racing one token attach to only one tenant", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("race-token");
    await insertInvitation(t, { tokenHash });

    const [first, second] = await Promise.all([
      install(t, "racer-one.myshopify.com", tokenHash),
      install(t, "racer-two.myshopify.com", tokenHash),
    ]);

    const [tenantA, tenantB] = await Promise.all([tenantRow(t, first), tenantRow(t, second)]);
    const invited = [
      { id: first, tenant: tenantA },
      { id: second, tenant: tenantB },
    ].filter((entry) => entry.tenant?.invitationId);
    expect(invited).toHaveLength(1);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(row?.status).toBe("redeemed");
    // Attached to exactly the tenant that actually carries the invitation.
    expect(row?.tenantId).toBe(invited[0].id);
  });

  test("reaches setup: a redeemed invitation puts the tenant in the unpaid setup state", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("setup-token");
    await insertInvitation(t, { tokenHash });

    const tenantId = await install(t, "newbrand.myshopify.com", tokenHash);
    const tenant = await tenantRow(t, tenantId);
    expect(tenant?.invitationId).toBeDefined();
    expect(tenant?.setupFeeStatus).toBe("unpaid");

    const overview = await t.query(internal.merchant.overview, { tenantId });
    expect(overview?.status.invitation).toBe("invited");
    expect(overview?.status.setupFee).toBe("unpaid");
    expect(overview?.onboarding.map((stage: { key: string }) => stage.key)).toContain(
      "setup_fee",
    );
  });
});

describe("redemption rejects bad tokens without side effects", () => {
  test("invalid: an unknown token installs an ordinary, ungated tenant", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await install(t, "noinvite.myshopify.com", await sha256Hex("never-issued"));
    const tenant = await tenantRow(t, tenantId);
    expect(tenant?.invitationId).toBeUndefined();
  });

  test("expired: rejected (covered above), and leaves the row pending for audit", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("expired-again");
    await insertInvitation(t, { tokenHash, expiresAt: Date.now() - 5000 });
    await install(t, "expired-case.myshopify.com", tokenHash);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(row?.status).toBe("pending");
    expect(row?.tenantId).toBeUndefined();
  });

  test("reused: a second install with an already-redeemed token cannot attach or move it", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("once-only");
    await insertInvitation(t, { tokenHash });

    const firstTenantId = await install(t, "first-shop.myshopify.com", tokenHash);
    const secondTenantId = await install(t, "attacker-shop.myshopify.com", tokenHash);

    const first = await tenantRow(t, firstTenantId);
    const second = await tenantRow(t, secondTenantId);
    expect(first?.invitationId).toBeDefined();
    expect(second?.invitationId).toBeUndefined();

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    // Still points at the first, legitimate tenant — never moved.
    expect(row?.tenantId).toBe(firstTenantId);
  });

  test("reinstalling an already-invited tenant with a different invite link cannot re-tag it", async () => {
    const t = convexTest(schema, modules);
    const originalHash = await sha256Hex("original");
    const strayHash = await sha256Hex("stray");
    await insertInvitation(t, { tokenHash: originalHash, referenceCode: "ORIGINAL" });
    await insertInvitation(t, { tokenHash: strayHash, referenceCode: "STRAY" });

    const tenantId = await install(t, "established.myshopify.com", originalHash);
    // Reinstall — e.g. the merchant re-runs OAuth with a stray link in the URL.
    await install(t, "established.myshopify.com", strayHash);

    const tenant = await tenantRow(t, tenantId);
    const original = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", originalHash))
        .unique(),
    );
    const stray = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", strayHash))
        .unique(),
    );
    expect(tenant?.invitationId).toBe(original?._id);
    expect(stray?.status).toBe("pending"); // never consumed by someone else's tenant
  });

  test("checkToken never exposes internal ids, reference codes, or email", async () => {
    const t = convexTest(schema, modules);
    const { token } = await t.mutation(internal.invitations.createInvitation, {
      referenceCode: "SECRET-REF",
      email: "founder@brand.com",
    });

    const result = await t.query(api.invitations.checkToken, { token });
    expect(result).toEqual({ valid: true });
    expect(Object.keys(result)).toEqual(["valid"]);
  });

  test("checkToken is read-only: checking a token does not consume it", async () => {
    const t = convexTest(schema, modules);
    const { token } = await t.mutation(internal.invitations.createInvitation, {
      referenceCode: "REF",
    });

    await t.query(api.invitations.checkToken, { token });
    await t.query(api.invitations.checkToken, { token });

    const rows = await t.run(async (ctx) => await ctx.db.query("invitations").collect());
    expect(rows[0].status).toBe("pending");
    expect(rows[0].tenantId).toBeUndefined();

    // Applicant-cannot-mutate-invitation: checkToken is the only public
    // surface, and it is a `query` — Convex refuses a query that writes,
    // so there is no path from the public API to invitation state at all.
    const tenantId = await install(t, "still-works.myshopify.com", rows[0].tokenHash);
    const tenant = await tenantRow(t, tenantId);
    expect(tenant?.invitationId).toBeDefined();
  });
});

describe("access control: INVITED != PAID != ACTIVE", () => {
  test("invited-can-enter-setup: an unpaid invited tenant's dashboard stays reachable", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("setup-access");
    await insertInvitation(t, { tokenHash });
    const tenantId = await install(t, "invited-unpaid.myshopify.com", tokenHash);

    // Dashboard reads are gated by session token only (requireMerchant),
    // never by isActive — so setup/onboarding stays reachable regardless
    // of payment state.
    const overview = await t.query(internal.merchant.overview, { tenantId });
    expect(overview).not.toBeNull();
    const settings = await t.query(internal.merchant.settings, { tenantId });
    expect(settings).not.toBeNull();
  });

  test("unpaid-cannot-activate: an invited-unpaid tenant is never active, even with a live subscription", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "test_key";
    try {
      const t = convexTest(schema, modules);
      const tokenHash = await sha256Hex("unpaid-gate");
      await insertInvitation(t, { tokenHash });
      const tenantId = await install(t, "unpaid.myshopify.com", tokenHash);
      await t.run(async (ctx) =>
        ctx.db.patch(tenantId, { subscriptionStatus: "active" }),
      );

      const tenant = await tenantRow(t, tenantId);
      const config = await t.query(api.tenants.storefrontConfig, {
        publicKey: tenant!.publicKey,
      });
      expect(config?.active).toBe(false);
    } finally {
      delete process.env.DODO_PAYMENTS_API_KEY;
    }
  });

  test("paid-can-activate: once the setup fee is paid, the tenant can reach active", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "test_key";
    try {
      const t = convexTest(schema, modules);
      const tokenHash = await sha256Hex("paid-gate");
      await insertInvitation(t, { tokenHash });
      const tenantId = await install(t, "paid.myshopify.com", tokenHash);
      await t.run(async (ctx) =>
        ctx.db.patch(tenantId, { subscriptionStatus: "active", setupFeeStatus: "paid" }),
      );

      const tenant = await tenantRow(t, tenantId);
      const config = await t.query(api.tenants.storefrontConfig, {
        publicKey: tenant!.publicKey,
      });
      expect(config?.active).toBe(true);
    } finally {
      delete process.env.DODO_PAYMENTS_API_KEY;
    }
  });

  test("existing-tenants-functional: a tenant with no invitation is unaffected by setup-fee enforcement", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "test_key";
    try {
      const t = convexTest(schema, modules);
      // No invitationTokenHash at all — the ordinary, pre-existing path.
      const tenantId = await install(t, "grandfathered.myshopify.com");
      await t.run(async (ctx) => ctx.db.patch(tenantId, { subscriptionStatus: "active" }));

      const tenant = await tenantRow(t, tenantId);
      expect(tenant?.invitationId).toBeUndefined();
      const config = await t.query(api.tenants.storefrontConfig, {
        publicKey: tenant!.publicKey,
      });
      // Active on subscription status alone — never asked for a fee it
      // was never invited to pay.
      expect(config?.active).toBe(true);

      const overview = await t.query(internal.merchant.overview, { tenantId });
      expect(overview?.status.setupFee).toBe("not_required");
      expect(
        overview?.onboarding.map((stage: { key: string }) => stage.key),
      ).not.toContain("setup_fee");
    } finally {
      delete process.env.DODO_PAYMENTS_API_KEY;
    }
  });

  test("setup fee unconfigured fails open, exactly like billingEnabled()", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await sha256Hex("unconfigured");
    await insertInvitation(t, { tokenHash });
    const tenantId = await install(t, "unconfigured.myshopify.com", tokenHash);

    // DODO_PAYMENTS_API_KEY is not set in this test's environment.
    const tenant = await tenantRow(t, tenantId);
    const config = await t.query(api.tenants.storefrontConfig, {
      publicKey: tenant!.publicKey,
    });
    expect(config?.active).toBe(true);
  });
});
