/**
 * Dashboard render suite.
 *
 * The same question the widget's `coverage_test.js` asks, for the
 * merchant side: not "does it compile" but "does a merchant actually see
 * the right thing". A Next.js build passing proves the types line up and
 * nothing more.
 *
 * What it checks, over three scenarios (healthy / fresh install /
 * lapsed) and three viewports:
 *
 *   - every section renders with no console error and no failed request
 *   - the page never scrolls sideways
 *   - the numbers that matter reach the page (not just "a number")
 *   - §18: a status is never rendered as progress it has not made
 *   - §75: the funnel outranks query volume
 *   - the merchant token never appears in the HTML or in client JS
 *
 * The last one is the reason this file exists at all. Everything else
 * would be caught by looking at it; a token leaking into a payload would
 * not.
 *
 *   node dashboard/tests/render_test.js
 */

const pw = require("/opt/node22/lib/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const { start, TOKEN } = require("./mock-api");

/**
 * Ports are picked per run rather than fixed. A leftover server from a
 * previous run answering on a fixed port looks identical to a healthy
 * start — the suite then tests the old build and reports it green.
 */
const net = require("net");

function freePort() {
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

const OUT = process.env.DISC_TEST_OUT || require("os").tmpdir();

const SECTIONS = [
  ["Overview", "/app/overview"],
  ["Looks", "/app/looks"],
  ["Brand", "/app/brand"],
  ["Catalog", "/app/catalog"],
  ["AI Boutique", "/app/experience"],
  ["Analytics", "/app/analytics"],
  ["Billing", "/app/billing"],
  ["Settings", "/app/settings"],
];

const VIEWPORTS = [
  { name: "laptop", width: 1440, height: 900 },
  { name: "small-laptop", width: 1024, height: 720 },
  { name: "phone", width: 390, height: 844 },
];

let failures = 0;
let checks = 0;

function check(ok, label, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function waitForServer(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${url}`));
          setTimeout(attempt, 400);
        });
    })();
  });
}

async function main() {
  const API_PORT = await freePort();
  const APP_PORT = await freePort();
  const BASE = `http://127.0.0.1:${APP_PORT}`;

  const api = await start(API_PORT);
  console.log(`mock API on :${API_PORT}`);

  const next = spawn(
    "npx",
    ["next", "start", "--port", String(APP_PORT), "--hostname", "127.0.0.1"],
    {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        NEXT_PUBLIC_DISC_API_URL: `http://127.0.0.1:${API_PORT}`,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  next.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/Error|error/.test(text)) process.stdout.write(`  [next] ${text}`);
  });

  await waitForServer(BASE);
  console.log(`dashboard on :${APP_PORT}\n`);

  const browser = await pw.chromium.launch();

  try {
    for (const scenario of ["healthy", "fresh", "lapsed"]) {
      await fetch(`http://127.0.0.1:${API_PORT}/__scenario?name=${scenario}`);
      console.log(`── scenario: ${scenario}`);

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        // The session cookie the OAuth handoff would have set.
        await context.addCookies([
          {
            name: "disc_session",
            value: TOKEN,
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
          },
        ]);

        for (const [label, route] of SECTIONS) {
          const page = await context.newPage();
          const errors = [];
          const failed = [];
          page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
          page.on("pageerror", (e) => errors.push(String(e)));
          page.on("requestfailed", (r) => {
            // Next.js prefetches every <Link> in the nav on hover and on
            // idle. Closing the page cancels the ones still in flight,
            // which surfaces here as ERR_ABORTED — a property of this
            // harness, not of the dashboard. Only real failures count.
            const reason = r.failure()?.errorText ?? "";
            if (reason.includes("ERR_ABORTED")) return;
            failed.push(`${r.url()} (${reason})`);
          });

          const response = await page.goto(`${BASE}${route}`, {
            waitUntil: "load",
          });

          const tag = `${scenario}/${viewport.name}${route}`;

          check(response?.ok(), `${tag} responded 200`, String(response?.status()));
          check(errors.length === 0, `${tag} no console errors`, errors[0]);
          check(failed.length === 0, `${tag} no failed requests`, failed[0]);

          // The section heading actually rendered.
          const heading = await page.locator("h1").first().textContent();
          check(
            (heading ?? "").trim().length > 0,
            `${tag} has a heading`,
            String(heading),
          );

          // Nothing scrolls sideways. Same rule as the widget suites:
          // an admin page that overflows on a laptop is broken.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          check(overflow <= 1, `${tag} no horizontal scroll`, `${overflow}px`);

          // The nav is present and complete on every page.
          const navCount = await page.locator("nav.nav a").count();
          check(navCount === 8, `${tag} every section in nav`, `saw ${navCount}`);

          // Stripe's status vocabulary is precise and opaque to anyone
          // who does not work with Stripe. It leaked into the overview
          // banner once already, via an interpolated status that
          // bypassed the pill that exists to translate it.
          const body = await page.locator("main").innerText();
          for (const raw of ["past_due", "incomplete_expired", "trialing", "canceled"]) {
            check(!body.includes(raw), `${tag} no raw Stripe vocabulary`, raw);
          }

          // THE ONE THAT MATTERS: the merchant token must never reach
          // the browser. Not in the HTML, not in a script payload.
          const html = await page.content();
          check(!html.includes(TOKEN), `${tag} token absent from HTML`);
          const inScripts = await page.evaluate(
            (token) =>
              Array.from(document.querySelectorAll("script")).some((s) =>
                (s.textContent ?? "").includes(token),
              ),
            TOKEN,
          );
          check(!inScripts, `${tag} token absent from client scripts`);

          if (viewport.name === "laptop") {
            await page.screenshot({
              path: path.join(OUT, `disc-dash-${scenario}-${label.replace(/\s+/g, "-")}.png`),
              fullPage: true,
            });
          }

          await page.close();
        }

        await context.close();
      }
      console.log("");
    }

    // ---- content assertions, healthy scenario, one viewport ----
    await fetch(`http://127.0.0.1:${API_PORT}/__scenario?name=healthy`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: "disc_session", value: TOKEN, domain: "127.0.0.1", path: "/", httpOnly: true },
    ]);
    const page = await context.newPage();

    console.log("── content");

    await page.goto(`${BASE}/app/overview`, { waitUntil: "load" });
    let text = await page.locator("main").innerText();
    check(text.includes("412"), "overview shows the product count");
    check(text.includes("2,870"), "overview shows discovery, comma-formatted");
    check(text.includes("acme-atelier.myshopify.com"), "overview names the shop");
    // §75/§79: no AI plumbing on the merchant's first screen.
    check(!/token|embedding|model|prompt/i.test(text), "overview mentions no AI plumbing");

    await page.goto(`${BASE}/app/analytics`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    // Case-insensitive: the section headings are uppercased by CSS, and
    // `innerText` reports rendered text, not source text.
    const flat = text.toLowerCase();
    const funnelAt = flat.indexOf("funnel");
    const activityAt = flat.indexOf("activity");
    check(
      funnelAt > -1 && activityAt > funnelAt,
      "§75: funnel precedes query volume",
      `funnel@${funnelAt} activity@${activityAt}`,
    );
    check(text.includes("32%"), "click-through rate rendered as a percentage");
    check(
      text.includes("AI-assisted revenue") && /not measured/i.test(text),
      "§18: unmeasured metric is named, not faked",
    );

    await page.goto(`${BASE}/app/brand`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(text.includes("Version 3"), "brand shows its version");
    check(/Minimal/.test(text), "brand renders the style profile");
    check(text.includes("cream"), "brand renders the palette");
    const summaryInput = await page.locator('textarea[name="summary"]').inputValue();
    check(summaryInput.length > 0, "correction form is prefilled with what Disc believes");

    await page.goto(`${BASE}/app/experience`, { waitUntil: "load" });
    const enabled = await page.locator('input[name="enabled"]').isChecked();
    check(enabled, "experience reflects the live state");
    const workflowsChecked = await page.locator('input[name="workflows"]:checked').count();
    check(workflowsChecked === 4, "experience reflects saved workflows", String(workflowsChecked));
    // §65: no free-form styling input anywhere on this page.
    const freeform = await page.locator('input[type="color"], textarea[name*="css" i]').count();
    check(freeform === 0, "§65: no free-form styling controls");

    // Every field label and its help text must be on their own lines.
    // They ran together once, because the CSS was scoped to `label.field`
    // and the checkbox group is necessarily a `div.field`.
    const runTogether = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".field > .lab")).filter(
        (lab) => getComputedStyle(lab).display !== "block",
      ).length,
    );
    check(runTogether === 0, "field labels are block-level", `${runTogether} inline`);

    await page.goto(`${BASE}/app/looks`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    // The header counts and the rendered lists describe the same
    // library. They disagreed once, which made every screenshot a lie.
    const approvedCards = await page.locator("main .card").filter({ hasText: "In use" }).count();
    check(
      new RegExp(`Approved looks\\s*\\n?\\s*${approvedCards}\\b`).test(text),
      "looks: the approved count matches the approved cards",
      `${approvedCards} cards`,
    );
    check(
      /Optional, and Disc works without it/i.test(text),
      "looks: the page says Disc works without any of this",
    );
    check(
      /Not influencing recommendations yet/i.test(text),
      "looks: a draft says plainly that it is not in use",
    );

    await page.goto(`${BASE}/app/billing`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(text.includes("$199") && text.includes("$1500"), "billing lists the plans");
    check(!/token|per query|per search/i.test(text), "§79: no token or per-query pricing shown");

    // ---- fresh install: the empty states ----
    await fetch(`http://127.0.0.1:${API_PORT}/__scenario?name=fresh`);
    console.log("");
    console.log("── empty states");

    await page.goto(`${BASE}/app/overview`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(
      /not on your storefront yet/i.test(text),
      "§18: fresh install is told Disc is not live",
    );

    await page.goto(`${BASE}/app/analytics`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(
      !text.includes("0%"),
      "a rate with no denominator is not rendered as 0%",
    );

    await page.goto(`${BASE}/app/brand`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(
      /nothing to do yet|builds this once|reading your catalog/i.test(text),
      "no Brand Brain reads as pending, not as failure",
    );

    // ---- lapsed: the failure states ----
    await fetch(`http://127.0.0.1:${API_PORT}/__scenario?name=lapsed`);
    console.log("");
    console.log("── failure states");

    await page.goto(`${BASE}/app/overview`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(/sync failed/i.test(text), "catalog error is surfaced on the overview");
    check(
      /access token was revoked/i.test(text),
      "the actual error reason is shown, not a generic one",
    );
    check(/not serving shoppers/i.test(text), "lapsed subscription is surfaced");

    await page.goto(`${BASE}/app/analytics`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(/partial numbers/i.test(text), "truncated analytics say so");

    await page.goto(`${BASE}/app/billing`, { waitUntil: "load" });
    text = await page.locator("main").innerText();
    check(/payment failed/i.test(text), "past_due is shown in merchant language");
    check(!text.includes("past_due"), "raw Stripe vocabulary is not shown");
    check(/outgrew your plan/i.test(text), "over-limit catalog is flagged");
    // A merchant whose card failed already HAS a subscription. Offering
    // them checkout on another tier opens a second one alongside the
    // one they need to fix, and they get billed twice.
    check(
      !/start .*trial/i.test(text),
      "a failed payment is routed to the portal, not to a second checkout",
    );
    // Specifically a *checkout* form — one carrying a plan to subscribe
    // to. The "Manage subscription" control is also a form (every server
    // action is), and that one is exactly where they should be going.
    check(
      (await page.locator('form:has(input[name="plan"])').count()) === 0,
      "no checkout forms offered to an existing subscriber",
    );

    // ---- unauthenticated ----
    console.log("");
    console.log("── auth");
    const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/app/overview`, { waitUntil: "load" });
    check(
      anonPage.url().endsWith("/") || anonPage.url().includes("?"),
      "no session redirects to sign-in",
      anonPage.url(),
    );
    check(
      (await anonPage.locator("body").innerText()).includes("Connect your store"),
      "sign-in page renders",
    );

    // The token handoff: ?token= must not survive into the final URL.
    const handoff = await anon.newPage();
    await handoff.goto(`${BASE}/app?token=${TOKEN}`, { waitUntil: "load" });
    check(!handoff.url().includes("token="), "token is stripped from the URL", handoff.url());
    check(handoff.url().includes("/app/overview"), "handoff lands on the overview", handoff.url());
    const cookies = await anon.cookies();
    const session = cookies.find((c) => c.name === "disc_session");
    check(session?.value === TOKEN, "handoff stored the session cookie");
    check(session?.httpOnly === true, "session cookie is httpOnly");
    check(session?.sameSite === "Lax", "session cookie is SameSite=Lax", session?.sameSite);

    await anon.close();
    await context.close();
  } finally {
    await browser.close();
    next.kill();
    api.close();
  }

  console.log("");
  if (failures === 0) {
    console.log(`✓ ${checks} checks passed`);
    console.log(`  screenshots in ${OUT}`);
  } else {
    console.log(`✗ ${failures} of ${checks} checks failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
