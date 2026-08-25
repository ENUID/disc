import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Analytics, DashboardBundle } from "@/lib/types";
import {
  BrainPill,
  Card,
  CatalogPill,
  Empty,
  PageHead,
  Stages,
  Stat,
  WidgetPill,
  relativeTime,
} from "@/components/ui";
import { PreviewButton } from "@/components/actions";

/**
 * Overview (spec §71).
 *
 * The three status lines, the onboarding stages, and the three metrics
 * §71 asks for by name: AI-assisted discovery, product clicks, and
 * add-to-cart. Note what is not here — no "messages processed", no token
 * counts. §75 is explicit that AI call volume is not the value metric,
 * and §79 that token pricing is never shown to a merchant.
 *
 * The banner logic at the top is the most important thing on this page.
 * A merchant whose Disc is installed but switched off sees a working
 * dashboard full of zeroes and concludes the product does not work. So
 * the first thing this page does is say which of those it is.
 */

export const dynamic = "force-dynamic";

/**
 * Why Disc has stopped, in the merchant's language.
 *
 * Stripe's status vocabulary is precise and completely opaque to
 * someone who does not work with Stripe — "past_due" in an admin banner
 * tells a merchant nothing about what to do next. This is the same
 * translation `SubscriptionPill` makes; interpolating the raw status
 * here would undo it.
 */
function subscriptionReason(status: string): string {
  switch (status) {
    case "past_due":
      return "Your last payment failed.";
    case "unpaid":
      return "Your subscription has unpaid invoices.";
    case "canceled":
      return "Your subscription was cancelled.";
    case "pending":
      return "Your checkout has not completed yet.";
    case "none":
      return "There is no subscription on this store yet.";
    default:
      return "Your subscription is not active.";
  }
}

export default async function OverviewPage() {
  const [bundle, analytics] = await Promise.all([
    apiGet<DashboardBundle>("/merchant/dashboard"),
    apiGet<Analytics>("/merchant/analytics?days=30"),
  ]);

  const overview = bundle.overview;
  if (!overview) {
    return (
      <>
        <PageHead title="Overview" />
        <Empty>This store is no longer connected. Reinstall Disc to continue.</Empty>
      </>
    );
  }

  const { status } = overview;
  const catalogEmpty = overview.productCount === 0 && status.catalog === "ready";

  return (
    <>
      <PageHead title="Overview">
        How Disc is doing on {overview.shopDomain}.
      </PageHead>

      {status.catalog === "error" && (
        <div className="note bad">
          <strong>Catalog sync failed.</strong>{" "}
          {overview.catalogError ?? "Disc could not read your products."}{" "}
          <Link href="/app/catalog">Open Catalog</Link> to retry.
        </div>
      )}

      {!status.active && (
        <div className="note warn">
          <strong>Disc is not serving shoppers.</strong>{" "}
          {subscriptionReason(status.subscription)}{" "}
          <Link href="/app/billing">Open Billing</Link> to restore it — your
          storefront keeps its own search in the meantime.
        </div>
      )}

      {/* Only when they are actually entitled — telling a lapsed merchant
          to switch Disc on would send them to a control that cannot help. */}
      {status.active && overview.needsActivation && (
        <div className="note warn">
          <strong>Disc is not on your storefront yet.</strong> Installing the app
          does not switch it on — Shopify app embeds start disabled.{" "}
          <Link href="/app/experience">Open AI Boutique</Link> to enable it.
        </div>
      )}

      {catalogEmpty && (
        <div className="note warn">
          <strong>No products found.</strong> Disc read your catalog but it came
          back empty. Check that products are published to the sales channel Disc
          can see.
        </div>
      )}

      <h2 className="section">Status</h2>
      <div className="grid">
        <div className="stat">
          <span className="label">Catalog</span>
          <div style={{ marginTop: 4 }}>
            <CatalogPill status={status.catalog} />
          </div>
          <span className="hint">
            {overview.productCount.toLocaleString()} products ·{" "}
            {relativeTime(overview.lastSyncedAt)}
          </span>
        </div>

        <div className="stat">
          <span className="label">Brand Brain</span>
          <div style={{ marginTop: 4 }}>
            <BrainPill status={status.brandBrain} />
          </div>
          <span className="hint">
            {bundle.brand
              ? `Version ${bundle.brand.version}`
              : "Built once your catalog is understood"}
          </span>
        </div>

        <div className="stat">
          <span className="label">Widget</span>
          <div style={{ marginTop: 4 }}>
            <WidgetPill status={status.widget} />
          </div>
          <span className="hint">
            {status.widget === "live"
              ? "Shoppers can see Disc"
              : status.widget === "previewing"
                ? "Only you can see Disc"
                : "Not shown to anyone"}
          </span>
        </div>
      </div>

      <h2 className="section">Last 30 days</h2>
      <div className="grid">
        <Stat
          label="AI-assisted discovery"
          value={analytics.productsDiscovered}
          hint="Distinct products shoppers saw through Disc"
        />
        <Stat
          label="AI-assisted product clicks"
          value={analytics.productClicks}
          hint={analytics.clickThroughRate !== null
            ? `${Math.round(analytics.clickThroughRate * 100)}% of products shown`
            : "No products shown yet"}
        />
        <Stat
          label="AI-assisted add-to-cart"
          value={analytics.addToCart}
          hint={analytics.cartRate !== null
            ? `${Math.round(analytics.cartRate * 100)}% of clicks`
            : "No clicks yet"}
        />
      </div>

      {analytics.sessions === 0 && status.widget === "live" && (
        <p style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: 12 }}>
          No shopper sessions recorded yet. Numbers appear here as soon as
          someone uses Disc on your store.
        </p>
      )}

      <h2 className="section">Setup</h2>
      <Card>
        <Stages stages={overview.onboarding} />
        {overview.needsActivation && status.brandBrain === "ready" && status.active && (
          <div className="actions" style={{ marginTop: 14 }}>
            <PreviewButton />
            <Link className="btn" href="/app/experience">
              Go live
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
