/**
 * Intent parsing (spec §38, §39) and session transforms (§40, §61).
 *
 * The rule that shapes this whole file is §38's last line:
 *
 *   "The deterministic path must never discard meaningful semantic
 *    residue. If the parser cannot interpret a meaningful phrase, hand
 *    it to the reasoning layer."
 *
 * So the parser does not return an intent. It returns an intent *and*
 * what it could not account for. A query like "black linen shirt under
 * $100" is fully consumed and never needs a model; "something
 * expensive-looking without looking flashy" leaves almost everything
 * unconsumed and must escalate. Deciding that by keyword-spotting alone
 * would quietly drop the half of the request that actually mattered.
 *
 * Pure functions, no Convex imports — every rule here is testable.
 */

import { coerceTerm, FORMALITY_MAX, OCCASIONS, STYLES } from "./taxonomy";

export type Budget = { amount: number; currency: string | null };

export type Intent = {
  workflow: Workflow;
  query: string;
  occasion: string | null;
  formality: number | null;
  stylePositive: string[];
  styleNegative: string[];
  fitNegative: string[];
  colors: string[];
  garments: string[];
  budget: Budget | null;
  /** Slots the shopper has fixed; refinement searches only the rest. */
  locked: Record<string, string>;
  targetSlot: string | null;
};

export const WORKFLOWS = [
  "PRODUCT_SEARCH",
  "SIMILAR",
  "STYLE_PRODUCT",
  "COMPLETE_LOOK",
  "OUTFIT",
  "COMPARE",
  "REFINE",
] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export function emptyIntent(query = ""): Intent {
  return {
    workflow: "PRODUCT_SEARCH",
    query,
    occasion: null,
    formality: null,
    stylePositive: [],
    styleNegative: [],
    fitNegative: [],
    colors: [],
    garments: [],
    budget: null,
    locked: {},
    targetSlot: null,
  };
}

export type ParseResult = {
  intent: Intent;
  /** Words the parser could not account for. */
  residue: string[];
  /** Whether the residue is meaningful enough to need a model. */
  needsReasoning: boolean;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR",
};

/**
 * Words that carry no constraint. Removed from residue so a fully
 * understood query isn't escalated because it contained "a" and "for".
 */
const STOPWORDS = new Set([
  "a", "an", "the", "some", "something", "anything", "i", "im", "i'm", "me",
  "my", "want", "need", "looking", "look", "for", "to", "of", "in", "on",
  "with", "and", "or", "but", "is", "are", "that", "this", "it", "please",
  "would", "like", "show", "find", "get", "give", "can", "you", "help",
  "wear", "wearing", "outfit", "under", "over", "about", "around", "at",
  "有", "s", "t",
]);

const OCCASION_SYNONYMS: Record<string, string> = {
  dinner: "dinner", date: "dinner", restaurant: "dinner",
  work: "work", office: "work", meeting: "work", interview: "work",
  wedding: "wedding", party: "party", club: "party", night: "party",
  travel: "travel", holiday: "travel", vacation: "travel", flight: "travel",
  beach: "beach", pool: "beach", resort: "beach",
  gym: "sport", running: "sport", workout: "sport", training: "sport",
  hiking: "outdoor", outdoors: "outdoor", camping: "outdoor",
  everyday: "everyday", casual: "everyday", weekend: "everyday",
  formal: "formal_event", gala: "formal_event", ceremony: "formal_event",
};

const COLOR_WORDS = [
  "black", "white", "grey", "gray", "beige", "cream", "brown", "tan",
  "navy", "blue", "green", "olive", "khaki", "yellow", "orange", "red",
  "burgundy", "pink", "purple", "gold", "silver",
];

const FIT_WORDS = [
  "skinny", "slim", "regular", "relaxed", "oversized", "wide", "tailored",
  "cropped", "baggy", "loose", "tight", "fitted",
];

const GARMENT_WORDS = [
  "shirt", "tshirt", "t-shirt", "tee", "polo", "blouse", "sweater", "jumper",
  "hoodie", "trouser", "trousers", "pants", "jeans", "chinos", "shorts",
  "skirt", "dress", "jumpsuit", "jacket", "blazer", "coat", "suit", "vest",
  "sneaker", "sneakers", "trainers", "loafer", "loafers", "boot", "boots",
  "derby", "sandal", "sandals", "heel", "heels", "flat", "flats",
  "bag", "belt", "hat", "scarf", "jewelry", "jewellery", "watch",
];

/** Words that flip the sense of what follows them. */
const NEGATORS = new Set([
  "no", "not", "without", "avoid", "hate", "dislike", "anti", "less",
  // "nothing streetwear" and "none of that" are how shoppers actually
  // phrase a rejection; omitting them meant the constraint was parsed as
  // residue and silently dropped.
  "nothing", "none", "never", "except", "excluding", "minus",
]);

/**
 * Words that state a formality level (spec §52).
 *
 * Without these, "a relaxed casual outfit" constrained nothing and a
 * formality-5 derby could appear in it — the benchmark caught exactly
 * that. Formality is a soft signal rather than a hard filter (§48), but
 * a soft signal that is never set cannot influence anything.
 */
const FORMALITY_WORDS: Record<string, number> = {
  scruffy: 0, sloppy: 0, lounge: 0, loungewear: 0,
  casual: 1, relaxed: 1, everyday: 1, easy: 1, weekend: 1,
  "smart-casual": 2, smartcasual: 2, presentable: 2, tidy: 2,
  smart: 3, polished: 3, sharp: 3, elevated: 3, refined: 3,
  formal: 4, dressy: 4, tailored: 4, business: 4,
  black: 5, tie: 5, gala: 5, ceremonial: 5,
};

/**
 * Parse what can be parsed deterministically.
 *
 * Spec §38 wants the cheap path used when the request is obvious. This
 * consumes each token it understands and reports the rest, so the
 * decision to escalate is based on what was actually left over rather
 * than on a guess about complexity.
 */
export function parseIntent(rawQuery: string): ParseResult {
  const intent = emptyIntent(rawQuery.trim());
  const lower = rawQuery.toLowerCase();

  const consumed = new Set<number>();
  const tokens = lower.split(/\s+/).filter(Boolean);

  // Budget first — it spans multiple tokens and has the clearest signal.
  const budget = parseBudget(lower);
  if (budget) {
    intent.budget = budget.value;
    for (const token of budget.matchedTokens) {
      tokens.forEach((t, i) => {
        if (t.includes(token)) consumed.add(i);
      });
    }
    // "under" / "below" are consumed with the amount they qualify.
    tokens.forEach((t, i) => {
      if (["under", "below", "less", "max", "maximum", "up"].includes(t)) consumed.add(i);
    });
  }

  tokens.forEach((token, index) => {
    if (consumed.has(index)) return;
    const word = token.replace(/[^a-z-]/g, "");
    if (!word) {
      consumed.add(index);
      return;
    }

    // A negator applies to the NEXT meaningful token, so it is consumed
    // here and its effect applied when that token is reached.
    const negated = index > 0 && NEGATORS.has(tokens[index - 1].replace(/[^a-z]/g, ""));

    if (NEGATORS.has(word)) {
      consumed.add(index);
      return;
    }

    if (STOPWORDS.has(word)) {
      consumed.add(index);
      return;
    }

    // Formality is checked FIRST and never returns early, because these
    // words overlap every other category: "casual" is also an occasion,
    // "relaxed" and "tailored" are also fits, "formal" is also a style.
    // Whichever check ran first used to consume the token, so formality
    // was never set at all — the benchmark caught a formality-5 derby
    // appearing in a "relaxed casual" outfit.
    const formalityLevel = FORMALITY_WORDS[word];
    if (formalityLevel !== undefined && !negated) {
      // The strongest statement wins when several appear: "smart formal"
      // is formal, not an average landing between them.
      intent.formality =
        intent.formality === null
          ? formalityLevel
          : Math.max(intent.formality, formalityLevel);
      consumed.add(index);
    }

    const occasion = OCCASION_SYNONYMS[word];
    if (occasion && (OCCASIONS as readonly string[]).includes(occasion)) {
      if (!negated) intent.occasion = occasion;
      consumed.add(index);
      return;
    }

    if (COLOR_WORDS.includes(word)) {
      if (!negated) intent.colors.push(normaliseColor(word));
      consumed.add(index);
      return;
    }

    if (FIT_WORDS.includes(word)) {
      if (negated) intent.fitNegative.push(normaliseFit(word));
      consumed.add(index);
      return;
    }

    if (GARMENT_WORDS.includes(word)) {
      if (!negated) intent.garments.push(normaliseGarment(word));
      consumed.add(index);
      return;
    }

    const style = coerceTerm(STYLES, word);
    if (style) {
      if (negated) intent.styleNegative.push(style);
      else intent.stylePositive.push(style);
      consumed.add(index);
      return;
    }
  });

  const residue = tokens.filter((_, i) => !consumed.has(i));

  return {
    intent,
    residue,
    // Any residue at all is meaningful — the tokens that carry no
    // constraint were already removed as stopwords. Escalating on a
    // single leftover word is the cheap direction to be wrong in:
    // dropping "expensive-looking" silently is much worse than one
    // avoidable model call.
    needsReasoning: residue.length > 0,
  };
}

function parseBudget(query: string): { value: Budget; matchedTokens: string[] } | null {
  // "$100", "100 dollars", "under 100", "£80"
  const symbolMatch = query.match(/([$£€¥₹])\s?(\d[\d,]*(?:\.\d+)?)/);
  if (symbolMatch) {
    return {
      value: {
        amount: Number(symbolMatch[2].replace(/,/g, "")),
        currency: CURRENCY_SYMBOLS[symbolMatch[1]] ?? null,
      },
      matchedTokens: [symbolMatch[0].replace(/\s/g, ""), symbolMatch[2]],
    };
  }

  const wordMatch = query.match(
    /(?:under|below|less than|max|maximum|up to)\s+(\d[\d,]*(?:\.\d+)?)/,
  );
  if (wordMatch) {
    return {
      value: { amount: Number(wordMatch[1].replace(/,/g, "")), currency: null },
      matchedTokens: [wordMatch[1]],
    };
  }
  return null;
}

function normaliseColor(word: string): string {
  if (word === "gray") return "grey";
  if (word === "khaki") return "olive";
  if (word === "cream") return "white";
  if (word === "tan") return "beige";
  return word;
}

function normaliseFit(word: string): string {
  if (word === "baggy" || word === "loose") return "relaxed";
  if (word === "tight") return "skinny";
  if (word === "fitted") return "slim";
  return word;
}

function normaliseGarment(word: string): string {
  const map: Record<string, string> = {
    tshirt: "t-shirt", tee: "t-shirt", jumper: "sweater",
    trousers: "trouser", pants: "trouser", sneakers: "sneaker",
    trainers: "sneaker", loafers: "loafer", boots: "boot",
    sandals: "sandal", heels: "heel", flats: "flat", jewellery: "jewelry",
  };
  return map[word] ?? word;
}

/**
 * Validate a model's intent output (spec §39: "Validate with a runtime
 * schema"). Merged over the deterministic parse rather than replacing
 * it — what the parser established from explicit words is more reliable
 * than a model's reading of the same query.
 */
export function parseModelIntent(raw: unknown, base: Intent): Intent {
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out: Intent = { ...base };

  const workflow = typeof r.workflow === "string" ? r.workflow.toUpperCase() : null;
  if (workflow && (WORKFLOWS as readonly string[]).includes(workflow)) {
    out.workflow = workflow as Workflow;
  }

  if (out.occasion === null && typeof r.occasion === "string") {
    const occasion = coerceTerm(OCCASIONS, r.occasion);
    if (occasion) out.occasion = occasion;
  }

  if (out.formality === null && r.formality !== undefined && r.formality !== null) {
    const n = Number(r.formality);
    if (Number.isFinite(n) && n >= 0 && n <= FORMALITY_MAX) out.formality = n;
  }

  const styles = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const term = coerceTerm(STYLES, item);
      if (term) out.push(term);
    }
    return out;
  };

  out.stylePositive = unique([...out.stylePositive, ...styles(r.stylePositive ?? r.style_positive)]);
  out.styleNegative = unique([...out.styleNegative, ...styles(r.styleNegative ?? r.style_negative)]);

  if (out.budget === null && r.budget && typeof r.budget === "object") {
    const b = r.budget as Record<string, unknown>;
    const amount = Number(b.amount);
    if (Number.isFinite(amount) && amount > 0) {
      out.budget = {
        amount,
        currency: typeof b.currency === "string" ? b.currency.toUpperCase() : null,
      };
    }
  }

  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Follow-up transforms (spec §40).
 *
 * The whole reason session state is structured rather than a chat
 * transcript: "make it cheaper" is a field update on what already
 * exists, not a re-read of everything said so far. Every transform
 * preserves the constraints it does not touch — losing them is §101's
 * `constraint_loss` error.
 */
export function applyFollowUp(session: Intent, utterance: string): Intent | null {
  const text = utterance.toLowerCase().trim();
  const next: Intent = { ...session, locked: { ...session.locked } };

  if (/\b(cheaper|less expensive|lower price|too expensive)\b/.test(text)) {
    if (session.budget) {
      next.budget = { ...session.budget, amount: Math.round(session.budget.amount * 0.7) };
    } else {
      // No budget to lower. Escalate rather than invent a number the
      // shopper never gave.
      return null;
    }
    next.workflow = "REFINE";
    return next;
  }

  if (/\b(more expensive|higher end|premium|nicer)\b/.test(text)) {
    if (!session.budget) return null;
    next.budget = { ...session.budget, amount: Math.round(session.budget.amount * 1.4) };
    next.workflow = "REFINE";
    return next;
  }

  if (/\b(less formal|more casual|dress it down|casual)\b/.test(text)) {
    next.formality = clampFormality((session.formality ?? 2.5) - 1);
    next.workflow = "REFINE";
    return next;
  }

  if (/\b(more formal|smarter|dress it up|dressier)\b/.test(text)) {
    next.formality = clampFormality((session.formality ?? 2.5) + 1);
    next.workflow = "REFINE";
    return next;
  }

  // "change the shoes" — lock every other slot, search only this one.
  const swap = text.match(
    /\b(?:change|swap|different|another|replace)\s+(?:the\s+)?(shoes?|top|bottom|trousers?|jacket|outerwear|accessor(?:y|ies))\b/,
  );
  if (swap) {
    const slot = normaliseSlotWord(swap[1]);
    if (slot) {
      next.targetSlot = slot;
      next.workflow = "REFINE";
      // Everything already chosen except the target stays fixed.
      next.locked = { ...session.locked };
      delete next.locked[slot];
      return next;
    }
  }

  return null;
}

function clampFormality(value: number): number {
  return Math.max(0, Math.min(FORMALITY_MAX, Math.round(value * 2) / 2));
}

function normaliseSlotWord(word: string): string | null {
  if (/^shoes?$/.test(word)) return "footwear";
  if (/^trousers?$/.test(word) || word === "bottom") return "bottom";
  if (word === "top") return "top";
  if (word === "jacket" || word === "outerwear") return "outerwear";
  if (word.startsWith("accessor")) return "accessory";
  return null;
}
