/**
 * The storefront entry point: `placement` must be true on the page.
 *
 * The bug this closes: `placement` was a validated, persisted,
 * merchant-settable config value — offered in the dashboard, stored per
 * tenant, served to the storefront — and `frontend/disc-widget.js`
 * contained no reference to it. A merchant who chose "floating button"
 * got a docked bar and no error anywhere. Configuration a merchant can
 * set and the product then ignores is worse than configuration that does
 * not exist.
 *
 *   node frontend/tests/entry_test.js
 *
 * Run against the widget on disk with a stub backend, like
 * `outage_test.js`, so it needs no Convex deployment and can live in
 * `npm run verify`. What it asserts:
 *
 *   bottom_bar      renders exactly what every install rendered before
 *   floating_button renders a distinct control carrying the merchant's
 *                   own label, and that control opens the same Disc
 *   two tenants     get their own config and cannot see each other's
 *   anything else   degrades to bottom_bar, and never past P0.1 — a
 *                   storefront must keep its own search when Disc is
 *                   unreachable or switched off
 */

const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const WIDGET = fs.readFileSync(path.join(__dirname, "..", "disc-widget.js"), "utf8");

let failures = 0;
let checks = 0;
function check(cond, desc, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  ✗ ${desc}${detail ? ` — ${detail}` : ""}`);
  }
}

const BASE = {
  active: true,
  catalog_status: "ready",
  widget_status: "live",
  public_key: "disc_stub",
};

/**
 * Two tenants on one backend, with deliberately different experiences.
 *
 * Brand A wants the floating button and has written its own copy; Brand
 * B is on the default bar. The whole point of a config keyed by shop is
 * that neither can see the other's, so both are served by the same
 * process and asserted separately.
 */
const TENANTS = {
  "brand-a.myshopify.com": {
    ...BASE,
    widget_config: {
      enabled: true,
      placement: "floating_button",
      greeting: "Tell us the occasion",
      entryLabel: "Your Style",
      workflows: ["PRODUCT_SEARCH"],
      design: { density: "airy", motion: "subtle", cardStyle: "editorial", cornerRadius: "small" },
    },
  },
  "brand-b.myshopify.com": {
    ...BASE,
    widget_config: {
      enabled: true,
      placement: "bottom_bar",
      greeting: "What are you looking for?",
      entryLabel: "Disc",
      workflows: ["PRODUCT_SEARCH"],
      design: { density: "airy", motion: "subtle", cardStyle: "editorial", cornerRadius: "small" },
    },
  },
  // A config whose placement is not in the closed set and whose label is
  // not a string. The shape a stale cache, a proxy, or a backend mid-
  // deploy can produce — and it must resolve to the bar, not to nothing.
  "brand-broken.myshopify.com": {
    ...BASE,
    widget_config: {
      enabled: true,
      placement: "floating-button-please",
      greeting: 12,
      entryLabel: { toString: "nope" },
      workflows: "all",
      design: null,
    },
  },
  // A label the server would never have stored: 500 characters with a
  // newline in it. The stub serves it anyway, which is the point — this
  // is the case where something between the server and the browser is
  // wrong, and the renderer is the last place the caption can still be
  // bounded before it becomes a brand's storefront.
  "brand-long.myshopify.com": {
    ...BASE,
    widget_config: {
      enabled: true,
      placement: "floating_button",
      entryLabel: "Shop\nthe\tcollection " + "x".repeat(500),
      workflows: ["PRODUCT_SEARCH"],
    },
  },
  // Installed but never switched on (spec §13): the storefront should
  // look untouched, with neither entry point on it.
  "brand-off.myshopify.com": {
    ...BASE,
    widget_status: "inactive",
    widget_config: { enabled: false, placement: "floating_button", entryLabel: "Your Style" },
  },
};

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

/** When true the config endpoint is dead, whatever the shop asks for. */
let outage = false;

async function main() {
  const PORT = await freePort();
  const ORIGIN = `http://127.0.0.1:${PORT}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);

    if (url.pathname === "/disc-widget.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(WIDGET);
    }

    if (url.pathname === "/storefront/config") {
      if (outage) {
        res.writeHead(500);
        return res.end("upstream exploded");
      }
      const tenant = TENANTS[url.searchParams.get("shop")];
      res.writeHead(200, { "Content-Type": "application/json" });
      // An unknown shop resolves as inactive rather than 404 — the same
      // safe direction the real route takes.
      return res.end(JSON.stringify(tenant ?? { active: false, catalog_status: "unknown" }));
    }

    if (url.pathname === "/") {
      const shop = url.searchParams.get("shop") ?? "";
      res.writeHead(200, { "Content-Type": "text/html" });
      // A minimal fake storefront: the theme's own search, and Disc told
      // only which shop it is on — exactly what the app embed passes.
      return res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<form role="search"><input type="search" name="q" placeholder="Search store..."></form>
<script>window.DiscConfig = { apiUrl: ${JSON.stringify(ORIGIN)}, shopDomain: ${JSON.stringify(shop)} };</script>
<script src="/disc-widget.js"></script>`);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const browser = await chromium.launch({
    executablePath:
      process.env.DISC_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });

  try {
    // ---- the placement every install already had -------------------
    console.log("── bottom_bar is unchanged");
    {
      const { state, close } = await open(browser, ORIGIN, "brand-b.myshopify.com");
      check(state.barMounted, "bottom_bar: Disc attaches");
      check(state.barVisible, "bottom_bar: the docked bar is on screen");
      check(!state.entryVisible, "bottom_bar: no floating button is rendered");
      check(
        !state.nativeVisible,
        "bottom_bar: the theme's own search is hidden, as designed",
      );
      check(state.errors.length === 0, "bottom_bar: no uncaught error", state.errors[0]);
      await close();
    }

    // ---- the placement that was declared and ignored ---------------
    console.log("── floating_button renders");
    {
      const { page, state, close } = await open(browser, ORIGIN, "brand-a.myshopify.com");
      check(state.entryMounted, "floating_button: the entry control exists");
      check(state.entryVisible, "floating_button: the entry control is on screen");
      check(
        !state.barVisible,
        "floating_button: the docked bar is NOT also shown — one entry point at a time",
      );
      check(state.errors.length === 0, "floating_button: no uncaught error", state.errors[0]);

      // The merchant's own words, not ours.
      check(
        state.entryText === "Your Style",
        "floating_button: the merchant's label is what a shopper reads",
        JSON.stringify(state.entryText),
      );

      // Nothing is stacked over it: a control a shopper cannot hit is
      // not an entry point. Same question coverage_test.js asks.
      check(state.entryHittable, "floating_button: nothing covers the control");

      // ---- and it opens the same Disc ----
      // A real mouse click at the control's own coordinates, not
      // element.click() — the host element is pointer-events: none while
      // Disc is idle, so only a genuine hit test proves the control is
      // reachable rather than merely present.
      //
      // Guarded, so that a regression which stops the control rendering
      // reports as the failures above rather than aborting the run on a
      // null box and hiding every case after it.
      const box = state.entryBox;
      if (!box) {
        check(false, "click: no entry control to click — cases below skipped");
      } else {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
        const after = await read(page);

        check(after.barVisible, "click: the bar a shopper types into is revealed");
        check(!after.entryVisible, "click: the entry control stands down");
        check(after.inputFocused, "click: the bar is focused, ready to type");
        check(after.errors.length === 0, "click: no uncaught error", after.errors[0]);

        // The merchant's greeting reaches the bar it belongs to — a
        // separate field from the button caption, and visibly so.
        check(
          after.inputPlaceholder === "Tell us the occasion",
          "click: the greeting is the bar's placeholder, not the button's label",
          JSON.stringify(after.inputPlaceholder),
        );

        // Reversible: Escape returns the storefront to the button rather
        // than leaving a bar the shopper never asked to keep.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        const back = await read(page);
        check(back.entryVisible, "escape: the entry control comes back");
        check(!back.barVisible, "escape: the bar stands down again");
      }

      await close();
    }

    // ---- one backend, two brands -----------------------------------
    console.log("── configuration is tenant-specific");
    {
      const a = await open(browser, ORIGIN, "brand-a.myshopify.com");
      const b = await open(browser, ORIGIN, "brand-b.myshopify.com");

      check(
        a.state.entryVisible && !b.state.entryVisible,
        "Brand A's floating button does not appear on Brand B",
      );
      check(
        b.state.barVisible && !a.state.barVisible,
        "Brand B's docked bar does not appear on Brand A",
      );
      check(
        a.state.entryText === "Your Style",
        "Brand A reads its own label",
        JSON.stringify(a.state.entryText),
      );
      check(
        b.state.inputPlaceholder === "What are you looking for?",
        "Brand B reads its own greeting",
        JSON.stringify(b.state.inputPlaceholder),
      );

      await a.close();
      await b.close();
    }

    // ---- a config nobody can read ----------------------------------
    console.log("── malformed configuration fails safely");
    {
      const { state, close } = await open(browser, ORIGIN, "brand-broken.myshopify.com");
      // Degrade to the presentation Disc has always had. The failure to
      // avoid is the native search hidden with nothing put in its place.
      check(state.barMounted, "malformed config: Disc still attaches");
      check(state.barVisible, "malformed config: it degrades to the docked bar");
      check(!state.entryVisible, "malformed config: no unrecognised entry point is rendered");
      check(
        state.errors.length === 0,
        "malformed config: no uncaught error",
        state.errors[0],
      );
      // A non-string label must never be rendered — "[object Object]"
      // on a brand's storefront is the visible form of this bug.
      check(
        !/object Object/.test(state.entryText ?? ""),
        "malformed config: a non-string label is not rendered",
        JSON.stringify(state.entryText),
      );
      check(
        typeof state.inputPlaceholder === "string" &&
          state.inputPlaceholder.length > 0 &&
          !/^12$/.test(state.inputPlaceholder),
        "malformed config: a non-string greeting falls back",
        JSON.stringify(state.inputPlaceholder),
      );
      await close();
    }

    // ---- the caption is bounded where it is rendered ---------------
    console.log("── an unbounded label cannot reach the storefront");
    {
      const { state, close } = await open(browser, ORIGIN, "brand-long.myshopify.com");
      check(state.entryVisible, "over-long label: the control still renders");

      const label = state.entryText ?? "";
      // Capped in the browser as well as on the server. Without this the
      // control stretches across the storefront, or the theme's own
      // layout does, depending on whose CSS loses.
      check(
        label.length <= 32,
        "over-long label: the caption is capped where it is rendered",
        `${label.length} chars`,
      );
      // And normalised: a newline or a tab in a single-line pill is a
      // broken control, not a formatting choice.
      check(
        !/[\n\r\t]/.test(label),
        "over-long label: no line breaks survive into the caption",
        JSON.stringify(label),
      );

      // The control must still fit the viewport it is on — a caption is
      // not allowed to push a merchant's page into horizontal scroll.
      check(
        state.entryBox && state.entryBox.x >= 0 && state.entryBox.width <= 1280,
        "over-long label: the control stays inside the viewport",
        state.entryBox && JSON.stringify(state.entryBox),
      );
      check(!state.pageScrollsX, "over-long label: the page does not scroll sideways");
      await close();
    }

    // ---- the new control across real viewports ---------------------
    //
    // `devices_test.js` is where widget layout is normally proven, but
    // it drives the full shopper flow and so needs a live backend with
    // an ingested catalog. This is the part of its question that applies
    // to the one element this phase adds, asked where it can be asked
    // without one: at the narrowest phone in that matrix, at a short
    // landscape phone, and at desktop.
    console.log("── the control fits real viewports");
    for (const [w, h, label] of [
      [320, 568, "320px phone"],
      [740, 360, "short landscape"],
      [1440, 900, "desktop"],
    ]) {
      const { state, close } = await open(browser, ORIGIN, "brand-long.myshopify.com", {
        viewport: { width: w, height: h },
      });
      check(state.entryVisible, `${label}: the control renders`);
      check(
        state.entryBox &&
          state.entryBox.x >= 0 &&
          state.entryBox.x + state.entryBox.width <= w &&
          state.entryBox.y >= 0 &&
          state.entryBox.y + state.entryBox.height <= h,
        `${label}: the control is fully inside the viewport`,
        state.entryBox && JSON.stringify(state.entryBox),
      );
      check(state.entryHittable, `${label}: the control is reachable`);
      // A widget must never make a merchant's page scroll sideways.
      check(!state.pageScrollsX, `${label}: the page does not scroll sideways`);
      await close();
    }

    // ---- P0.1, which this phase must not weaken --------------------
    console.log("── the storefront still comes first");
    {
      outage = true;
      const { state, close } = await open(browser, ORIGIN, "brand-a.myshopify.com");
      // Even for a tenant who chose the floating button: an entry point
      // Disc cannot stand behind must not be put on a storefront, and
      // the theme's own search must survive the incident.
      check(state.nativeVisible, "backend outage: the theme's own search stays usable");
      check(!state.entryVisible, "backend outage: no entry control is rendered");
      check(!state.barVisible, "backend outage: no bar is rendered");
      check(state.errors.length === 0, "backend outage: no uncaught error", state.errors[0]);
      await close();
      outage = false;
    }
    {
      const { state, close } = await open(browser, ORIGIN, "brand-off.myshopify.com");
      check(state.nativeVisible, "not activated: the theme's own search stays usable");
      check(
        !state.entryVisible,
        "not activated: a floating button configured but not switched on stays off",
      );
      check(!state.barVisible, "not activated: no bar is rendered");
      await close();
    }
    {
      const { state, close } = await open(browser, ORIGIN, "nobody.myshopify.com");
      check(state.nativeVisible, "unknown shop: the theme's own search stays usable");
      check(!state.entryVisible, "unknown shop: no entry control is rendered");
      await close();
    }
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
 * Load the fake storefront for one shop and hold the page open, so a
 * case can interact with it rather than only observe it.
 */
async function open(browser, origin, shop, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Chromium reporting the transport, not Disc throwing — the same
    // filter outage_test.js uses, and it still catches a real rejection.
    if (/Failed to load resource|net::ERR_/.test(text)) return;
    errors.push(text);
  });
  page._discErrors = errors;

  await page.goto(`${origin}/?shop=${encodeURIComponent(shop)}`, {
    waitUntil: "domcontentloaded",
  });
  // Long enough for the boot fetch plus several scanner ticks, so a late
  // hide is caught rather than raced past.
  await page.waitForTimeout(1200);

  return { page, state: await read(page), close: () => context.close() };
}

/** What a shopper on this page can actually see and reach. */
async function read(page) {
  const state = await page.evaluate(() => {
    const native = document.querySelector('input[name="q"]');
    const bar = document.querySelector("disc-search-bar");
    const root = bar && bar.shadowRoot;
    const entry = root && root.querySelector(".disc-entry");
    const pill = root && root.querySelector(".disc-bar");
    const input = root && root.querySelector(".disc-input");

    // `hidden` plus a real box: an element can be un-hidden and still be
    // zero-sized or display:none from a rule, which a shopper cannot
    // tell apart from absent.
    const shown = (el) => {
      if (!el || el.hidden) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };

    let entryBox = null;
    let entryHittable = false;
    if (shown(entry)) {
      const r = entry.getBoundingClientRect();
      entryBox = { x: r.x, y: r.y, width: r.width, height: r.height };
      // Ask the shadow root what is at the control's own centre. If it
      // is not the button or something inside it, something is stacked
      // on top and the control is decorative.
      const hit = root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      entryHittable = !!hit && (hit === entry || entry.contains(hit));
    }

    return {
      barMounted: !!bar,
      nativeVisible: !!native && getComputedStyle(native).visibility !== "hidden",
      entryMounted: !!entry,
      entryVisible: shown(entry),
      entryText: entry ? entry.textContent : null,
      entryBox,
      entryHittable,
      barVisible: shown(pill),
      inputPlaceholder: input ? input.placeholder : null,
      inputFocused: !!input && root.activeElement === input,
      pageScrollsX:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  return { ...state, errors: page._discErrors };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
