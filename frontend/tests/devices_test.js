/**
 * Device matrix: does the whole boutique flow fit every real screen?
 *
 * Runs idle -> results -> detail -> look-expanded against 14 real device
 * profiles and asserts the bar and buy card stay inside the viewport, Add
 * to cart stays reachable, the page never scrolls horizontally, and no JS
 * errors fire. The short-landscape and narrow-phone cases have caught
 * several real bugs; run this after any CSS change.
 *
 *   node frontend/tests/devices_test.js      (with the backend on :8000)
 */
const pw = require("/opt/node22/lib/node_modules/playwright");
const { chromium, devices } = pw;
const path = require("path"), http = require("http"), fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = process.env.DISC_TEST_OUT || require("os").tmpdir();

const server = http.createServer((q, r) => {
  let p = q.url === "/" ? "/test.html" : q.url;
  p = path.join(ROOT, p.split("?")[0]);
  fs.readFile(p, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    const x = path.extname(p);
    r.writeHead(200, { "Content-Type": x === ".js" ? "application/javascript" : x === ".html" ? "text/html" : "text/plain" });
    r.end(d);
  });
});

// Real device profiles plus the awkward sizes that aren't in the catalogue.
const MATRIX = [
  { name: "iPhone SE",            ctx: devices["iPhone SE"] },
  { name: "iPhone 12",            ctx: devices["iPhone 12"] },
  { name: "iPhone 14 Pro Max",    ctx: devices["iPhone 14 Pro Max"] },
  { name: "iPhone 12 landscape",  ctx: devices["iPhone 12 landscape"] },
  { name: "Pixel 7",              ctx: devices["Pixel 7"] },
  { name: "Galaxy S9+",           ctx: devices["Galaxy S9+"] },
  { name: "iPad Mini",            ctx: devices["iPad Mini"] },
  { name: "iPad Mini landscape",  ctx: devices["iPad Mini landscape"] },
  { name: "iPad Pro 11",          ctx: devices["iPad Pro 11"] },
  { name: "iPad Pro 11 landscape",ctx: devices["iPad Pro 11 landscape"] },
  { name: "narrow 320",           ctx: { viewport: { width: 320, height: 568 } } },
  { name: "laptop 1024x640",      ctx: { viewport: { width: 1024, height: 640 } } },
  { name: "desktop 1440x900",     ctx: { viewport: { width: 1440, height: 900 } } },
  { name: "desktop 1920x1080",    ctx: { viewport: { width: 1920, height: 1080 } } },
];

const geo = () => {
  const sr = document.querySelector("disc-search-bar").shadowRoot;
  const g = (sel) => {
    const el = sr.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
  };
  return {
    bar: g(".disc-bar"),
    buy: g(".disc-buy"),
    grid: sr.querySelector(".disc-grid")
      ? getComputedStyle(sr.querySelector(".disc-grid")).gridTemplateColumns.split(" ").length : 0,
    cards: sr.querySelectorAll(".disc-card").length,
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
};

const fits = (box, w, h) => !box || (box.l >= -1 && box.r <= w + 1 && box.t >= -1 && box.b <= h + 1);

(async () => {
  await new Promise((r) => server.listen(5560, r));
  const browser = await chromium.launch({ executablePath: process.env.DISC_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const problems = [];

  for (const dev of MATRIX) {
    const context = await browser.newContext(dev.ctx);
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) errs.push(m.text()); });

    const vp = page.viewportSize();
    await page.goto("http://localhost:5560/test.html");
    await page.waitForSelector("disc-search-bar", { state: "attached", timeout: 8000 });
    await page.waitForTimeout(800);

    const idle = await page.evaluate(geo);

    // search
    await page.evaluate(() => {
      const sr = document.querySelector("disc-search-bar").shadowRoot;
      const ta = sr.querySelector(".disc-input"); ta.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(ta, "knitwear");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector(".disc-send").click());
    await page.waitForFunction(
      () => document.querySelector("disc-search-bar").shadowRoot.querySelectorAll(".disc-card").length > 0,
      { timeout: 25000 });
    await page.waitForTimeout(600);
    const results = await page.evaluate(geo);

    // detail
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector(".disc-card").click());
    await page.waitForFunction(
      () => document.querySelector("disc-search-bar").shadowRoot.querySelector(".disc-buy"),
      { timeout: 25000 });
    await page.waitForTimeout(1100);
    const detail = await page.evaluate(geo);

    // look expanded — the tallest state
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector('[data-chip="style"]').click());
    await page.waitForTimeout(500);
    const look = await page.evaluate(geo);
    const addReachable = await page.evaluate(() => {
      const sr = document.querySelector("disc-search-bar").shadowRoot;
      const btn = sr.querySelector(".disc-buy-compact [data-add-to-cart]")
               || sr.querySelector(".disc-buy-full [data-add-to-cart]");
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0;
    });

    const issues = [];
    if (!fits(idle.bar, vp.width, vp.height)) issues.push(`idle bar outside viewport ${JSON.stringify(idle.bar)}`);
    if (!fits(results.bar, vp.width, vp.height)) issues.push(`results bar outside viewport`);
    if (!results.cards) issues.push("no result cards");
    if (!fits(detail.buy, vp.width, vp.height)) issues.push(`detail buy card outside viewport ${JSON.stringify(detail.buy)}`);
    if (!fits(look.buy, vp.width, vp.height)) issues.push(`look-state buy card outside viewport ${JSON.stringify(look.buy)}`);
    if (!addReachable) issues.push("Add to cart not reachable with look open");
    if (idle.docOverflow || results.docOverflow) issues.push("page scrolls horizontally");
    if (errs.length) issues.push("js errors: " + errs.join("; "));

    const status = issues.length ? "FAIL" : "ok";
    console.log(`${status.padEnd(4)} ${dev.name.padEnd(24)} ${String(vp.width).padStart(4)}x${String(vp.height).padEnd(4)} cols=${results.grid} cards=${results.cards}`);
    issues.forEach((i) => console.log(`       - ${i}`));
    if (issues.length) problems.push(dev.name);

    if (["iPhone SE", "iPad Mini", "iPad Pro 11 landscape", "narrow 320"].includes(dev.name)) {
      await page.screenshot({ path: `${OUT}/dev-${dev.name.replace(/\s+/g, "-")}.png` });
    }
    await context.close();
  }

  await browser.close(); server.close();
  console.log(problems.length ? `\nFAILING: ${problems.join(", ")}` : "\nALL DEVICES PASS");
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
