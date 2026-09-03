# Disc

**Disc is an AI-native personalized commerce layer for fashion brands
that turns a Shopify store into a more personal shopping experience,
helping people discover, style, compare, and decide what to buy from the
brand's own catalog.**

In plain language: a fashion brand already has a Shopify store, a
catalog, and a checkout. Disc adds a layer inside that store which
understands what the brand sells, understands what a shopper is trying to
decide, and helps them get to an answer. Everything it recommends is a
real, available product from that brand, bought through that brand's own
checkout.

---

## Why Disc exists

A shopper on a fashion site usually has a question the site cannot
answer. Not "show me black dresses" — a filter does that — but:

- Which of these actually fits what I'm looking for?
- Which of these two is better for me?
- What works with this?
- What changes if I choose this instead?
- Is this too formal for what I need it for?
- What would complete the look?
- Why are you recommending this?
- Which one should I actually buy?

Those are decisions, not queries. Most storefronts leave the shopper to
make them alone, and the shopper resolves the uncertainty by leaving.

Disc exists to reduce that uncertainty.

---

## Discover, style, compare, decide

Four verbs, and they are one journey rather than four features.

**Discover** — Find relevant products from this brand. Not keyword
matching against titles: reading "something for a humid beach wedding" as
constraints about weight, formality, fabric and season, then finding what
in this catalog meets them.

**Style** — Understand how products work together and build a coherent
look. A cardigan's nearest neighbours are four more cardigans; an outfit
is trousers, a knit, outerwear. Compatibility, not similarity.

**Compare** — Understand the meaningful differences and trade-offs
between relevant options. *(Direction — see Current capabilities.)*

**Decide** — Reach a confident purchase decision, and understand why. A
recommendation nobody understands is one nobody trusts.

```
"I'm looking for something"
        ↓  discover
"these are relevant"
        ↓  style
"this works with what I want"
        ↓  compare
"here's how they differ"
        ↓  decide
"I know which one I want"
```

The product is not search. It is helping someone make a better purchase
decision inside a brand's own catalog.

---

## Where Disc lives

Inside the merchant's existing Shopify store. It replaces nothing.

```
merchant's Shopify store
        ↓  an entry point the merchant controls
Disc experience
        ↓  the brand's own catalog
shopper's decision
        ↓
the merchant's own cart and checkout
```

| | Owns |
| --- | --- |
| **Shopify** | the merchant's existing commerce infrastructure — catalog, storefront, checkout |
| **Disc** | the personalized intelligence and shopping experience layer |
| **Merchant** | the brand, catalog, products, inventory and commerce relationship |
| **Shopper** | a more personal way to discover, style, compare and decide |

The merchant keeps their storefront, branding, navigation, product pages
and checkout. Disc adds a way to decide and hands the shopper back to the
merchant's own cart.

**Shopify remains the source of truth for every transactional fact** —
price, currency, variants, availability, product URLs. Disc never becomes
the authority on what something costs or whether it is in stock. What
Disc adds is inference *about* those products, kept in separate tables so
the two can never be confused.

**If Disc is unavailable, the store is unaffected.** The experience
mounts only after confirming that this merchant's Disc is live, so an
outage leaves the storefront exactly as it was, including the theme's own
search. Disc must never be a way for a merchant's store to break.

---

## One Disc, many tenant knowledge worlds

```
ONE DISC SOFTWARE  +  MANY TENANT-SPECIFIC KNOWLEDGE WORLDS
```

Shared across every merchant: the storefront runtime, the decision
engine, retrieval, ranking, judging, explanation, orchestration,
reliability and analytics infrastructure.

Specific to one merchant: the Shopify catalog, products, variants and
availability; Product Intelligence; the Brand Brain; the brand's
terminology and visual identity; styling relationships and approved
looks; and — as direction — brand content and content/product
relationships.

This is **not** one AI model per merchant. The intelligence system is
shared; the world it reasons over belongs to one brand at a time.

That boundary is enforced rather than intended. Every tenant-owned row
carries a tenant id, every index leads with it, the vector index filters
on it, and a test reads the schema and fails the build if a new
tenant-scoped table is not covered by tenant deletion.

---

## What Disc understands

**Product catalog** — what the brand actually sells. Read from Shopify:
products, variants, price, currency, images, availability. Facts, kept as
facts.

**Product Intelligence** — what Disc understands *about* those products.
Garment type, fit, volume, weight, drape, pattern, colour family,
formality, season, occasion. Derived by reading each product's text and
looking at its images, stored separately from the Shopify facts so
inference is never mistaken for truth.

**Brand Brain** — what Disc understands about the brand itself: style
vector, palette, formality range, product world, voice. Derived from the
catalog as a whole rather than declared in a settings form. A merchant
can correct it, and a correction is versioned rather than overwritten.

**Shopper intent** — what this person is trying to find or decide.
Budget, occasion, constraints, what they have rejected, what they said
three messages ago.

**Brand content** — a campaign photograph is a record of a styling
decision someone made deliberately. Today this is merchant-uploaded
looks; the general content layer is direction.

---

## How the decision engine works

```
intent      → what did the shopper actually ask for
retrieval   → what could be relevant          (vector search)
constraints → what is actually buyable        (deterministic)
assembly    → what goes together              (deterministic)
ranking     → which is strongest              (deterministic)
judge       → is it actually coherent         (model, independent)
diversity   → are these meaningfully different
explanation → why, from real evidence
```

**Everything before the judge runs without a model call.** The model only
ever sees the final handful, and if it is unavailable the engine still
works — it loses its second opinion, not its answer.

This is what "AI-native" means here, concretely. AI is not a feature
bolted onto a catalog search; it is how the system understands products,
brands, intent and compatibility, and it is staged so that the expensive,
non-deterministic part is the smallest part. The product category is the
personalized commerce layer. AI is what makes that layer possible.

---

## The merchant side

The merchant installs Disc, connects Shopify, and Disc reads the catalog
and builds its understanding. From the dashboard they can see what Disc
learned, correct the Brand Brain, review catalog health, build and
approve looks, configure the shopper experience, read analytics, and
manage billing.

Disc starts switched off. Nothing appears to shoppers until the merchant
turns it on.

**A model proposes; the merchant confirms.** In the Look Builder, vision
detection produces *candidates* — a model can see "a white shirt" in a
photograph and have no idea which of fourteen white shirts it is.
`looks.detected` (what the model saw) and `looks.items` (what the
merchant confirmed) are separate fields, and only confirmed information
becomes authoritative evidence. That separation is load-bearing and
carries forward into all future content work.

## The shopper side

A shopper opens Disc from inside the merchant's store, says what they are
looking for, and works through it: results from this brand's catalog,
product detail with real sizes and availability, complete-the-look
outfitting, a saved-items list, and add-to-cart into the merchant's own
cart.

---

## Current capabilities

Claims here are limited to what the repository implements.

- Shopify catalog ingestion via the Admin API — products, variants,
  price, currency, images, availability, with reconciliation for products
  removed at source
- Product enrichment into structured fashion attributes, from text and
  images, cached so nothing is re-analysed unless its evidence changed
- Embeddings and tenant-filtered vector retrieval
- Brand Brain, derived from the catalog, versioned, merchant-correctable
- Structured shopper intent, including follow-up and refinement state
- **Discover** — semantic search over the brand's catalog, sold-out
  products filtered out
- **Style** — outfit assembly and complete-the-look with compatibility
  logic; the Look Builder, where merchants confirm which catalog products
  appear in an uploaded image; approved looks feed an outfit graph
- **Decide** — ranking, an independent judging pass, diversity, and
  explanations grounded in real evidence, with every recommendation traced
- Merchant dashboard: overview, brand, catalog, looks, experience,
  analytics, billing, settings
- Shopper sessions, analytics, and per-tenant model-cost accounting
- Billing (Stripe), rate limiting, tenant isolation, privacy and deletion
  guarantees
- A Shopify **theme app extension** — an app embed block that identifies
  the store, passes page context, currency and locale, loads without
  blocking rendering, and starts deactivated
- Reliability: durable background jobs, idempotent scheduling, bounded
  retry with crash recovery, Shopify and Stripe event ledgers,
  constant-time catalog health

**Named in the definition but not yet implemented:**

- **Compare** is in the workflow vocabulary and understood by intent
  parsing, but there is no comparison handler and no comparison
  interface. Direction, not capability.
- The merchant-controlled **entry point** is a persisted configuration
  value (`placement: "floating_button"`) that the storefront runtime does
  not yet read. Disc currently presents as a docked bar.

---

## Future direction

Labelled as direction. None of this is implemented.

**Comparison** — making Compare real: meaningful differences and
trade-offs between relevant options.

**A general brand content model** — editorial and campaign imagery,
lookbooks, video, and eventually social content, generalising what the
Look Builder already does for a single uploaded image.

**Video intelligence** — scene and timestamp mapping: video → scenes →
detected garments → candidate catalog products → merchant confirmation.

**A content/product graph**, and richer content-aware evidence in the
decision engine.

Two distinctions govern all of it, and documentation must not collapse
them:

```
CONTENT PRESENCE        a product appears in a bounded content scope
CONTENT COMPATIBILITY   products were intentionally styled together
```

These are not the same claim. A campaign photograph establishes both — everything
in frame was styled together. A video scene can establish presence
without establishing compatibility: two garments eight minutes apart in a
lookbook were not styled as an outfit. Deriving compatibility from
unbounded co-presence would fill the outfit graph with pairs nobody
styled, carrying the authority of a merchant approval it never had.

And: **content is evidence, not a ranking dictator.** It must never
override an explicit shopper constraint — "under £200", "no leather",
"available in my size" — and a brand that uploads nothing must never get
worse results than one that does.

Fuller detail in [`PRODUCT_DIRECTION.md`](PRODUCT_DIRECTION.md) and
[`PRODUCTION_P2_ARCHITECTURE.md`](PRODUCTION_P2_ARCHITECTURE.md).

---

## What Disc is not

- **Not a generic chatbot.** A text box is how a shopper says what they
  want. The product is what happens after.
- **Not a generic AI search box.** Search returns matches; Disc helps
  someone decide between them.
- **Not a standalone fashion marketplace.** No Disc storefront, no
  cross-brand catalog, no aggregated inventory.
- **Not a replacement storefront.** The merchant's site, brand,
  navigation, product pages and checkout stay as they are.
- **Not a social feed disconnected from commerce.** Content earns its
  place by helping someone decide what to buy.
- **Not an autonomous agent swarm.** The engine is staged and mostly
  deterministic; the model is a bounded step inside it.
- **Not a generic LLM wrapper.** The reasoning is fashion-specific — fit,
  drape, formality, silhouette, what completes a look — over one brand's
  catalog.
- **Not one AI model per merchant.** One system, many tenant-specific
  knowledge worlds.

---

## Architecture

```
Shopify  ──catalog──▶  ingestion  ──▶  Product Intelligence
                                              │
                                              ▼
                                        Brand Brain
                                              │
shopper intent  ──────────────────────▶  decision engine
                                              │
                                              ▼
                                    storefront runtime
                                              │
                                              ▼
                                merchant's cart and checkout
```

The backend is Convex (TypeScript). The storefront runtime is one
dependency-free file delivered as a Shopify theme app extension. The
merchant dashboard is Next.js, server components only — the merchant
token never reaches the browser.

### Distribution

Disc is a **custom-distribution Shopify app** (`shopify.app.toml`). A
custom app installs on one store at a time with **no App Store review**,
which is what lets Disc reach its first merchants without waiting on
approval. It still supports theme app extensions, so the merchant gets
the proper install: enable the app embed in the theme editor, with no
pasted snippet and no edited `theme.liquid`.

One documented consequence: custom apps cannot use Shopify's Billing API,
so billing is Stripe. That is the constraint of this distribution type,
not a workaround.

What is outstanding is operational rather than architectural — creating
the app in the Partner Dashboard to obtain a `client_id`, filling in the
deployed URLs, and `shopify app deploy`.

### Repository structure

```
/convex          the product backend
  schema.ts      the data model — every tenant-owned row carries a tenant id
  ingest.ts      Shopify catalog ingestion
  enrichment.ts  Product Intelligence
  brand.ts       Brand Brain
  search.ts      discovery
  outfits.ts     styling, ranking, judging, explanation
  looks.ts       the Look Builder and the outfit graph
  jobs.ts        durable job state
  scheduling.ts  idempotent scheduling and retry decisions
  webhooks.ts    Shopify delivery identity and ordering
  billing.ts     Stripe, rate limiting, the event ledger
  lib/           pure logic: intent, compatibility, taxonomy, judging, retry
  http.ts        storefront, merchant, Shopify and Stripe HTTP surface

/frontend        the storefront runtime — Web Component + Shadow DOM
  tests/         layout, coverage and outage suites, real device profiles

/extensions      the Shopify theme app extension (app embed block)

/dashboard       the merchant console (Next.js, server components only)

/backend         SUPERSEDED. The original Python prototype, kept for
                 history and used by nothing in the shipping path.
```

### Reliability

Disc runs inside other people's storefronts, so failure modes matter more
than features. Each document below records a failure mode, the invariant
introduced, the test that proves it, and how to roll it back.

| | |
| --- | --- |
| [`PRODUCTION_ARCHITECTURE_AUDIT.md`](PRODUCTION_ARCHITECTURE_AUDIT.md) | the traced audit, with status per finding |
| [`PRODUCTION_JOB_STATE.md`](PRODUCTION_JOB_STATE.md) | durable background work |
| [`PRODUCTION_IDEMPOTENCY.md`](PRODUCTION_IDEMPOTENCY.md) | duplicate triggers do not duplicate work |
| [`PRODUCTION_RETRY_POLICY.md`](PRODUCTION_RETRY_POLICY.md) | bounded, observable recovery |
| [`PRODUCTION_WEBHOOKS.md`](PRODUCTION_WEBHOOKS.md) | Shopify delivery identity and ordering |
| [`PRODUCTION_STRIPE_EVENTS.md`](PRODUCTION_STRIPE_EVENTS.md) | replay-safe billing state |
| [`PRODUCTION_CATALOG_HEALTH.md`](PRODUCTION_CATALOG_HEALTH.md) | aggregates instead of corpus scans |
| [`PRIVACY.md`](PRIVACY.md) | what is stored, and what deletion guarantees |

### Other documents

- [`CLAUDE.md`](CLAUDE.md) — how the system is built, for anyone working
  on it
- [`Disc.md`](Disc.md) — the master build spec; code comments reference
  its section numbers
- [`Disc audit.md`](Disc%20audit.md) — the traced gap analysis against
  that spec

---

## Development and testing

```bash
npm run verify     # typecheck, lint, unit, integration, storefront outage suite
```

Browser-driving suites are run separately because they take minutes
rather than seconds:

```bash
node frontend/tests/devices_test.js    # fits across 14 real device profiles
node frontend/tests/coverage_test.js   # can a shopper see and tap every control
cd dashboard && npm run verify         # typecheck, build, render suite
```

---

## Known limitations

- **Compare is not implemented**, though it is one of the four verbs in
  the definition.
- **The merchant-controlled entry point is not implemented.** The
  configuration value exists; the runtime ignores it.
- **Not yet deployed.** The Convex backend is written and tested but
  needs a Convex project; the Shopify app needs a Partner Dashboard
  `client_id`.
- **`/backend` is dead weight** — a superseded Python prototype kept for
  history. Nothing in the shipping path depends on it.
- **`convex/http.ts` is large** (~1,000 lines) and would split cleanly
  into route modules.
- **Dark mode follows the shopper's OS preference**, not the actual
  lightness of the merchant's page, which can read low-contrast on a
  light-only storefront.
