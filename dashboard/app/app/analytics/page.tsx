import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Analytics, Overview } from "@/lib/types";
import { Card, Empty, PageHead, Stat, percent } from "@/components/ui";

/**
 * Analytics (spec §75).
 *
 * "Prefer business metrics. Do not present 'messages processed' as the
 * main value metric." So the funnel comes first — sessions, discovery,
 * clicks, cart — and query volume sits at the bottom under "activity",
 * where it belongs. A merchant is buying commercial outcomes, not AI
 * call volume, and a dashboard that leads with call volume is selling
 * them the wrong thing.
 *
 * AI-assisted revenue is the one §75 metric that is deliberately absent
 * and explained rather than faked: it needs order attribution Disc does
 * not have, and inventing it would be the exact "fake progress" §18
 * forbids.
 */

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = RANGES.includes(requested as (typeof RANGES)[number]) ? requested : 30;

  const [analytics, overview] = await Promise.all([
    apiGet<Analytics>(`/merchant/analytics?days=${days}`),
    apiGet<Overview | null>("/merchant/overview"),
  ]);

  const noData = analytics.sessions === 0 && analytics.queries === 0;

  return (
    <>
      <PageHead title="Analytics">
        What Disc did for your business over the last {analytics.days} days.
      </PageHead>

      <div className="actions" style={{ marginBottom: 18 }}>
        {RANGES.map((range) => (
          <Link
            key={range}
            href={`/app/analytics?days=${range}`}
            className={`btn small ${range === days ? "" : "secondary"}`}
          >
            {range} days
          </Link>
        ))}
      </div>

      {noData && (
        <Empty>
          {overview?.status.widget === "live" ? (
            <>
              No shopper activity yet. Numbers appear here as soon as someone
              uses Disc on your store.
            </>
          ) : (
            <>
              Disc is not live on your storefront, so there is nothing to
              measure. <Link href="/app/experience">Switch it on</Link> when you
              are ready.
            </>
          )}
        </Empty>
      )}

      {!noData && (
        <>
          <h2 className="section">Funnel</h2>
          <div className="grid">
            <Stat
              label="AI sessions"
              value={analytics.sessions}
              hint="Shoppers who used Disc"
            />
            <Stat
              label="Products discovered"
              value={analytics.productsDiscovered}
              hint="Distinct products shown"
            />
            <Stat
              label="Product clicks"
              value={analytics.productClicks}
              hint={percent(analytics.clickThroughRate) ?? "No products shown yet"}
            />
            <Stat
              label="Add to cart"
              value={analytics.addToCart}
              hint={
                analytics.cartRate !== null
                  ? `${percent(analytics.cartRate)} of clicks`
                  : "No clicks yet"
              }
            />
          </div>

          <h2 className="section">Intent</h2>
          <div className="grid">
            <Stat
              label="Outfits generated"
              value={analytics.outfitsGenerated}
              hint="Complete looks Disc put together"
            />
            <Stat label="Outfit saves" value={analytics.outfitSaves} />
            <Stat label="Product saves" value={analytics.productSaves} />
            <Stat
              label="Refinements"
              value={analytics.refinements}
              hint="Shoppers narrowing a result — a good sign, not a failure"
            />
          </div>

          <h2 className="section">Activity</h2>
          <div className="grid">
            <Stat
              label="Queries"
              value={analytics.queries}
              hint="Volume, not value — the funnel above is the number that matters"
            />
            <Stat
              label="Errors"
              value={analytics.errors}
              hint={
                analytics.errors > 0
                  ? "Shoppers who hit a failure"
                  : "Nothing failed"
              }
            />
          </div>
        </>
      )}

      <h2 className="section">Not measured yet</h2>
      <Card>
        <p style={{ marginTop: 0, color: "var(--ink-muted)" }}>
          <strong style={{ color: "var(--ink)" }}>AI-assisted revenue.</strong>{" "}
          Disc can see a shopper add something to their cart, but not whether
          that order completed — that needs order attribution Disc does not
          currently have. Rather than estimate it, this is left blank.
        </p>
        <p style={{ marginBottom: 0, color: "var(--ink-muted)" }}>
          <strong style={{ color: "var(--ink)" }}>Repeat AI usage.</strong>{" "}
          Shopper sessions are deliberately not linked across visits — Disc
          stores no shopper identity at all, so returning shoppers cannot be
          recognised. That is a privacy decision, not an oversight.
        </p>
      </Card>

      {analytics.truncated && (
        <div className="note warn" style={{ marginTop: 14 }}>
          <strong>Partial numbers.</strong> This range exceeded the per-query
          event cap, so the figures above undercount. Choose a shorter range for
          exact numbers.
        </div>
      )}
    </>
  );
}
