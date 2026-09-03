/**
 * Disc must fail CLOSED when it cannot reach its own backend.
 *
 * The failure this exists to prevent, found in the Phase 0 audit and
 * fixed alongside this file:
 *
 *   The boot guard read `status && status.active === false`. An
 *   unresolved status — a refused connection, a 500, a malformed body —
 *   is not an object, so every guard was skipped and control fell
 *   through to hideNativeSearch(). A Disc outage therefore took the
 *   merchant's own search box away on every page of their store, at
 *   once, for the length of the incident, on their site where we could
 *   not see it.
 *
 * `dormant_test.js` covers the *lapsed tenant* case and needs a live
 * billing-enabled backend. This covers the *unreachable backend* case
 * and deliberately needs no backend at all: it serves the widget from
 * disk against a status endpoint it can make fail on demand, so it runs
 * anywhere, including in `npm run verify`.
 *
 *   node frontend/tests/outage_test.js
 *
 * The invariant, in every failure mode:
 *
 *   backend unavailable
 *     -> the native Shopify search stays usable
 *     -> no uncaught error
 *     -> no permanent spinner
 *     -> Disc recovers on a later page load
 */

const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const WIDGET = fs.readFileSync(
  path.join(__dirname, "..", "disc-widget.js"),
  "utf8",
);

let failures = 0;
let checks = 0;
function check(cond, desc, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  ✗ ${desc}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * How the stub status endpoint should behave for the next page load.
 * Mutated between cases; the page always points at the same origin.
 */
let mode = "ok";

function freePort() {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  const PORT = await freePort();
  const ORIGIN = `http://127.0.0.1:${PORT}`;

  // A minimal fake storefront: one native search input, the widget, and
  // a config pointing its API at this same server.
  const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<form role="search"><input type="search" name="q" placeholder="Search store..."></form>
<script>window.DiscConfig = { apiUrl: ${JSON.stringify(ORIGIN)}, siteKey: "disc_test" };</script>
<script src="/disc-widget.js"></script>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(PAGE);
    }
    if (req.url === "/disc-widget.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(WIDGET);
    }

    // The boot status endpoint, under test.
    if (req.url.includes("/sites/") && req.url.includes("/status")) {
      switch (mode) {
        case "ok":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ active: true, catalog_status: "ready", widget_status: "live" }),
          );
        case "inactive":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ active: false, catalog_status: "unknown" }));
        case "not_activated":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ active: true, catalog_status: "ready", widget_status: "inactive" }),
          );
        case "500":
          res.writeHead(500);
          return res.end("upstream exploded");
        case "garbage":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end("<html>this is not json</html>");
        case "empty":
          // 200 with a body that omits `active` entirely — the shape a
          // half-deployed or proxied backend can produce.
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end("{}");
        case "hang":
          // Never responds, never closes. The worst outage: not a
          // failure the browser can detect, just silence.
          return;
        case "reset":
          return req.socket.destroy();
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const browser = await chromium.launch({
    executablePath:
      process.env.DISC_CHROMIUM ||
      "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });

  try {
    // ---- every way the backend can fail the shopper ----
    const FAILURES = [
      ["500", "backend returns 500"],
      ["garbage", "backend returns a non-JSON body"],
      ["empty", "backend returns 200 with no `active` field"],
      ["reset", "backend resets the connection"],
      ["hang", "backend accepts and never responds"],
    ];

    console.log("── failing closed");
    for (const [failureMode, label] of FAILURES) {
      mode = failureMode;
      const state = await observe(browser, ORIGIN);

      // THE INVARIANT. Everything else in this file is secondary.
      check(
        state.nativeVisible,
        `${label}: the merchant's own search stays visible`,
      );
      check(!state.barMounted, `${label}: Disc does not attach`);
      check(
        state.errors.length === 0,
        `${label}: no uncaught error`,
        state.errors[0],
      );
      // "No permanent spinner": with nothing mounted there is no Disc UI
      // at all, so there is nothing that can be stuck loading.
      check(
        !state.discVisible,
        `${label}: no Disc UI left on screen`,
      );
    }

    // ---- the tenant states that were already handled ----
    console.log("── tenant states");

    mode = "inactive";
    let state = await observe(browser, ORIGIN);
    check(state.nativeVisible, "lapsed tenant: native search stays visible");
    check(!state.barMounted, "lapsed tenant: Disc does not attach");

    mode = "not_activated";
    state = await observe(browser, ORIGIN);
    check(
      state.nativeVisible,
      "not yet activated: native search stays visible",
    );
    check(!state.barMounted, "not yet activated: Disc does not attach");

    // ---- proof the test is not vacuous ----
    console.log("── the happy path still works");

    mode = "ok";
    state = await observe(browser, ORIGIN);
    check(state.barMounted, "live tenant: Disc attaches");
    check(
      !state.nativeVisible,
      "live tenant: the native search is hidden, as designed",
    );
    check(state.errors.length === 0, "live tenant: no uncaught error", state.errors[0]);

    // ---- P0.2: a hung backend must not hang the shopper ----
    //
    // The distinction that matters: a REFUSED connection fails fast on
    // its own, so it proves nothing about timeouts. A backend that
    // accepts the socket and then goes silent is the case where an
    // unbounded fetch waits forever, and it is the realistic one — an
    // overloaded deployment, a black-holed route, a captive portal.
    console.log("── bounded execution");

    mode = "hang";
    const started = Date.now();
    const hung = await observe(browser, ORIGIN, { settleMs: 6000 });
    const elapsed = Date.now() - started;

    check(hung.nativeVisible, "hung backend: native search stays visible");
    check(!hung.barMounted, "hung backend: Disc does not attach");
    // The boot budget is 3s. Observing for 6s and finding the page fully
    // settled proves the request was abandoned rather than still open.
    check(
      elapsed < 20000,
      "hung backend: the page settles rather than waiting forever",
      `${elapsed}ms`,
    );
    check(
      hung.pendingRequests === 0,
      "hung backend: no request left in flight after the budget",
      `${hung.pendingRequests} pending`,
    );

    // ---- recovery ----
    console.log("── recovery");

    mode = "reset";
    const broken = await observe(browser, ORIGIN);
    check(broken.nativeVisible, "during an outage: native search usable");

    mode = "ok";
    const recovered = await observe(browser, ORIGIN);
    // A storefront is a multi-page experience, so the next page view is
    // the recovery path. Nothing is poisoned by the failed load.
    check(
      recovered.barMounted,
      "after recovery: the next page load attaches normally",
    );
    check(
      !recovered.nativeVisible,
      "after recovery: Disc takes over again",
    );
  } finally {
    await browser.close();
    server.close();
  }

  console.log("");
  if (failures === 0) {
    console.log(`✓ ${checks} checks passed`);
  } else {
    console.log(`✗ ${failures} of ${checks} checks failed`);
    process.exitCode = 1;
  }
}

/**
 * Load the fake storefront once and report what a shopper would see.
 *
 * A fresh context per case so no state — and no HTTP cache — carries
 * between them.
 */
async function observe(browser, origin, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Track requests that never settle, so "bounded execution" is measured
  // rather than assumed. A request Disc abandoned counts as finished:
  // an aborted fetch fires requestfailed.
  let pendingRequests = 0;
  page.on("request", () => pendingRequests++);
  page.on("requestfinished", () => pendingRequests--);
  page.on("requestfailed", () => pendingRequests--);

  // Uncaught exceptions and unhandled rejections. These must be zero:
  // they are Disc failing to handle its own failure.
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Console errors, minus the browser's own network log. A 500 or a
  // reset connection produces a console entry no matter how correctly
  // the page handles it — that line is Chromium reporting the transport,
  // not Disc throwing. Filtering it is not weakening the check: an
  // unhandled rejection or a real JS error still lands here.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/Failed to load resource|net::ERR_/.test(text)) return;
    errors.push(text);
  });

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  // Long enough for the boot fetch plus several scanner ticks, so a
  // late hide would be caught rather than raced past. The hang case
  // waits longer still, to see past the 3s config budget.
  await page.waitForTimeout(opts.settleMs || 2500);

  const state = await page.evaluate(() => {
    const native = document.querySelector('input[name="q"]');
    const bar = document.querySelector("disc-search-bar");
    return {
      barMounted: !!bar,
      nativeVisible: !!native && getComputedStyle(native).visibility !== "hidden",
      // Anything Disc rendered that a shopper could see — the check that
      // "no permanent spinner" is really true.
      discVisible: !!bar && !!bar.shadowRoot && bar.shadowRoot.childElementCount > 0,
    };
  });

  await context.close();
  return { ...state, errors, pendingRequests };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
