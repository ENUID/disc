/**
 * Disc must never leave a storefront worse than it found it.
 *
 * Disc hides the theme's own search box, on the promise that its own bar
 * replaces it. If a subscription lapses — or a site key is wrong — that
 * promise is broken, and hiding the merchant's search box would leave
 * their shop with no way to search at all. This asserts the widget stays
 * dormant and the native input stays visible in exactly that case, and
 * that it does take over once the tenant is active again.
 *
 * Needs a backend started with billing enabled, e.g.
 *   STRIPE_SECRET_KEY=sk_test_fake uvicorn server:app --port 8001
 * then:
 *   DISC_API=http://localhost:8001 DISC_KEY=disc_... node frontend/tests/dormant_test.js
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const http = require("http");

const API = process.env.DISC_API || "http://localhost:8001";
const KEY = process.env.DISC_KEY;
if (!KEY) { console.error("set DISC_KEY to a site key on that backend"); process.exit(2); }

// A minimal fake storefront: one native search input, plus Disc's embed.
const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<form role="search"><input type="search" name="q" placeholder="Search store..."></form>
<script src="${API}/embed.js?k=${KEY}" defer></script>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(PAGE);
});

let failures = 0;
const check = (cond, desc) => {
  console.log((cond ? "PASS" : "FAIL") + ": " + desc);
  if (!cond) failures++;
};

async function observe(page) {
  await page.goto("http://localhost:5599/");
  // Long enough for the boot status fetch plus a couple of scanner ticks.
  await page.waitForTimeout(2500);
  return page.evaluate(() => ({
    barMounted: !!document.querySelector("disc-search-bar"),
    nativeVisible:
      getComputedStyle(document.querySelector('input[name="q"]')).visibility !== "hidden",
  }));
}

(async () => {
  await new Promise((r) => server.listen(5599, r));
  const browser = await chromium.launch({
    executablePath: process.env.DISC_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const status = await (await fetch(`${API}/sites/${KEY}/status`)).json();
  console.log(`tenant ${status.domain}: subscription=${status.subscription_status} active=${status.active}`);

  const state = await observe(page);
  if (status.active) {
    check(state.barMounted, "active tenant: Disc's bar mounts");
    check(!state.nativeVisible, "active tenant: the theme's own search input is hidden");
  } else {
    check(!state.barMounted, "inactive tenant: Disc stays dormant, no bar is mounted");
    check(
      state.nativeVisible,
      "inactive tenant: the theme's own search input is LEFT ALONE — the shop keeps its search"
    );
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nOK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
