/**
 * Coverage audit: can the shopper actually see and hit every control?
 *
 * A different question from devices_test.js, which asks "does it fit".
 * **A container that scrolls is not the same as content that is
 * visible** — that distinction is what this exists to catch, and CSS
 * that merely fits can still fail it.
 *
 * At every stage it uses shadowRoot.elementFromPoint() on each control's
 * own centre to prove nothing is stacked on top of it, flags text
 * clipped without an ellipsis rule, flags overlapping sibling blocks in
 * .disc-detail-ui, and scrolls the results to the bottom to confirm the
 * last product row isn't parked under the bar.
 *
 *   node frontend/tests/coverage_test.js     (with the backend on :8000)
 */
const { chromium, devices } = require("/opt/node22/lib/node_modules/playwright");
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

const MATRIX = [
  { name: "iPhone SE", ctx: devices["iPhone SE"] },
  { name: "iPhone 12", ctx: devices["iPhone 12"] },
  { name: "iPhone 12 landscape", ctx: devices["iPhone 12 landscape"] },
  { name: "iPad Mini", ctx: devices["iPad Mini"] },
  { name: "iPad Pro 11", ctx: devices["iPad Pro 11"] },
  { name: "desktop 1440", ctx: { viewport: { width: 1440, height: 900 } } },
];

// A control is "covered" if the topmost element at its own centre isn't it
// or one of its descendants — i.e. a real user click would miss it.
const audit = (selectors) => {
  const sr = document.querySelector("disc-search-bar").shadowRoot;
  const out = [];
  selectors.forEach((sel) => {
    sr.querySelectorAll(sel).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const label = sel + (i ? `[${i}]` : "");
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        out.push(`${label} outside viewport`);
        return;
      }
      const hit = sr.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) {
        out.push(`${label} covered by ${hit ? hit.className || hit.tagName : "nothing"}`);
      }
    });
  });
  return out;
};

// Text that has been clipped without an ellipsis rule reads as jumbled.
const clipped = () => {
  const sr = document.querySelector("disc-search-bar").shadowRoot;
  const bad = [];
  sr.querySelectorAll(".disc-buy-title, .disc-buy-price, .disc-buy-colour, .disc-chip, .disc-btn, .disc-card-title")
    .forEach((el) => {
      const cs = getComputedStyle(el);
      const ellipsis = cs.textOverflow === "ellipsis";
      if (!ellipsis && el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className} text clipped`);
      if (el.scrollHeight > el.clientHeight + 1 && cs.overflow !== "visible") bad.push(`${el.className} text vertically clipped`);
    });
  return bad;
};

// Sibling blocks in the detail column must not overlap each other.
const overlaps = () => {
  const sr = document.querySelector("disc-search-bar").shadowRoot;
  const els = [...sr.querySelectorAll(".disc-detail-ui > *, .disc-detail-ui .disc-chip-panel")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height; });
  const bad = [];
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
      const ov = !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
      if (ov) bad.push(`${els[i].className} overlaps ${els[j].className}`);
    }
  }
  return bad;
};

(async () => {
  await new Promise((r) => server.listen(5580, r));
  const browser = await chromium.launch({ executablePath: process.env.DISC_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const problems = [];

  for (const dev of MATRIX) {
    const ctx = await browser.newContext(dev.ctx);
    const page = await ctx.newPage();
    const vp = page.viewportSize();
    const issues = [];

    await page.goto("http://localhost:5580/test.html");
    await page.waitForSelector("disc-search-bar", { state: "attached" });
    await page.waitForTimeout(800);

    // idle
    (await page.evaluate(audit, [".disc-plus", ".disc-send", ".disc-input"]))
      .forEach((i) => issues.push("idle: " + i));

    // results
    await page.evaluate(() => {
      const sr = document.querySelector("disc-search-bar").shadowRoot;
      const ta = sr.querySelector(".disc-input"); ta.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(ta, "knitwear");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector(".disc-send").click());
    await page.waitForFunction(() => document.querySelector("disc-search-bar").shadowRoot.querySelectorAll(".disc-card").length > 0, { timeout: 25000 });
    await page.waitForTimeout(600);
    (await page.evaluate(audit, [".disc-close-canvas", ".disc-send", ".disc-plus"]))
      .forEach((i) => issues.push("results: " + i));
    (await page.evaluate(clipped)).forEach((i) => issues.push("results: " + i));

    // the last row of products must be reachable, not stuck under the bar
    const lastCardOk = await page.evaluate(() => {
      const sr = document.querySelector("disc-search-bar").shadowRoot;
      const body = sr.querySelector(".disc-body");
      body.scrollTop = body.scrollHeight;
      return new Promise((res) => setTimeout(() => {
        const cards = sr.querySelectorAll(".disc-card");
        const last = cards[cards.length - 1].getBoundingClientRect();
        const bar = sr.querySelector(".disc-bar").getBoundingClientRect();
        res(last.bottom <= bar.top + 1);
      }, 350));
    });
    if (!lastCardOk) issues.push("results: last product row sits under the bar");

    // detail
    await page.evaluate(() => {
      const sr = document.querySelector("disc-search-bar").shadowRoot;
      sr.querySelector(".disc-body").scrollTop = 0;
      sr.querySelector(".disc-card").click();
    });
    await page.waitForFunction(() => document.querySelector("disc-search-bar").shadowRoot.querySelector(".disc-buy"), { timeout: 25000 });
    await page.waitForTimeout(1100);
    (await page.evaluate(audit, [".disc-chip", ".disc-buy-full [data-add-to-cart]", "[data-select-size]", ".disc-buy-full .disc-buy-close", ".disc-back", ".disc-close-canvas", ".disc-heart--lg"]))
      .forEach((i) => issues.push("detail: " + i));
    (await page.evaluate(clipped)).forEach((i) => issues.push("detail: " + i));
    (await page.evaluate(overlaps)).forEach((i) => issues.push("detail: " + i));

    // sizes revealed
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector("[data-select-size]").click());
    await page.waitForTimeout(350);
    (await page.evaluate(audit, [".disc-size", ".disc-buy-full [data-add-to-cart]"]))
      .forEach((i) => issues.push("sizes: " + i));
    (await page.evaluate(overlaps)).forEach((i) => issues.push("sizes: " + i));

    // look expanded — the tallest, most crowded state
    await page.evaluate(() => document.querySelector("disc-search-bar").shadowRoot.querySelector('[data-chip="style"]').click());
    await page.waitForTimeout(500);
    (await page.evaluate(audit, [".disc-look-card", ".disc-look-arrow", ".disc-buy-compact [data-add-to-cart]", ".disc-buy-compact .disc-buy-close", ".disc-chip"]))
      .forEach((i) => issues.push("look: " + i));
    (await page.evaluate(clipped)).forEach((i) => issues.push("look: " + i));
    (await page.evaluate(overlaps)).forEach((i) => issues.push("look: " + i));

    console.log(`${issues.length ? "FAIL" : "ok  "} ${dev.name.padEnd(20)} ${vp.width}x${vp.height}`);
    [...new Set(issues)].forEach((i) => console.log("       - " + i));
    if (issues.length) problems.push(dev.name);
    await page.screenshot({ path: `${OUT}/cov-${dev.name.replace(/\s+/g, "-")}.png` });
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(problems.length ? `\nFAILING: ${problems.join(", ")}` : "\nNOTHING COVERED OR CLIPPED");
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
