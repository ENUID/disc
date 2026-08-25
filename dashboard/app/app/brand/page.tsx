import { apiGet } from "@/lib/api";
import type { BrandBrain, Overview } from "@/lib/types";
import { BrainPill, Card, Empty, PageHead, Pill } from "@/components/ui";
import { BrandCorrectionForm } from "./form";

/**
 * Brand Brain (spec §72).
 *
 * Everything here is derived from the merchant's own catalog, which is
 * worth stating on the page: a merchant reading "quiet, tailored,
 * neutral" about their own brand needs to know Disc worked that out from
 * their products rather than being told it by someone.
 *
 * The correction form below is §138 — and correcting produces a new
 * version rather than editing this one, so a recommendation made last
 * week still resolves against the brain that actually produced it.
 */

export const dynamic = "force-dynamic";

const STYLE_LABELS: Record<string, string> = {
  minimal: "Minimal",
  classic: "Classic",
  streetwear: "Streetwear",
  romantic: "Romantic",
  utilitarian: "Utilitarian",
  bohemian: "Bohemian",
  preppy: "Preppy",
  edgy: "Edgy",
  sporty: "Sporty",
  luxe: "Luxe",
};

export default async function BrandPage() {
  const [brand, overview] = await Promise.all([
    apiGet<BrandBrain>("/merchant/brand"),
    apiGet<Overview | null>("/merchant/overview"),
  ]);

  const status = overview?.status.brandBrain ?? "pending";

  if (!brand) {
    return (
      <>
        <PageHead title="Brand">
          What Disc has learned about how your store dresses people.
        </PageHead>
        {status === "building" ? (
          <Empty>
            Disc is reading your catalog to work out your brand. This finishes on
            its own — no action needed.
          </Empty>
        ) : status === "error" ? (
          <div className="note bad">
            <strong>Disc could not build a brand profile.</strong> This usually
            means too few products were understood well enough. Check your
            Catalog page.
          </div>
        ) : (
          <Empty>
            Disc builds this once it understands enough of your catalog. Nothing
            to do yet.
          </Empty>
        )}
      </>
    );
  }

  const styles = Object.entries(brand.styleVector ?? {})
    .filter(([, weight]) => typeof weight === "number" && weight > 0.05)
    .sort((a, b) => b[1] - a[1]);

  const formalityMean =
    typeof brand.formality?.mean === "number" ? brand.formality.mean : null;

  return (
    <>
      <PageHead title="Brand">
        What Disc has learned about how your store dresses people — derived from
        your catalog, not from a template.
      </PageHead>

      <Card
        title="Brand identity"
        hint={`Version ${brand.version} · ${
          brand.source === "merchant_corrected" ? "corrected by you" : "derived by Disc"
        }`}
        aside={<BrainPill status={status} />}
      >
        <p
          style={{
            fontFamily: "var(--serif)",
            fontSize: 17,
            lineHeight: 1.5,
            margin: "0 0 12px",
          }}
        >
          {brand.summary || "No summary generated."}
        </p>
        <Pill tone={brand.confidence >= 0.6 ? "ok" : "warn"}>
          {Math.round(brand.confidence * 100)}% confidence
        </Pill>
        {brand.confidence < 0.6 && (
          <p style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 0 }}>
            Low confidence usually means a small or mixed catalog. Correcting it
            below is faster than waiting for more products.
          </p>
        )}
      </Card>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <Card title="Style profile">
          {styles.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", margin: 0 }}>
              No dominant style emerged.
            </p>
          ) : (
            styles.map(([style, weight]) => (
              <div className="meter-group" key={style}>
                <div className="meter-row">
                  <span>{STYLE_LABELS[style] ?? style}</span>
                  <span className="n">{Math.round(weight * 100)}%</span>
                </div>
                <div className="bar">
                  <span style={{ width: `${Math.round(weight * 100)}%` }} />
                </div>
              </div>
            ))
          )}
        </Card>

        <Card title="Palette">
          <Palette label="Dominant" colours={brand.palette?.dominant} />
          <Palette label="Accent" colours={brand.palette?.accent} />
          <Palette label="Neutrals" colours={brand.palette?.neutrals} />
        </Card>

        <Card title="Product world">
          {Object.keys(brand.productWorld ?? {}).length === 0 ? (
            <p style={{ color: "var(--ink-faint)", margin: 0 }}>
              Not enough categories to describe.
            </p>
          ) : (
            <dl className="kv">
              {Object.entries(brand.productWorld).map(([key, value]) => (
                <div key={key} style={{ display: "contents" }}>
                  <dt>{humanise(key)}</dt>
                  <dd>{renderValue(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {formalityMean !== null && (
            <p style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 0 }}>
              Typical formality {formalityMean.toFixed(1)} of 10.
            </p>
          )}
        </Card>

        <Card title="Language">
          <Tags label="Tone" values={brand.voice?.tone} />
          <Tags label="Vocabulary" values={brand.voice?.vocabulary} />
        </Card>
      </div>

      {brand.merchandising && Object.keys(brand.merchandising).length > 0 && (
        <>
          <h2 className="section">Merchandising</h2>
          <Card>
            <dl className="kv">
              {Object.entries(brand.merchandising).map(([key, value]) => (
                <div key={key} style={{ display: "contents" }}>
                  <dt>{humanise(key)}</dt>
                  <dd>{renderValue(value)}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}

      <h2 className="section">Correct it</h2>
      <Card hint="Disc infers your brand from your catalog. If it has read you wrong, say so — corrections outrank what Disc worked out on its own.">
        <BrandCorrectionForm brand={brand} />
      </Card>
    </>
  );
}

function Palette({ label, colours }: { label: string; colours?: string[] }) {
  if (!colours?.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginBottom: 6 }}>
        {label}
      </div>
      <div className="swatches">
        {colours.map((colour) => (
          <span className="swatch" key={colour}>
            <i style={{ background: cssColour(colour) }} aria-hidden />
            {colour}
          </span>
        ))}
      </div>
    </div>
  );
}

function Tags({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginBottom: 6 }}>
        {label}
      </div>
      <div className="tags">
        {values.map((value) => (
          <span className="tag" key={value}>
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Colour names come from Disc's closed vocabulary, not from CSS, so most
 * are valid CSS keywords by luck rather than design. The few that are
 * not get an explicit mapping.
 *
 * Anything unrecognised falls back to a neutral rather than being passed
 * through as a CSS value: this renders on the server, where there is no
 * `CSS.supports` to test with, and interpolating an unvalidated string
 * into a `background` is how merchant data becomes a style injection.
 */
const COLOUR_MAP: Record<string, string> = {
  cream: "#f2ead8",
  camel: "#c19a6b",
  charcoal: "#36454f",
  ecru: "#c2b280",
  taupe: "#8b8589",
  burgundy: "#800020",
  rust: "#b7410e",
  sage: "#9caf88",
  stone: "#d6d0c4",
  oatmeal: "#e0d8c3",
  mustard: "#ffdb58",
  terracotta: "#e2725b",
  "off-white": "#faf9f6",
};

/** Plain CSS colour keywords: letters only, so nothing can escape the value. */
const SAFE_KEYWORD = /^[a-z]{3,20}$/;

function cssColour(name: string): string {
  const key = name.toLowerCase().trim();
  if (COLOUR_MAP[key]) return COLOUR_MAP[key];
  if (SAFE_KEYWORD.test(key)) return key;
  return "var(--border-strong)";
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  if (value && typeof value === "object") return Object.keys(value).join(", ");
  return String(value ?? "—");
}
