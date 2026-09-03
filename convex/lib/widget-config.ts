/**
 * Experience controls (spec §74).
 *
 * "Keep controls high-level." The spec is emphatic about this in two
 * places — §19 says "Do not make the merchant configure 50 variables"
 * and §17 says "The merchant should primarily correct Disc, not manually
 * teach Disc everything."
 *
 * So this is a short list, and every value is validated against a closed
 * set. A merchant cannot type arbitrary CSS or arbitrary workflow names:
 * §65 requires that model and merchant input alike map onto known design
 * tokens rather than becoming free-form styling.
 */

import { WORKFLOWS, type Workflow } from "./intent";

export const PLACEMENTS = ["bottom_bar", "floating_button"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const DENSITIES = ["airy", "balanced", "dense"] as const;
export const MOTIONS = ["subtle", "standard", "none"] as const;
export const CARD_STYLES = ["editorial", "clean", "bold"] as const;
export const CORNER_RADII = ["none", "small", "medium", "large"] as const;

export const GREETING_MAX = 80;

/**
 * The caption on the storefront entry control.
 *
 * Short on purpose. This is a control on someone else's storefront, next
 * to their own navigation, and it has to survive a 320px phone without
 * wrapping or being ellipsed — 32 characters comfortably holds every
 * candidate in `PRODUCT_DIRECTION.md` ("Discover Your Style" is 19).
 */
export const ENTRY_LABEL_MAX = 32;

/**
 * Deliberately the product name, not a chosen line of marketing copy.
 *
 * `PRODUCT_DIRECTION.md` records the entry-point copy as undecided —
 * "Your Style", "Personalized Style", "Personal Stylist", "Discover Your
 * Style" — and says explicitly that it is "to be tested, not picked in
 * code". Defaulting to one of those candidates would make this file the
 * place that decision got made by accident. "Disc" names the thing the
 * control opens and claims nothing, and because the field is
 * merchant-editable, testing a candidate needs no code change.
 */
export const DEFAULT_ENTRY_LABEL = "Disc";

export type WidgetConfig = {
  enabled: boolean;
  placement: Placement;
  /**
   * The in-bar placeholder — the first thing a shopper reads *inside*
   * Disc, once it is open. Not the entry point's caption; see
   * `entryLabel`.
   */
  greeting: string;
  /**
   * The caption on the storefront entry control — what a shopper reads
   * *before* Disc is open, and only when `placement` is
   * `"floating_button"`.
   *
   * Kept separate from `greeting` because they are read at different
   * moments and answer different questions. `greeting` asks the shopper
   * something ("What are you looking for?"); `entryLabel` names a door.
   * Collapsing them would put a question on a button.
   */
  entryLabel: string;
  /** Which shopper entry points are offered (spec §41, §43). */
  workflows: Workflow[];
  /** Maps to known design tokens; never arbitrary CSS (spec §65). */
  design: {
    density: (typeof DENSITIES)[number];
    motion: (typeof MOTIONS)[number];
    cardStyle: (typeof CARD_STYLES)[number];
    cornerRadius: (typeof CORNER_RADII)[number];
  };
};

export function defaultWidgetConfig(): WidgetConfig {
  return {
    // Starts disabled. A merchant previews before Disc appears on their
    // storefront (spec §13, §127) — installing must never silently
    // change what shoppers see.
    enabled: false,
    placement: "bottom_bar",
    greeting: "What are you looking for?",
    entryLabel: DEFAULT_ENTRY_LABEL,
    workflows: ["PRODUCT_SEARCH", "SIMILAR", "STYLE_PRODUCT", "COMPLETE_LOOK", "OUTFIT"],
    design: {
      density: "airy",
      motion: "subtle",
      cardStyle: "editorial",
      cornerRadius: "small",
    },
  };
}

function oneOf<T extends readonly string[]>(
  vocabulary: T,
  value: unknown,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

/**
 * Merchant free text on its way to a storefront.
 *
 * There is exactly one of these fields per rendered string, and both go
 * through here, because "it is only a caption" is how unbounded text
 * reaches other people's pages. Three separate hazards, in order:
 *
 *  - **Invisible characters are not inert.** A newline breaks a
 *    single-line control's layout, a zero-width space defeats a length
 *    check a human made by eye, and a bidi override (U+202E and
 *    friends) reorders every character after it — so a label can read
 *    one way in the dashboard and another on the storefront. They are
 *    replaced with a space rather than deleted so that the words either
 *    side do not fuse into one.
 *  - **Length is capped after normalising, not before**, so the cap
 *    counts characters a shopper can actually see.
 *  - **The cut is by code point.** A plain `.slice()` can sever a
 *    surrogate pair and leave a lone surrogate, which renders as U+FFFD
 *    — a caption ending in a replacement glyph on a brand's storefront.
 *
 * Markup safety is not attempted here and must not be: escaping depends
 * on the context the value lands in, so it belongs at render time. The
 * storefront renders both of these through `textContent`, never
 * `innerHTML`, which is why a string containing `<script>` is a string
 * containing `<script>` and nothing more.
 */
function boundedText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(
      // C0, DEL + C1, zero-width and bidi controls, line/paragraph separators.
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join("").trim() : cleaned;
}

/**
 * Validate merchant input into a config.
 *
 * Never throws and never stores anything outside the known sets — this
 * value is rendered into a storefront, so an unvalidated string here
 * would be merchant-supplied content reaching every shopper's browser.
 */
export function parseWidgetConfig(raw: unknown): WidgetConfig {
  const base = defaultWidgetConfig();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;

  const design = (r.design ?? {}) as Record<string, unknown>;
  const workflows = Array.isArray(r.workflows)
    ? r.workflows.filter((w): w is Workflow =>
        (WORKFLOWS as readonly string[]).includes(w as string),
      )
    : base.workflows;

  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
    placement: oneOf(PLACEMENTS, r.placement, base.placement),
    // Both of these are rendered on the storefront, so both are bounded.
    // They are separate fields rather than one because they are read at
    // different moments: `entryLabel` before Disc opens, `greeting`
    // after.
    greeting: boundedText(r.greeting, GREETING_MAX, base.greeting),
    entryLabel: boundedText(r.entryLabel, ENTRY_LABEL_MAX, base.entryLabel),
    // An empty list would leave the widget with no way to be used at
    // all, which is a misconfiguration rather than a choice.
    workflows: workflows.length > 0 ? workflows : base.workflows,
    design: {
      density: oneOf(DENSITIES, design.density, base.design.density),
      motion: oneOf(MOTIONS, design.motion, base.design.motion),
      cardStyle: oneOf(CARD_STYLES, design.cardStyle, base.design.cardStyle),
      cornerRadius: oneOf(CORNER_RADII, design.cornerRadius, base.design.cornerRadius),
    },
  };
}
