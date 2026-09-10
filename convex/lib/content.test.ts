import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_ROLES,
  MEDIA_KINDS,
  assertsStyling,
  isBounded,
  isProcessable,
  parseMediaKind,
  parseOrigin,
  parsePresenceState,
  parseRole,
  parseScope,
  PROCESSABLE_MEDIA_KINDS,
} from "./content";

/**
 * The content vocabulary, without a database.
 *
 * Everything here decides what a piece of content is ALLOWED TO ASSERT,
 * which is the part of the content model that cannot be recovered later
 * if it is wrong: an edge derived from content that never claimed to be
 * a styled outfit is indistinguishable, once written, from one a
 * merchant actually approved.
 */

test("only a look asserts that its products were styled together", () => {
  assert.equal(assertsStyling("look"), true);

  // The whole point. A campaign photograph, a lookbook, an editorial and
  // a social post all establish that products APPEAR in them. None of
  // them says those products belong together.
  for (const role of ["campaign", "lookbook", "editorial", "social_post"] as const) {
    assert.equal(assertsStyling(role), false, role);
  }
});

test("absent means look, so nothing written before P2.3 changes meaning", () => {
  // Every row that existed before this vocabulary did was a look, and
  // reading one back must not silently reclassify it.
  assert.equal(assertsStyling(undefined), true);
  assert.equal(assertsStyling(null), true);
  assert.equal(parseRole(undefined), "look");
});

test("an unreadable role degrades to look, never to something wider", () => {
  // The safe direction is the NARROW one. Falling back to a role that
  // asserts less would be tempting — but "look" is the only meaning the
  // system has ever had, and it is the one a merchant approves
  // explicitly before it affects anything. Falling back to a
  // presence-only role would silently drop a real styling claim.
  for (const bad of ["", "video", "not_a_role", 7, null, {}, []]) {
    assert.equal(parseRole(bad), "look");
  }

  for (const role of CONTENT_ROLES) {
    assert.equal(parseRole(role), role);
  }
});

test("media kind is separate from what the content asserts", () => {
  // Orthogonal on purpose: a campaign can be a photograph or a film, and
  // both are campaigns. Collapsing them would make "is this a video?"
  // and "does this assert styling?" the same question, which is exactly
  // the conflation the presence/compatibility split exists to prevent.
  for (const kind of MEDIA_KINDS) {
    assert.equal(parseMediaKind(kind), kind);
  }
  assert.equal(parseMediaKind(undefined), "image");
  assert.equal(parseMediaKind("gif"), "image");
});

test("only image is processable, and the list says so rather than the code assuming it", () => {
  assert.deepEqual([...PROCESSABLE_MEDIA_KINDS], ["image"]);
  assert.equal(isProcessable("image"), true);
  // Declaring `video` in the vocabulary is a modelling decision. Being
  // able to decode one is an infrastructure decision, and P2.3 makes
  // only the first.
  assert.equal(isProcessable("video"), false);
  assert.equal(isProcessable("article"), false);
});

test("origin falls back to what the caller knows, not to a guess", () => {
  assert.equal(parseOrigin("instagram", "merchant_upload"), "instagram");
  assert.equal(parseOrigin(undefined, "merchant_built"), "merchant_built");
  assert.equal(parseOrigin("carrier_pigeon", "merchant_upload"), "merchant_upload");
});

test("presence states are closed, and an unknown one is refused rather than defaulted", () => {
  assert.equal(parsePresenceState("detected"), "detected");
  assert.equal(parsePresenceState("confirmed"), "confirmed");
  assert.equal(parsePresenceState("rejected"), "rejected");

  // No default here, unlike role. Guessing a merchant's decision is
  // exactly the thing that must never happen: defaulting to `detected`
  // would downgrade a confirmation, and defaulting to `confirmed` would
  // invent one.
  assert.equal(parsePresenceState("maybe"), null);
  assert.equal(parsePresenceState(undefined), null);
});

test("a scope with no bounds is the whole item", () => {
  assert.deepEqual(parseScope(undefined), { kind: "whole" });
  assert.deepEqual(parseScope({ kind: "whole" }), { kind: "whole" });
  assert.equal(isBounded(parseScope(undefined)), false);
});

test("a region is kept, in units that survive a resolution change", () => {
  const scope = parseScope({ kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.deepEqual(scope, { kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.equal(isBounded(scope), true);

  // Clamped rather than rejected: a box slightly outside the frame is a
  // detector being imprecise, not a claim that cannot be read.
  assert.deepEqual(parseScope({ kind: "region", x: -1, y: 2, w: 0.5, h: 0.5 }), {
    kind: "region",
    x: 0,
    y: 1,
    w: 0.5,
    h: 0.5,
  });
});

test("a time interval is kept, and rounded to whole milliseconds", () => {
  const scope = parseScope({ kind: "interval", startMs: 120_000.4, endMs: 128_000.6 });
  assert.deepEqual(scope, { kind: "interval", startMs: 120000, endMs: 128001 });
  assert.equal(isBounded(scope), true);
});

test("AN UNREADABLE BOUND IS NOT A NARROWER CLAIM", () => {
  // The important one. A half-scope is more dangerous than no scope,
  // because code downstream will treat a bound that exists as real —
  // and a future compatibility rule keyed on "did these share a bounded
  // scope?" would then answer yes for two products that shared nothing.
  const unreadable = [
    { kind: "interval", startMs: 900, endMs: 100 }, // ends before it starts
    { kind: "interval", startMs: 500 }, // no end
    { kind: "interval", startMs: -5, endMs: 100 }, // before the beginning
    { kind: "region", x: 0.1, y: 0.1, w: 0.5 }, // no height
    { kind: "region", x: 0.1, y: 0.1, w: 0, h: 0.5 }, // zero area
    { kind: "scene", startMs: 1, endMs: 2 }, // not a kind we know
    "whole",
    42,
  ];
  for (const raw of unreadable) {
    assert.deepEqual(parseScope(raw), { kind: "whole" }, JSON.stringify(raw));
  }
});
