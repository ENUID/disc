import { apiGet } from "@/lib/api";
import type { Experience } from "@/lib/types";
import { Card, Empty, PageHead, WidgetPill } from "@/components/ui";
import { PreviewButton } from "@/components/actions";
import { ExperienceForm } from "./form";

/**
 * AI Boutique controls (spec §74).
 *
 * "Keep controls high-level" — so this is a short list of decisions
 * about behaviour, not a theme editor. §65 is the reason there is no
 * colour picker or CSS box: merchant styling maps onto known design
 * tokens, never free-form CSS, because this config is rendered into a
 * storefront and arbitrary strings there reach every shopper's browser.
 */

export const dynamic = "force-dynamic";

export default async function ExperiencePage() {
  const experience = await apiGet<Experience | null>("/merchant/experience");

  if (!experience) {
    return (
      <>
        <PageHead title="AI Boutique" />
        <Empty>This store is no longer connected.</Empty>
      </>
    );
  }

  const live = experience.widgetStatus === "live";

  return (
    <>
      <PageHead title="AI Boutique">
        How Disc behaves on your storefront. Few controls on purpose — Disc is
        meant to be corrected, not configured.
      </PageHead>

      <Card
        title="Status"
        hint={
          live
            ? "Shoppers can see and use Disc right now."
            : experience.widgetStatus === "previewing"
              ? "Disc runs for you, but shoppers see your normal storefront."
              : "Disc is not shown to anyone."
        }
        aside={<WidgetPill status={experience.widgetStatus} />}
      >
        {!live && (
          <>
            <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
              Installing the app does not put Disc on your storefront — Shopify
              app embeds start switched off, and Disc keeps it that way until you
              decide. Preview first if you want to see it on your own store
              before shoppers do.
            </p>
            <div className="actions">
              <PreviewButton />
            </div>
          </>
        )}

        {live && (
          <div className="note ok" style={{ marginBottom: 0 }}>
            Disc replaces your theme&rsquo;s search box while it is live. Switch
            it off below and your own search returns immediately.
          </div>
        )}
      </Card>

      <h2 className="section">Controls</h2>
      <Card>
        <ExperienceForm config={experience.config} />
      </Card>

      <h2 className="section">Install</h2>
      <Card hint="You should not need this — the theme app extension carries no key and resolves your store automatically.">
        <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
          Your store&rsquo;s public identifier, if you are debugging an install:
        </p>
        <div className="key">
          <code>{experience.publicKey}</code>
        </div>
        <p
          style={{
            color: "var(--ink-faint)",
            fontSize: 12.5,
            marginBottom: 0,
            marginTop: 10,
          }}
        >
          This is not a secret — it ships in your storefront&rsquo;s HTML. It
          identifies your shop to Disc and authorises reading your own catalog,
          nothing more.
        </p>
      </Card>
    </>
  );
}
