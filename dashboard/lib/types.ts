/**
 * The shapes the Convex HTTP router returns.
 *
 * Hand-written rather than imported from `/convex`: the dashboard is a
 * separate deployable with its own dependency tree, and importing across
 * that boundary would drag Convex's server runtime into a Vercel bundle
 * to gain types alone. The cost is that these can drift, so anything
 * optional here is genuinely optional on the wire.
 */

export type CatalogStatus = "pending" | "syncing" | "ready" | "error" | "unknown";
export type BrandBrainStatus = "pending" | "building" | "ready" | "error";
export type WidgetStatus = "inactive" | "previewing" | "live";

export type OnboardingStage = {
  key: string;
  label: string;
  done: boolean;
  failed: boolean;
};

export type Overview = {
  shopDomain: string;
  status: {
    catalog: CatalogStatus;
    brandBrain: BrandBrainStatus;
    widget: WidgetStatus;
    subscription: string;
    active: boolean;
  };
  productCount: number;
  lastSyncedAt: number | null;
  catalogError: string | null;
  onboarding: OnboardingStage[];
  needsActivation: boolean;
};

export type CatalogHealth = {
  total: number;
  indexed: number;
  enriched: number;
  notEnriched: number;
  lowConfidence: number;
  rejectedFields: number;
  unavailable: number;
  missingImages: number;
};

export type WidgetConfig = {
  enabled: boolean;
  placement: "bottom_bar" | "floating_button";
  /** Read inside Disc, as the bar's placeholder. */
  greeting: string;
  /** Read before Disc opens, on the floating entry control. */
  entryLabel: string;
  workflows: string[];
  design: {
    density: "airy" | "balanced" | "dense";
    motion: "subtle" | "standard" | "none";
    cardStyle: "editorial" | "clean" | "bold";
    cornerRadius: "none" | "small" | "medium" | "large";
  };
};

export type Experience = {
  config: WidgetConfig;
  widgetStatus: WidgetStatus;
  publicKey: string;
};

export type BrandBrain = {
  version: number;
  isCurrent: boolean;
  styleVector: Record<string, number>;
  palette: {
    dominant?: string[];
    accent?: string[];
    neutrals?: string[];
    [key: string]: unknown;
  };
  formality: { mean?: number; range?: [number, number]; [key: string]: unknown };
  productWorld: Record<string, unknown>;
  voice: { tone?: string[]; vocabulary?: string[]; [key: string]: unknown };
  merchandising?: Record<string, unknown>;
  summary: string;
  source: "derived" | "merchant_corrected";
  confidence: number;
  createdAt: number;
} | null;

export type Analytics = {
  days: number;
  sessions: number;
  queries: number;
  outfitsGenerated: number;
  productsDiscovered: number;
  productClicks: number;
  productSaves: number;
  outfitSaves: number;
  addToCart: number;
  refinements: number;
  errors: number;
  clickThroughRate: number | null;
  cartRate: number | null;
  truncated: boolean;
};

export type Settings = {
  shopDomain: string;
  email: string | null;
  publicKey: string;
  scopes: string;
  installedAt: number;
  plan: string | null;
  subscriptionStatus: string;
  billingEnabled: boolean;
};

export type Plan = {
  key: string;
  name: string;
  price: number;
  catalogLimit: number | null;
};

export type Billing = {
  plans: Plan[];
  trialDays: number;
  enabled: boolean;
  state: {
    enabled: boolean;
    subscriptionStatus: string;
    plan: string | null;
    suggestedPlan: string;
    productCount: number;
    overCatalogLimit: boolean;
    hasCustomer: boolean;
    trialDays: number;
  } | null;
};

export type DashboardBundle = {
  overview: Overview | null;
  catalog: CatalogHealth;
  experience: Experience | null;
  brand: BrandBrain;
};
