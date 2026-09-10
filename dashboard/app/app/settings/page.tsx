import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { Card, Empty, PageHead, SubscriptionPill } from "@/components/ui";

/**
 * Settings (spec §70).
 *
 * Thin on purpose. There is nothing to configure here that is not
 * configured better somewhere else — the experience controls live on the
 * Experience page and the subscription lives in Stripe.
 *
 * What this page is really for is answering "what does Disc have access
 * to, and what happens if I remove it" without the merchant having to
 * ask. Note what cannot appear here at any price: the Shopify access
 * token or its ciphertext. The API does not return them.
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await apiGet<Settings | null>("/merchant/settings");

  if (!settings) {
    return (
      <>
        <PageHead title="Settings" />
        <Empty>This store is no longer connected.</Empty>
      </>
    );
  }

  const scopes = settings.scopes.split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <>
      <PageHead title="Settings" />

      <Card title="Store">
        <dl className="kv">
          <dt>Shopify domain</dt>
          <dd>{settings.shopDomain}</dd>
          <dt>Connected</dt>
          <dd>{new Date(settings.installedAt).toLocaleDateString()}</dd>
          <dt>Contact</dt>
          <dd>{settings.email ?? "—"}</dd>
          <dt>Subscription</dt>
          <dd>
            <SubscriptionPill
              status={settings.subscriptionStatus}
              enabled={settings.billingEnabled}
            />
          </dd>
        </dl>
      </Card>

      <h2 className="section">Access</h2>
      <Card hint="What Disc can read from your Shopify store.">
        <div className="tags" style={{ marginBottom: 12 }}>
          {scopes.length > 0 ? (
            scopes.map((scope) => (
              <span className="tag" key={scope}>
                {scope}
              </span>
            ))
          ) : (
            <span style={{ color: "var(--ink-faint)" }}>None recorded</span>
          )}
        </div>
        <p style={{ color: "var(--ink-muted)", margin: 0 }}>
          Products only. Disc does not request — and cannot read — customers,
          orders, checkouts or inventory locations. A permission never asked for
          is data that cannot leak.
        </p>
      </Card>

      <h2 className="section">Your data</h2>
      <Card>
        <dl className="kv">
          <dt>Shopper sessions</dt>
          <dd>Kept 30 days after last activity</dd>
          <dt>Analytics events</dt>
          <dd>Kept 180 days</dd>
          <dt>Shopper identity</dt>
          <dd>None stored — no accounts, no cookies, no cross-visit linking</dd>
          <dt>Used across stores</dt>
          <dd>Never. Your catalog serves your store and no other.</dd>
        </dl>
        <p style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 0 }}>
          Uninstalling Disc from Shopify deletes everything above — your
          products, what Disc inferred about them, your Brand Brain and your
          analytics — along with the stored access token.
        </p>
      </Card>

      <h2 className="section">Turning Disc off</h2>
      <Card>
        <p style={{ marginTop: 0, color: "var(--ink-muted)" }}>
          To stop Disc appearing to shoppers without losing anything, switch it
          off under <Link href="/app/experience">Experience</Link> — your
          theme&rsquo;s own search box returns immediately and your catalog stays
          indexed.
        </p>
        <p style={{ marginBottom: 0, color: "var(--ink-muted)" }}>
          To remove Disc entirely, uninstall the app from your Shopify admin.
          That deletes your data here; there is nothing to cancel separately
          except your subscription.
        </p>
      </Card>
    </>
  );
}
