import { NextRequest } from "next/server";
import { writeToken } from "@/lib/session";

/**
 * Token handoff.
 *
 * The Shopify OAuth callback finishes by redirecting the merchant to
 * `{DASHBOARD_URL}/app?token=…`. This is the only moment the token is
 * ever in a URL, and it stops here: it goes into an httpOnly cookie and
 * the merchant is redirected to a clean `/app`.
 *
 * The redirect matters as much as the cookie. A token left in the
 * address bar ends up in browser history, in a bookmark, in whatever the
 * merchant pastes into a support chat, and — without the no-referrer
 * header in `next.config.ts` — in the Referer of the first outbound
 * link.
 *
 * Only requests carrying `?token=` are handled here; a plain `/app` visit
 * falls through to `page.tsx` via the rewrite below.
 */

/**
 * A relative Location, not an absolute one.
 *
 * `NextResponse.redirect` needs an absolute URL, which means building
 * one from `request.url` — and that reflects whatever Host the request
 * arrived with. Behind Vercel's proxy that is not necessarily the host
 * the merchant is actually on, and sending them to a different origin
 * loses the cookie that was just set, so they land back on sign-in
 * having apparently failed to log in. A relative Location (valid per RFC
 * 7231) is resolved by the browser against where it already is.
 */
function to(path: string, status: number) {
  return new Response(null, { status, headers: { Location: path } });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  // No token: an ordinary visit to /app. Hand off to the overview.
  if (!token) return to("/app/overview", 307);

  await writeToken(token);

  // 303 rather than 302: the browser must issue a fresh GET without the
  // query string rather than replaying anything.
  return to("/app/overview", 303);
}
