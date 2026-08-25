/**
 * A stand-in for the Convex HTTP router.
 *
 * The dashboard cannot be rendered without a backend, and the real one
 * needs a Convex deployment (which needs the owner's account). So this
 * serves the same merchant routes with the same response shapes, which
 * is enough to prove the pages render, the numbers land in the right
 * places, and nothing overflows.
 *
 * It is deliberately strict about auth: every route 401s without the
 * expected bearer token, so the suite can prove the dashboard actually
 * sends it rather than happening to work because the mock was lax.
 *
 * Scenarios let one suite cover the states that matter — a fresh install
 * with nothing built yet, a healthy live store, and a lapsed one.
 */

const http = require("http");

const TOKEN = "dsk_test_merchant_token";

const SCENARIOS = {
  healthy: {
    overview: {
      shopDomain: "acme-atelier.myshopify.com",
      status: {
        catalog: "ready",
        brandBrain: "ready",
        widget: "live",
        subscription: "active",
        active: true,
      },
      productCount: 412,
      lastSyncedAt: Date.now() - 42 * 60 * 1000,
      catalogError: null,
      onboarding: stages({ catalog: true, products: true, brand: true, live: true }),
      needsActivation: false,
    },
    catalog: {
      total: 412,
      indexed: 412,
      enriched: 389,
      notEnriched: 23,
      lowConfidence: 31,
      rejectedFields: 4,
      unavailable: 57,
      missingImages: 6,
    },
    analytics: {
      days: 30,
      sessions: 1284,
      queries: 3120,
      outfitsGenerated: 604,
      productsDiscovered: 2870,
      productClicks: 921,
      productSaves: 188,
      outfitSaves: 96,
      addToCart: 213,
      refinements: 447,
      errors: 3,
      clickThroughRate: 0.321,
      cartRate: 0.231,
      truncated: false,
    },
    brand: {
      version: 3,
      isCurrent: true,
      styleVector: { minimal: 0.42, classic: 0.31, utilitarian: 0.16, luxe: 0.08 },
      palette: {
        dominant: ["cream", "charcoal", "olive"],
        accent: ["burgundy"],
        neutrals: ["stone", "taupe", "off-white"],
      },
      formality: { mean: 5.8, range: [3, 8] },
      productWorld: {
        coreCategories: ["Outerwear", "Knitwear", "Trousers"],
        priceBand: "premium",
        seasonality: ["autumn", "winter"],
      },
      voice: {
        tone: ["understated", "warm", "precise"],
        vocabulary: ["considered", "tailored", "weightless"],
      },
      merchandising: { newness: "monthly drops", depth: "narrow, repeated" },
      summary:
        "Quiet, tailored pieces in natural fabrics for people who dress deliberately and do not want to be noticed for it.",
      source: "derived",
      confidence: 0.78,
      createdAt: Date.now() - 4 * 86400000,
    },
    experience: {
      config: {
        enabled: true,
        placement: "bottom_bar",
        greeting: "What are you looking for?",
        workflows: ["PRODUCT_SEARCH", "SIMILAR", "COMPLETE_LOOK", "OUTFIT"],
        design: {
          density: "airy",
          motion: "subtle",
          cardStyle: "editorial",
          cornerRadius: "small",
        },
      },
      widgetStatus: "live",
      publicKey: "disc_9f3c2a71b04e4d8fa61c7e25d3b8091a",
    },
    settings: {
      shopDomain: "acme-atelier.myshopify.com",
      email: "hello@acme-atelier.com",
      publicKey: "disc_9f3c2a71b04e4d8fa61c7e25d3b8091a",
      scopes: "read_products",
      installedAt: Date.now() - 62 * 86400000,
      plan: "pilot",
      subscriptionStatus: "active",
      billingEnabled: true,
    },
    billingState: {
      enabled: true,
      subscriptionStatus: "active",
      plan: "pilot",
      suggestedPlan: "pilot",
      productCount: 412,
      overCatalogLimit: false,
      hasCustomer: true,
      trialDays: 14,
    },
  },

  /** Just installed: nothing built, nothing live, no numbers. */
  fresh: {
    overview: {
      shopDomain: "new-store.myshopify.com",
      status: {
        catalog: "syncing",
        brandBrain: "pending",
        widget: "inactive",
        subscription: "trialing",
        active: true,
      },
      productCount: 0,
      lastSyncedAt: null,
      catalogError: null,
      onboarding: stages({}),
      needsActivation: true,
    },
    catalog: {
      total: 0,
      indexed: 0,
      enriched: 0,
      notEnriched: 0,
      lowConfidence: 0,
      rejectedFields: 0,
      unavailable: 0,
      missingImages: 0,
    },
    analytics: {
      days: 30,
      sessions: 0,
      queries: 0,
      outfitsGenerated: 0,
      productsDiscovered: 0,
      productClicks: 0,
      productSaves: 0,
      outfitSaves: 0,
      addToCart: 0,
      refinements: 0,
      errors: 0,
      // Null, not zero — nothing has happened, which is not the same as
      // a zero percent rate.
      clickThroughRate: null,
      cartRate: null,
      truncated: false,
    },
    brand: null,
    experience: {
      config: {
        enabled: false,
        placement: "bottom_bar",
        greeting: "What are you looking for?",
        workflows: ["PRODUCT_SEARCH", "SIMILAR", "STYLE_PRODUCT", "COMPLETE_LOOK", "OUTFIT"],
        design: {
          density: "airy",
          motion: "subtle",
          cardStyle: "editorial",
          cornerRadius: "small",
        },
      },
      widgetStatus: "inactive",
      publicKey: "disc_0000000000000000000000000000ffff",
    },
    settings: {
      shopDomain: "new-store.myshopify.com",
      email: null,
      publicKey: "disc_0000000000000000000000000000ffff",
      scopes: "read_products",
      installedAt: Date.now() - 3 * 60 * 1000,
      plan: null,
      subscriptionStatus: "trialing",
      billingEnabled: true,
    },
    billingState: {
      enabled: true,
      subscriptionStatus: "trialing",
      plan: null,
      suggestedPlan: "pilot",
      productCount: 0,
      overCatalogLimit: false,
      hasCustomer: false,
      trialDays: 14,
    },
  },

  /** Subscription lapsed and the last catalog sync failed. */
  lapsed: {
    overview: {
      shopDomain: "lapsed.myshopify.com",
      status: {
        catalog: "error",
        brandBrain: "ready",
        widget: "inactive",
        subscription: "past_due",
        active: false,
      },
      productCount: 6200,
      lastSyncedAt: Date.now() - 9 * 86400000,
      catalogError: "Shopify returned 401 — the access token was revoked.",
      onboarding: stages({ catalog: false, brand: true, failed: true }),
      needsActivation: true,
    },
    catalog: {
      total: 6200,
      indexed: 6100,
      enriched: 2400,
      notEnriched: 3800,
      lowConfidence: 900,
      rejectedFields: 140,
      unavailable: 1900,
      missingImages: 320,
    },
    analytics: {
      days: 30,
      sessions: 40,
      queries: 88,
      outfitsGenerated: 12,
      productsDiscovered: 96,
      productClicks: 18,
      productSaves: 2,
      outfitSaves: 1,
      addToCart: 3,
      refinements: 9,
      errors: 21,
      clickThroughRate: 0.187,
      cartRate: 0.166,
      truncated: true,
    },
    brand: {
      version: 1,
      isCurrent: true,
      styleVector: { streetwear: 0.51, sporty: 0.28, edgy: 0.12 },
      palette: { dominant: ["black", "white"], accent: [], neutrals: ["grey"] },
      formality: { mean: 2.1 },
      productWorld: { coreCategories: ["Tops"] },
      voice: { tone: ["direct"], vocabulary: [] },
      summary: "",
      source: "merchant_corrected",
      confidence: 0.33,
      createdAt: Date.now() - 30 * 86400000,
    },
    experience: {
      config: {
        enabled: false,
        placement: "floating_button",
        greeting: "Ask us anything",
        workflows: ["PRODUCT_SEARCH"],
        design: {
          density: "dense",
          motion: "none",
          cardStyle: "bold",
          cornerRadius: "large",
        },
      },
      widgetStatus: "inactive",
      publicKey: "disc_dddddddddddddddddddddddddddddddd",
    },
    settings: {
      shopDomain: "lapsed.myshopify.com",
      email: "ops@lapsed.example",
      publicKey: "disc_dddddddddddddddddddddddddddddddd",
      scopes: "read_products,read_content",
      installedAt: Date.now() - 400 * 86400000,
      plan: "growth",
      subscriptionStatus: "past_due",
      billingEnabled: true,
    },
    billingState: {
      enabled: true,
      subscriptionStatus: "past_due",
      plan: "growth",
      suggestedPlan: "enterprise",
      productCount: 6200,
      overCatalogLimit: true,
      hasCustomer: true,
      trialDays: 14,
    },
  },
};

function stages({ catalog = false, products = false, brand = false, live = false, failed = false }) {
  return [
    { key: "connected", label: "Connected to Shopify", done: true, failed: false },
    { key: "catalog", label: "Reading your catalog", done: catalog, failed },
    { key: "products", label: "Understanding your products", done: products, failed: false },
    { key: "brand", label: "Learning your brand", done: brand, failed: false },
    { key: "preview", label: "Ready to preview", done: brand && catalog, failed: false },
    { key: "live", label: "Live on your storefront", done: live, failed: false },
  ];
}

const PLANS = [
  { key: "pilot", name: "Disc Pilot", price: 199, catalogLimit: 500 },
  { key: "growth", name: "Disc Growth", price: 599, catalogLimit: 5000 },
  { key: "enterprise", name: "Disc Enterprise", price: 1500, catalogLimit: null },
];

function start(port = 8787) {
  let scenario = "healthy";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Test-only control channel.
    if (url.pathname === "/__scenario") {
      scenario = url.searchParams.get("name") ?? "healthy";
      return send({ scenario });
    }

    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) return send({ detail: "Unauthorized" }, 401);

    const data = SCENARIOS[scenario];

    switch (url.pathname) {
      case "/merchant/overview":
        return send(data.overview);
      case "/merchant/catalog":
        return send(data.catalog);
      case "/merchant/brand":
        return send(data.brand);
      case "/merchant/experience":
        if (req.method === "POST") return send(data.experience.config);
        return send(data.experience);
      case "/merchant/settings":
        return send(data.settings);
      case "/merchant/analytics": {
        const days = Number(url.searchParams.get("days") ?? "30");
        return send({ ...data.analytics, days });
      }
      case "/merchant/dashboard":
        return send({
          overview: data.overview,
          catalog: data.catalog,
          experience: data.experience,
          brand: data.brand,
        });
      case "/merchant/billing":
        return send({ plans: PLANS, trialDays: 14, enabled: true, state: data.billingState });
      case "/merchant/resync":
        return send({ status: "queued" });
      case "/merchant/preview":
        return send({ status: "previewing" });
      case "/merchant/brand/correct":
        return send({ version: (data.brand?.version ?? 0) + 1 });
      default:
        return send({ detail: "Not found" }, 404);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

module.exports = { start, TOKEN, SCENARIOS };
