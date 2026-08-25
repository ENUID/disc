/**
 * Configuration. Every secret is read here and nowhere else, so there is
 * one place to audit for "does this value ever reach a client".
 *
 * Convex environment variables are set with `npx convex env set NAME value`
 * (or in the dashboard); they are never bundled into client code.
 */

export function env(name: string): string {
  return process.env[name] ?? "";
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run: npx convex env set ${name} <value>`,
    );
  }
  return value;
}

/**
 * Whether billing is enforced.
 *
 * False without a Stripe key, which is what keeps a development
 * deployment — and the test suite — from being locked out by a
 * subscription check it cannot satisfy. A deployment that cannot take
 * money must not refuse service to the merchants it already has.
 */
export function billingEnabled(): boolean {
  return Boolean(env("STRIPE_SECRET_KEY"));
}

export const SHOPIFY_API_KEY = () => env("SHOPIFY_API_KEY");
export const SHOPIFY_API_SECRET = () => env("SHOPIFY_API_SECRET");
export const SHOPIFY_SCOPES = () => env("SHOPIFY_SCOPES") || "read_products";

/** Public origin of this Convex deployment's HTTP router. */
export const PUBLIC_URL = () => env("PUBLIC_URL").replace(/\/$/, "");

/** Where the merchant dashboard lives (Vercel). */
export const DASHBOARD_URL = () => env("DASHBOARD_URL").replace(/\/$/, "");

export const ENCRYPTION_KEY = () => env("DISC_ENCRYPTION_KEY");

/**
 * Stripe webhook signing secret.
 *
 * Separate from the API key on purpose: without this the webhook route
 * refuses every event rather than trusting unverified ones, because an
 * unverified event is a way for anyone who can reach the URL to grant
 * themselves a subscription.
 */
export const STRIPE_WEBHOOK_SECRET = () => env("STRIPE_WEBHOOK_SECRET");

/**
 * Operator key for the internal economics report.
 *
 * Deliberately a separate credential from anything a merchant holds:
 * that report shows every tenant's spend and margin side by side, so a
 * merchant token must never reach it. Unset means the route is disabled
 * outright rather than open — the failure mode for a missing secret is
 * "no access", never "no check".
 */
export const ADMIN_KEY = () => env("DISC_ADMIN_KEY");

/**
 * Shopify Admin API version.
 *
 * Pinned deliberately: Shopify ships quarterly versions and an unpinned
 * client silently changes behaviour under you. Bump this on purpose,
 * after reading that version's changelog.
 */
export const SHOPIFY_API_VERSION = "2025-01";

/** Catalog resync cadence — how stale a merchant's index can get. */
export const RESYNC_INTERVAL_HOURS = Number(env("DISC_RESYNC_HOURS") || "6");

/** Merchant session lifetime. */
export const MERCHANT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/** OAuth state lifetime. Short — an install completes in seconds. */
export const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

/**
 * How long shopper events are kept (spec §92 requires a documented
 * retention period). Recommendation traces are deliberately NOT aged out
 * on this schedule — they are what makes a past recommendation
 * explainable, and they contain no shopper identity.
 */
export const EVENT_RETENTION_DAYS = Number(env("DISC_EVENT_RETENTION_DAYS") || "180");

/**
 * How long an idle shopper session is kept (spec §92).
 *
 * Much shorter than event retention, because this is the one record that
 * holds what a shopper said they wanted rather than what they did. A
 * session that outlives the shopping trip is data held for no reason.
 */
export const SHOPPER_SESSION_RETENTION_DAYS = Number(
  env("DISC_SESSION_RETENTION_DAYS") || "30",
);

/**
 * How long model-usage rollups are kept.
 *
 * Much longer than events, and deliberately so: this is the record that
 * justifies a price, and answering "what did this cost us last year" is
 * worth the storage. One row per tenant per day per operation per model
 * is small enough that generosity here costs nothing.
 *
 * Holds no shopper data — it is token counts and dollar amounts — so it
 * is not subject to the retention argument that governs `events`.
 */
export const USAGE_RETENTION_DAYS = Number(env("DISC_USAGE_RETENTION_DAYS") || "730");
