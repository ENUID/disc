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

export type WidgetConfig = {
  enabled: boolean;
  placement: Placement;
  greeting: string;
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
    // Bounded: this string is rendered on the storefront. Length is
    // capped and the value is escaped at render time.
    greeting:
      typeof r.greeting === "string" && r.greeting.trim()
        ? r.greeting.trim().slice(0, 80)
        : base.greeting,
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
