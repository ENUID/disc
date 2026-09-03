import { apiGet } from "@/lib/api";
import type { CatalogHealth, Overview } from "@/lib/types";
import {
  Card,
  CatalogPill,
  Empty,
  Meter,
  PageHead,
  Stat,
  relativeTime,
} from "@/components/ui";
import { ResyncButton } from "@/components/actions";

/**
 * Catalog health (spec §73).
 *
 * "Indexed" and "enriched" are shown separately on purpose. A product
 * can be searchable while Disc knows nothing about what it is — that
 * product still turns up in results, but it scores every compatibility
 * dimension neutral, so it makes weak outfits and looks like a bad
 * recommendation rather than a missing one. Collapsing the two numbers
 * into one "ready" figure would hide exactly the problem a merchant
 * needs to see.
 */

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const [catalog, overview] = await Promise.all([
    apiGet<CatalogHealth>("/merchant/catalog"),
    apiGet<Overview | null>("/merchant/overview"),
  ]);

  if (!overview) {
    return (
      <>
        <PageHead title="Catalog" />
        <Empty>This store is no longer connected.</Empty>
      </>
    );
  }

  const problems =
    catalog.notEnriched + catalog.lowConfidence + catalog.missingImages;

  return (
    <>
      <PageHead title="Catalog">
        What Disc has read from your store, and how much of it Disc actually
        understands.
      </PageHead>

      {overview.status.catalog === "error" && (
        <div className="note bad">
          <strong>Last sync failed.</strong>{" "}
          {overview.catalogError ?? "Disc could not read your products."}
        </div>
      )}

      {overview.status.catalog === "syncing" && (
        <div className="note">
          <strong>Syncing now.</strong> The numbers below are from the last
          completed sync and will change when this one finishes.
        </div>
      )}

      <Card
        title="Sync"
        hint={`Last completed ${relativeTime(overview.lastSyncedAt).toLowerCase()}`}
        aside={<CatalogPill status={overview.status.catalog} />}
      >
        <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
          Disc re-reads your catalog automatically every few hours, and product
          changes arrive by webhook. Resync only if something looks out of date.
        </p>
        <div className="actions">
          <ResyncButton />
        </div>
      </Card>

      <h2 className="section">Coverage</h2>
      <Card>
        <Meter label="Indexed for search" count={catalog.indexed} total={catalog.total} />
        <Meter
          label="Understood by Disc"
          count={catalog.enriched}
          total={catalog.total}
        />
        <p style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 0 }}>
          Indexed products can be found. Understood products can also be styled,
          matched and built into outfits — Disc knows their fit, formality,
          material and colour.
        </p>
      </Card>

      <h2 className="section">Needs attention</h2>
      <div className="grid">
        <Stat
          label="Not yet understood"
          value={catalog.notEnriched}
          hint={
            catalog.notEnriched > 0
              ? "Searchable, but score neutral in outfits"
              : "Everything is enriched"
          }
        />
        <Stat
          label="Low confidence"
          value={catalog.lowConfidence}
          hint="Under half their attributes established"
        />
        <Stat
          label="Missing images"
          value={catalog.missingImages}
          hint="Disc cannot infer colour or pattern"
        />
        <Stat
          label="Rejected attributes"
          value={catalog.rejectedFields}
          hint="Model returned values outside the vocabulary"
        />
        <Stat
          label="Sold out"
          value={catalog.unavailable}
          hint="Filtered out of results entirely"
        />
        <Stat label="Total products" value={catalog.total} />
      </div>

      {catalog.total > 0 && problems === 0 && (
        <div className="note ok" style={{ marginTop: 14 }}>
          Disc understands your whole catalog.
        </div>
      )}

      {catalog.missingImages > 0 && (
        <div className="note" style={{ marginTop: 14 }}>
          <strong>Images matter more than descriptions.</strong> Disc reads
          colour, pattern and material off product photography — a product
          without an image is one Disc has to guess about.
        </div>
      )}
    </>
  );
}
