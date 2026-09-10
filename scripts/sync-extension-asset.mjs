#!/usr/bin/env node
/**
 * Copy the widget into the theme app extension.
 *
 * Shopify requires the asset to physically live in the extension
 * directory, but `frontend/disc-widget.js` is the source of truth — it
 * is what the Playwright suites run against. A hand-maintained copy
 * would drift, and the failure mode is the worst kind: merchants get a
 * different widget from the one that was tested, silently and with
 * nothing to notice.
 *
 * Run before `shopify app deploy`. `--check` verifies without writing,
 * which is what `npm run verify` uses so a stale copy fails the build
 * rather than reaching a storefront.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "frontend", "disc-widget.js");
const target = join(root, "extensions", "disc-boutique", "assets", "disc-widget.js");

const banner =
  "/* Generated from frontend/disc-widget.js — do not edit here.\n" +
  "   Regenerate with: node scripts/sync-extension-asset.mjs */\n";

const expected = banner + readFileSync(source, "utf8");

if (process.argv.includes("--check")) {
  const actual = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (actual !== expected) {
    console.error("extension asset is stale — run: node scripts/sync-extension-asset.mjs");
    process.exit(1);
  }
  console.log("extension asset in sync");
} else {
  writeFileSync(target, expected);
  console.log(`synced -> ${target}`);
}
