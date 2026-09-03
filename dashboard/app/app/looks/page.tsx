import { apiGet } from "@/lib/api";
import type { LookStats, LookSummary } from "@/lib/looks-types";
import { Card, Empty, PageHead, Pill, Stat } from "@/components/ui";
import { LookBuilder } from "./builder";
import { LookCard } from "./look-card";

/**
 * Looks — where a merchant teaches Disc their own styling.
 *
 * The framing on this page matters as much as the controls. A merchant
 * arriving here should understand two things immediately: that Disc
 * already works without any of this, and that what they add here is
 * evidence Disc cannot get anywhere else. If it reads as a chore list —
 * "tag your 500 outfits" — they will not do it, and they are right not
 * to.
 */

export const dynamic = "force-dynamic";

export default async function LooksPage() {
  const { looks, stats } = await apiGet<{ looks: LookSummary[]; stats: LookStats }>(
    "/merchant/looks",
  );

  const drafts = looks.filter((l) => l.status === "draft");
  const approved = looks.filter((l) => l.status === "approved");
  const archived = looks.filter((l) => l.status === "archived");

  return (
    <>
      <PageHead title="Looks">
        Upload a campaign image and tell Disc which of your products are in it.
        Disc learns which pieces you put together, and styles shoppers the way
        you would.
      </PageHead>

      <div className="note">
        <strong>Optional, and Disc works without it.</strong> Every
        recommendation already uses your catalog and your Brand Brain. Looks add
        something Disc cannot infer on its own — that <em>you</em> chose these
        pieces together — and a handful of real campaign images is worth more
        than a hundred hurried ones.
      </div>

      <h2 className="section">Your library</h2>
      <div className="grid">
        <Stat label="Approved looks" value={stats.approved} hint="In use when styling shoppers" />
        <Stat label="Drafts" value={stats.draft} hint="Not yet influencing anything" />
        <Stat
          label="Relationships learned"
          value={stats.relationships}
          hint="Product pairs your looks have taught Disc"
        />
      </div>

      <h2 className="section">Add a look</h2>
      <Card>
        <LookBuilder />
      </Card>

      {drafts.length > 0 && (
        <>
          <h2 className="section">
            Drafts <Pill tone="idle">{drafts.length}</Pill>
          </h2>
          <p style={{ color: "var(--ink-muted)", marginTop: 0, fontSize: 13 }}>
            Not in use yet. Approve one and Disc starts styling with it.
          </p>
          <div className="grid-2">
            {drafts.map((look) => (
              <LookCard key={look.id} look={look} />
            ))}
          </div>
        </>
      )}

      <h2 className="section">
        Approved {approved.length > 0 && <Pill tone="ok">{approved.length}</Pill>}
      </h2>
      {approved.length === 0 ? (
        <Empty>
          Nothing approved yet. Disc is styling from your catalog and Brand Brain
          alone, which works — this is how you make it style like you.
        </Empty>
      ) : (
        <div className="grid-2">
          {approved.map((look) => (
            <LookCard key={look.id} look={look} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <>
          <h2 className="section">Archived</h2>
          <p style={{ color: "var(--ink-muted)", marginTop: 0, fontSize: 13 }}>
            Kept, but no longer used when styling shoppers.
          </p>
          <div className="grid-2">
            {archived.map((look) => (
              <LookCard key={look.id} look={look} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
