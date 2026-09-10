/** Shapes the look routes return. Mirrors `convex/looks.ts`. */

export type LookStatus = "draft" | "approved" | "archived";

export type LookProduct = {
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  currency: string;
  slot: string;
  detectedLabel: string | null;
};

export type LookSummary = {
  id: string;
  title: string;
  status: LookStatus;
  source: "uploaded" | "merchant_built";
  occasion: string | null;
  style: string | null;
  season: string | null;
  formality: number | null;
  itemCount: number;
  imageUrl: string | null;
  products: LookProduct[];
  createdAt: number;
};

export type LookStats = {
  total: number;
  approved: number;
  draft: number;
  /** Product pairs the approved looks have taught Disc. */
  relationships: number;
};

export type Suggestion = {
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  currency: string;
  score: number;
};

export type DetectedGarment = {
  label: string;
  garment: string | null;
  slot: string | null;
  colour: string | null;
  description: string;
};

export type AnalyseResult = {
  detected: DetectedGarment[];
  /** One candidate list per detected garment, same order. */
  suggestions: Suggestion[][];
};
