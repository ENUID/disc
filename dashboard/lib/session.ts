import { cookies } from "next/headers";

/**
 * The merchant session token.
 *
 * It arrives once, in a query string, from the Shopify OAuth callback
 * (`/auth/callback` redirects to `{DASHBOARD_URL}/app?token=…`). From
 * there it lives in an httpOnly cookie and nowhere else — never in
 * `localStorage`, never in a client component's props, never in a URL
 * after the first hop.
 *
 * That is the whole reason every page in this dashboard is a server
 * component. A token readable by client JavaScript is a token any
 * injected script on the page can take, and this one authorises resync,
 * billing and settings for a merchant's whole store.
 */

export const SESSION_COOKIE = "disc_session";

/** Matches the backend's 14-day `MERCHANT_SESSION_TTL_MS`. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export async function readToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function writeToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Vercel serves HTTPS; a local `next dev` over http would silently
    // drop a Secure cookie, which looks like a broken login.
    secure: process.env.NODE_ENV === "production",
    // Lax rather than Strict: the merchant arrives here by redirect from
    // Shopify and from Stripe Checkout, and Strict would drop the cookie
    // on exactly those navigations.
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearToken(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
