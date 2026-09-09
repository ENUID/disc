import { redirect } from "next/navigation";
import { hasSession } from "@/lib/api";

/**
 * The invite landing page — where an invitation link from the public
 * application funnel (disc-site, a separate app) actually lands.
 *
 * Unauthenticated by necessity: nobody has a Disc session yet at this
 * point, that is the whole reason an invitation exists. The token is
 * checked with a plain, unauthenticated fetch to a route built for
 * exactly that (see `/invitations/status` in http.ts) — this page never
 * calls `apiGet`/`apiPost`, which require a merchant session this
 * visitor does not have.
 *
 * This check is a UX nicety, not the security boundary: it decides which
 * of two static messages to show, nothing more. The token is re-checked,
 * for real, exactly once and atomically, when `/auth/callback` redeems
 * it after Shopify proves the shop domain.
 */

async function checkInvitation(apiUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${apiUrl}/invitations/status?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return false;
    const data = (await response.json()) as { valid?: boolean };
    return data.valid === true;
  } catch {
    return false;
  }
}

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; shop?: string }>;
}) {
  const params = await searchParams;
  const token = params.token ?? "";

  if (await hasSession()) redirect("/app/overview");

  const apiUrl = process.env.NEXT_PUBLIC_DISC_API_URL ?? "";
  const valid = token && apiUrl ? await checkInvitation(apiUrl, token) : false;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
      }}
    >
      <div style={{ width: "min(430px, 100%)" }}>
        <div className="brandmark" style={{ padding: 0, marginBottom: 22 }}>
          <span className="disc" aria-hidden />
          Disc
        </div>

        {valid ? (
          <>
            <h1
              style={{
                fontFamily: "var(--serif)",
                fontSize: 28,
                fontWeight: 400,
                letterSpacing: "-0.015em",
                margin: "0 0 10px",
              }}
            >
              You&rsquo;re invited to Disc
            </h1>
            <p style={{ color: "var(--ink-muted)", margin: "0 0 22px" }}>
              Connect your Shopify store to finish setting up. Nothing appears
              to shoppers until you switch it on.
            </p>

            <form action={`${apiUrl}/auth`} method="get">
              <input type="hidden" name="invite" value={token} />
              <label className="field">
                <span className="lab">Your Shopify domain</span>
                <input
                  type="text"
                  name="shop"
                  required
                  placeholder="your-store.myshopify.com"
                  defaultValue={params.shop ?? ""}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com"
                  title="Use the .myshopify.com domain, not a custom domain"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <span className="help" style={{ marginTop: 6 }}>
                  The <code>.myshopify.com</code> one, even if your shop has a
                  custom domain.
                </span>
              </label>
              <button className="btn" type="submit" style={{ width: "100%" }}>
                Continue to Shopify
              </button>
            </form>
          </>
        ) : (
          <>
            <h1
              style={{
                fontFamily: "var(--serif)",
                fontSize: 28,
                fontWeight: 400,
                letterSpacing: "-0.015em",
                margin: "0 0 10px",
              }}
            >
              Invitation not found
            </h1>
            <div className="note bad">
              This invitation link is invalid or has expired. Reach out to
              whoever invited you for a new one.
            </div>
          </>
        )}
      </div>
    </main>
  );
}
