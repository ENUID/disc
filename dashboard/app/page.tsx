import { redirect } from "next/navigation";
import { hasSession } from "@/lib/api";

/**
 * Sign in — really "connect your store", because there is no password.
 *
 * Identity comes from Shopify: the merchant is whoever can install the
 * app on that shop. So this page's only job is to send them to `/auth`
 * on the backend, which starts OAuth and eventually redirects back to
 * `/app` with a session token.
 */

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string; shop?: string }>;
}) {
  const params = await searchParams;
  if (!params.expired && (await hasSession())) redirect("/app/overview");

  const apiUrl = process.env.NEXT_PUBLIC_DISC_API_URL ?? "";

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

        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: 28,
            fontWeight: 400,
            letterSpacing: "-0.015em",
            margin: "0 0 10px",
          }}
        >
          Connect your store
        </h1>
        <p style={{ color: "var(--ink-muted)", margin: "0 0 22px" }}>
          Disc reads your catalog, learns your brand, and puts an AI boutique on
          your storefront. Nothing appears to shoppers until you switch it on.
        </p>

        {params.expired && (
          <div className="note warn">
            Your session expired. Connect again to continue — nothing was lost.
          </div>
        )}

        {apiUrl ? (
          <form action={`${apiUrl}/auth`} method="get">
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
        ) : (
          <div className="note bad">
            <strong>Not configured.</strong> Set{" "}
            <code>NEXT_PUBLIC_DISC_API_URL</code> to the Convex deployment&rsquo;s
            HTTP router before deploying this dashboard.
          </div>
        )}

        <p
          style={{
            marginTop: 22,
            fontSize: 12.5,
            color: "var(--ink-faint)",
          }}
        >
          Disc reads your products and nothing else — no customers, no orders.
        </p>
      </div>
    </main>
  );
}
