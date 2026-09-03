import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENTRY_LABEL,
  ENTRY_LABEL_MAX,
  GREETING_MAX,
  PLACEMENTS,
  defaultWidgetConfig,
  parseWidgetConfig,
} from "./widget-config";

/**
 * The storefront entry point, at the layer that decides what a shopper
 * can be shown.
 *
 * Two fields here end up as visible text on a brand's own storefront —
 * `entryLabel` on the entry control and `greeting` inside the bar — and
 * one field decides which control exists at all. Everything a merchant
 * (or anything upstream of a merchant) can type reaches this function
 * first, so this is where "merchant input never becomes free-form
 * styling or free-form markup" is actually true or not.
 */

test("a config with no entry label gets a usable default", () => {
  assert.equal(defaultWidgetConfig().entryLabel, DEFAULT_ENTRY_LABEL);
  assert.equal(parseWidgetConfig({}).entryLabel, DEFAULT_ENTRY_LABEL);
  assert.equal(parseWidgetConfig(null).entryLabel, DEFAULT_ENTRY_LABEL);

  // The point of the default is that the control is never blank. An
  // entry point rendered with no caption is a mystery button on someone
  // else's shop.
  assert.ok(
    parseWidgetConfig({ entryLabel: "" }).entryLabel.length > 0,
    "an empty label must not produce an empty button",
  );
});

test("a merchant's own label is kept verbatim", () => {
  // The whole reason the field exists: `PRODUCT_DIRECTION.md` records
  // the entry-point copy as undecided and to be TESTED, so trying a
  // candidate must be a config change, never a code change.
  for (const candidate of [
    "Your Style",
    "Personalized Style",
    "Personal Stylist",
    "Discover Your Style",
  ]) {
    assert.equal(parseWidgetConfig({ entryLabel: candidate }).entryLabel, candidate);
  }
});

test("whitespace in a label is normalised, not preserved", () => {
  // This is a caption on a single-line pill. A newline or a tab in it is
  // not decoration, it is a broken control — and a merchant pasting from
  // a document produces both without meaning to.
  assert.equal(parseWidgetConfig({ entryLabel: "  Your Style  " }).entryLabel, "Your Style");
  assert.equal(parseWidgetConfig({ entryLabel: "Your\nStyle" }).entryLabel, "Your Style");
  assert.equal(parseWidgetConfig({ entryLabel: "Your\t\tStyle" }).entryLabel, "Your Style");
  assert.equal(parseWidgetConfig({ entryLabel: "Your   Style" }).entryLabel, "Your Style");

  // Whitespace-only is nothing, and nothing falls back to the default
  // rather than to a button captioned with a space.
  assert.equal(parseWidgetConfig({ entryLabel: "   \n\t " }).entryLabel, DEFAULT_ENTRY_LABEL);
});

test("invisible characters are neutralised rather than trusted", () => {
  // Each of these is a real way a string reads one way where it was
  // typed and another where it is rendered.

  // A zero-width space defeats a length check made by eye.
  assert.equal(parseWidgetConfig({ entryLabel: "Your\u200BStyle" }).entryLabel, "Your Style");

  // A right-to-left override reverses everything after it, so a caption
  // can be authored to display as something other than what is stored.
  assert.equal(parseWidgetConfig({ entryLabel: "Shop\u202Eyalp" }).entryLabel, "Shop yalp");

  // A byte-order mark pasted from a file is invisible and would sit
  // inside the caption forever.
  assert.equal(parseWidgetConfig({ entryLabel: "\uFEFFStyle" }).entryLabel, "Style");

  // And a label made of nothing but invisibles is not a label.
  assert.equal(
    parseWidgetConfig({ entryLabel: "\u200B\u200B\u200B" }).entryLabel,
    DEFAULT_ENTRY_LABEL,
  );
});

test("a label is capped, and the cap counts visible characters", () => {
  const long = "x".repeat(500);
  const parsed = parseWidgetConfig({ entryLabel: long });
  assert.equal(parsed.entryLabel.length, ENTRY_LABEL_MAX);

  // Capping AFTER normalising is what makes the cap mean anything: 200
  // zero-width spaces followed by a short label is a short label, not an
  // over-long one that gets truncated to nothing visible.
  assert.equal(
    parseWidgetConfig({ entryLabel: "\u200B".repeat(200) + "Your Style" }).entryLabel,
    "Your Style",
  );

  // The cut is by code point, so an over-long emoji caption cannot end
  // on half a surrogate pair — a lone surrogate renders as U+FFFD.
  const emoji = parseWidgetConfig({ entryLabel: "\u{1F457}".repeat(40) }).entryLabel;
  assert.equal(Array.from(emoji).length, ENTRY_LABEL_MAX);
  assert.ok(
    !/[\uD800-\uDFFF]/.test(
      emoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
    ),
    "no unpaired surrogate survives the cut",
  );
});

test("a malformed label falls back instead of throwing or leaking", () => {
  // parseWidgetConfig is called on the read path for every storefront
  // boot. It throwing would be an outage; it passing a non-string
  // through would be an object rendered as "[object Object]" on a
  // brand's storefront.
  for (const bad of [null, undefined, 42, true, {}, [], { toString: () => "x" }]) {
    const parsed = parseWidgetConfig({ entryLabel: bad });
    assert.equal(typeof parsed.entryLabel, "string");
    assert.equal(parsed.entryLabel, DEFAULT_ENTRY_LABEL);
  }

  // Markup is NOT stripped, and that is deliberate: escaping belongs at
  // render time, where the context is known. What matters is that the
  // value stays a bounded string — the storefront renders it through
  // textContent, so this is a caption reading "<script>", not a script.
  const markup = parseWidgetConfig({ entryLabel: "<script>alert(1)</script>" });
  assert.equal(typeof markup.entryLabel, "string");
  assert.ok(markup.entryLabel.length <= ENTRY_LABEL_MAX);
});

test("an unknown placement falls back to the bar every install already had", () => {
  // The fallback direction is the whole safety argument. `bottom_bar` is
  // what Disc has always rendered, so an unreadable value degrades to
  // the known-good presentation rather than to no entry point at all —
  // a storefront with the native search hidden and nothing in its place
  // is the failure this must never produce.
  for (const bad of [
    "javascript:alert(1)",
    "FLOATING_BUTTON",
    "floating-button",
    "",
    null,
    7,
    {},
  ]) {
    assert.equal(parseWidgetConfig({ placement: bad }).placement, "bottom_bar");
  }
});

test("every declared placement survives a round trip", () => {
  // A value the merchant can pick in the dashboard and the server then
  // discards is exactly the bug this phase exists to close: `placement`
  // validated and persisted for months while the runtime ignored it.
  for (const placement of PLACEMENTS) {
    assert.equal(parseWidgetConfig({ placement }).placement, placement);
  }

  // And a saved config re-reads as itself, so a merchant's choice does
  // not quietly change under them on the next load.
  const chosen = { ...defaultWidgetConfig(), placement: "floating_button" as const };
  assert.deepEqual(parseWidgetConfig(chosen), chosen);
});

test("the entry label and the greeting are separate fields", () => {
  // They are read at different moments — one before Disc opens, one
  // after — so setting one must never move the other. Collapsing them
  // would put a question ("What are you looking for?") on a button.
  const parsed = parseWidgetConfig({ entryLabel: "Your Style" });
  assert.equal(parsed.entryLabel, "Your Style");
  assert.equal(parsed.greeting, defaultWidgetConfig().greeting);

  const other = parseWidgetConfig({ greeting: "Tell us the occasion" });
  assert.equal(other.greeting, "Tell us the occasion");
  assert.equal(other.entryLabel, DEFAULT_ENTRY_LABEL);

  // Different caps, because a caption and a prompt are different things.
  assert.ok(ENTRY_LABEL_MAX < GREETING_MAX);
  assert.equal(parseWidgetConfig({ greeting: "y".repeat(500) }).greeting.length, GREETING_MAX);
});
