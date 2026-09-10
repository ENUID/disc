/**
 * The content intelligence vocabulary (P2.3).
 *
 * Disc's first content system was the Look Builder: a merchant uploads a
 * campaign photograph, a vision model proposes garments, the merchant
 * confirms which catalog products they are, and an approved look teaches
 * the outfit graph that those pieces go together. This file generalises
 * that shape without generalising its *meaning*, because the meaning is
 * the part that breaks.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PROTECT:
 *
 *   PRESENCE       product X appears in this content
 *   COMPATIBILITY  product X and product Y were styled together
 *
 * A campaign photograph establishes both — everything in frame was put
 * there by someone making a styling decision. A twenty-minute lookbook
 * video where a shirt appears at minute 2 and trousers at minute 16
 * establishes only presence: nobody styled those two as an outfit, and
 * deriving an edge from their co-presence would fill the outfit graph
 * with pairs no human ever approved, carrying the authority of a
 * merchant confirmation it never had.
 *
 * So compatibility is derived from ONE role and nothing else, and
 * presence lives in a table the edge-derivation code never queries.
 * See `assertsStyling` below and `PRODUCTION_CONTENT_INTELLIGENCE.md`.
 */

import { coerceTerm } from "./taxonomy";

/**
 * What the bytes are.
 *
 * Kept separate from `CONTENT_ROLES` because they are orthogonal: a
 * campaign can be a photograph or a film, and both are campaigns. The
 * previous model had no such field at all, so every code path assumed a
 * still image — which is exactly the assumption a video would break.
 */
export const MEDIA_KINDS = ["image", "video", "article"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * The media kinds Disc can actually process today.
 *
 * DELIBERATELY ONE. Declaring `video` in the vocabulary is a modelling
 * decision; being able to decode one is an infrastructure decision, and
 * P2.3 makes only the first. Nothing may schedule analysis for a kind
 * that is not in this list — a content item whose processing pipeline
 * does not exist should sit unprocessed and say so, not fail obscurely
 * inside a worker that assumed it was a JPEG.
 */
export const PROCESSABLE_MEDIA_KINDS: readonly MediaKind[] = ["image"];

export function isProcessable(kind: MediaKind): boolean {
  return PROCESSABLE_MEDIA_KINDS.includes(kind);
}

/**
 * What the content ASSERTS. This is the load-bearing field.
 *
 *   look         these products were styled together    -> compatibility
 *   campaign     brand imagery                          -> presence only
 *   lookbook     a collection, not one outfit           -> presence only
 *   editorial    an article or feature                  -> presence only
 *   social_post  posted content                         -> presence only
 *
 * Everything except `look` is presence-only, and that is enforced in one
 * function rather than remembered at each call site.
 */
export const CONTENT_ROLES = [
  "look",
  "campaign",
  "lookbook",
  "editorial",
  "social_post",
] as const;
export type ContentRole = (typeof CONTENT_ROLES)[number];

/**
 * Where the content came from.
 *
 * Only the first two are reachable today; the rest exist so that a
 * future connector is a new value rather than a new column. No
 * integration is implied by a term appearing here — Instagram in
 * particular is NOT implemented, and this vocabulary is not a claim that
 * it is.
 */
export const CONTENT_ORIGINS = [
  "merchant_upload",
  "merchant_built",
  "shopify",
  "instagram",
  "tiktok",
  "youtube",
] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

/**
 * How authoritative a content→product relationship is.
 *
 *   detected   a model proposed it. Not authoritative.
 *   confirmed  a merchant said yes. Authoritative.
 *   rejected   a merchant said no. Authoritative, and STICKY.
 *
 * `rejected` is a stored decision rather than a deleted row on purpose.
 * Deleting a rejection would let the next analysis of the same content
 * propose the same wrong product again, and a merchant who has already
 * said no should not have to keep saying it.
 */
export const PRESENCE_STATES = ["detected", "confirmed", "rejected"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/**
 * Does this content assert that its products were styled together?
 *
 * THE ONE PLACE THAT DECIDES. `rebuildEdgesFor` consults this before
 * writing a single compatibility edge, so widening compatibility to
 * another role is a visible edit to this function rather than something
 * that happens by accident three call sites away.
 *
 * Presence never reaches here — it is stored in `contentProducts`, which
 * the edge-derivation path does not query at all.
 */
export function assertsStyling(role: ContentRole | undefined | null): boolean {
  return (role ?? "look") === "look";
}

export function parseRole(value: unknown): ContentRole {
  // Absent means `look`: every row written before P2.3 is a look, and a
  // default that silently widened compatibility to unknown content would
  // be the exact failure this phase exists to prevent.
  return coerceTerm(CONTENT_ROLES, value) ?? "look";
}

export function parseMediaKind(value: unknown): MediaKind {
  return coerceTerm(MEDIA_KINDS, value) ?? "image";
}

export function parseOrigin(value: unknown, fallback: ContentOrigin): ContentOrigin {
  return coerceTerm(CONTENT_ORIGINS, value) ?? fallback;
}

export function parsePresenceState(value: unknown): PresenceState | null {
  return coerceTerm(PRESENCE_STATES, value);
}

/**
 * WHERE or WHEN in the content a product appears.
 *
 * Absent means the whole item, which is what a still-image look means
 * and therefore what every existing row means. The two bounded forms are
 * modelled now so the shape does not have to change when video arrives:
 *
 *   region    a box in an image, 0..1 of the frame
 *   interval  a time range in a video, milliseconds
 *
 * Nothing in P2.3 produces an interval. The current agreed direction for
 * video is MERCHANT-DEFINED time ranges rather than automatic shot
 * detection, and this is the field that would hold them.
 *
 * Deliberately closed. An open metadata bag here would become the place
 * every future feature dumps state, and the one thing that must stay
 * true of a scope is that it can be reasoned about — "was this bounded?"
 * has to have an answer.
 */
export type PresenceScope =
  | { kind: "whole" }
  | { kind: "region"; x: number; y: number; w: number; h: number }
  | { kind: "interval"; startMs: number; endMs: number };

export const WHOLE_SCOPE: PresenceScope = { kind: "whole" };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 0..1, so a region is resolution-independent. */
function unit(value: unknown): number | null {
  const n = finite(value);
  if (n === null) return null;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Validate a scope, or fall back to the whole item.
 *
 * Never throws and never stores a half-scope: a region missing its
 * height, or an interval that ends before it starts, is not a narrower
 * claim than "the whole item" — it is an unreadable one, and an
 * unreadable bound is more dangerous than no bound because code
 * downstream will treat it as real.
 */
export function parseScope(raw: unknown): PresenceScope {
  if (!raw || typeof raw !== "object") return WHOLE_SCOPE;
  const r = raw as Record<string, unknown>;

  if (r.kind === "region") {
    const x = unit(r.x);
    const y = unit(r.y);
    const w = unit(r.w);
    const h = unit(r.h);
    if (x === null || y === null || w === null || h === null) return WHOLE_SCOPE;
    // A zero-area box locates nothing.
    if (w <= 0 || h <= 0) return WHOLE_SCOPE;
    return { kind: "region", x, y, w, h };
  }

  if (r.kind === "interval") {
    const startMs = finite(r.startMs);
    const endMs = finite(r.endMs);
    if (startMs === null || endMs === null) return WHOLE_SCOPE;
    if (startMs < 0 || endMs <= startMs) return WHOLE_SCOPE;
    return { kind: "interval", startMs: Math.round(startMs), endMs: Math.round(endMs) };
  }

  return WHOLE_SCOPE;
}

/**
 * Is this scope narrower than the whole content item?
 *
 * The question a future compatibility rule would have to ask. Two
 * products sharing a bounded scope — the same frame region, the same
 * scene — are evidence of styling in a way that two products merely
 * present in the same twenty-minute video are not.
 *
 * Nothing derives compatibility from this yet, and P2.3 deliberately
 * does not add such a rule: it would need a merchant-defined scene model
 * that does not exist. It is here because the distinction has to be
 * expressible before it can be used, and because writing it down is what
 * stops someone reaching for whole-item co-presence instead.
 */
export function isBounded(scope: PresenceScope): boolean {
  return scope.kind !== "whole";
}
