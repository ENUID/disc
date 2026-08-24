import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";

/**
 * Tenant resolution — the single chokepoint.
 *
 * The prototype had exactly one place that decided which catalog a
 * request ran against (`_resolve_table`), and that discipline is why it
 * never leaked between merchants. This preserves it: every tenant-scoped
 * read goes through here, and nothing else reads the tenants table by
 * key.
 *
 * The important distinction, which the prototype got wrong:
 *
 *   publicKey       identifies a tenant. Ships in storefront HTML.
 *                   Authorises reading THAT shop's own catalog. Nothing more.
 *
 *   merchant token  authenticates a merchant. Never leaves our control
 *                   plane. Required for anything that costs money,
 *                   changes state, or reveals business data.
 *
 * Treating these as the same value is what let anyone who viewed a
 * storefront's page source trigger an unbounded catalog re-embed or open
 * a Stripe checkout in the merchant's name.
 */

export type Tenant = Doc<"tenants">;

/** Storefront-side resolution. Read-only, and only ever the shop's own data. */
export async function tenantByPublicKey(
  ctx: QueryCtx | MutationCtx,
  publicKey: string | null | undefined,
): Promise<Tenant | null> {
  if (!publicKey) return null;
  return await ctx.db
    .query("tenants")
    .withIndex("by_public_key", (q) => q.eq("publicKey", publicKey))
    .unique();
}

export async function tenantByShopDomain(
  ctx: QueryCtx | MutationCtx,
  shopDomain: string,
): Promise<Tenant | null> {
  return await ctx.db
    .query("tenants")
    .withIndex("by_shop_domain", (q) => q.eq("shopDomain", shopDomain))
    .unique();
}

/**
 * Whether this tenant's Disc should run at all.
 *
 * One definition, used by both the storefront boot check and every
 * retrieval path. If those two ever disagreed, a storefront could hide
 * its own search box for a Disc that then refuses to answer — which is
 * the specific failure `goDormant()` exists to prevent.
 *
 * Billing not configured (no Stripe key) means "active": a deployment
 * that cannot take money must not lock out the merchants it already has.
 */
export function isActive(tenant: Tenant, billingEnabled: boolean): boolean {
  if (!billingEnabled) return true;
  return tenant.subscriptionStatus === "active" || tenant.subscriptionStatus === "trialing";
}

/** What a storefront request is allowed to know. Deliberately small. */
export type StorefrontStatus = {
  active: boolean;
  catalogStatus: Tenant["catalogStatus"];
  widgetStatus: Tenant["widgetStatus"];
  brandTokens: unknown;
};

export function storefrontStatus(
  tenant: Tenant,
  billingEnabled: boolean,
): StorefrontStatus {
  return {
    active: isActive(tenant, billingEnabled),
    catalogStatus: tenant.catalogStatus,
    widgetStatus: tenant.widgetStatus,
    brandTokens: tenant.brandTokens ?? null,
  };
}

/**
 * Assert a document belongs to the tenant that asked for it.
 *
 * Belt and braces: every query here already filters by tenantId through
 * an index, so a mismatch should be unreachable. It is checked anyway
 * because "should be unreachable" is exactly the assumption that
 * produces a cross-tenant leak, and spec §9 requires the guarantee to
 * hold rather than be argued for.
 */
export function assertTenant<T extends { tenantId: Id<"tenants"> }>(
  doc: T | null,
  tenantId: Id<"tenants">,
): T | null {
  if (!doc) return null;
  if (doc.tenantId !== tenantId) return null;
  return doc;
}
