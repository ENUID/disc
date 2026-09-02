# Disc

**An AI-native personalized commerce layer for fashion brands that turns
a Shopify store into a more personal shopping experience, helping people
discover, style, compare, and decide what to buy from the brand's own
catalog.**

A shopper on a fashion site usually has a question the site cannot
answer. Not "show me black dresses" — a filter does that — but "which of
these actually suits what I'm after", "does this work with what I already
own", "is this too formal for what I need it for", "what would finish
this look". Those are decisions, and most storefronts leave the shopper
to make them alone.

Disc is the layer that helps. It reads the brand's catalog, learns what
the brand's products actually are and how they relate to each other,
takes what a shopper says they want, and works through it with them. It
runs inside the merchant's existing Shopify store, and everything it
recommends is a real, available product from that brand.

Disc is AI-native: reading products, understanding a brand's style,
interpreting what a shopper means and reasoning about how garments work
together are not features bolted onto a catalog search — they are what
the system is built out of. But AI is the *how*. The *what* is a better
way to decide what to buy, and that is what a merchant is buying.

---

## What Disc does

Four jobs, and they are one journey rather than four features:

**Discover** — Turn what a shopper says into products that actually fit
it. Not keyword matching against titles: understanding "something for a
humid beach wedding" as a set of constraints about weight, formality,
fabric and season, then finding what in this catalog meets them.

**Style** — Understand how pieces work together, and build a coherent
look. A cardigan's nearest neighbours are four more cardigans; an outfit
is trousers, a knit, outerwear. Disc reasons about compatibility, not
similarity.

**Compare** — Help a shopper understand the real difference between two
things they are choosing between, including the trade-off. *(Direction —
see The product today.)*

**Decide** — Turn the evidence into a recommendation the shopper can act
on, and say why. A recommendation nobody understands is one nobody
trusts.

The journey those four make:

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

The product is not search. The product is helping someone make a better
purchase decision inside a brand's own catalog.

---

## Where Disc lives

Inside the merchant's existing Shopify store. It does not replace
anything.

```
merchant's Shopify store
        ↓  a small entry point the merchant controls
Disc experience
        ↓  the brand's own catalog
shopper's decision
        ↓
the merchant's own cart and checkout
```

The division of responsibility is deliberate:

| | Owns |
| --- | --- |
| **Shopify** | commerce infrastructure — catalog, storefront, checkout |
| **Merchant** | brand, products, merchandising, inventory, the commercial relationship |
| **Disc** | shopping intelligence and the decision experience |
| **Shopper** | gets a more personal way to discover and decide |

The merchant keeps their storefront, their branding, their navigation,
their product pages and their checkout. Disc adds a way to decide, and
hands the shopper back to the merchant's own cart to buy.

**Shopify remains the source of truth for every transactional fact** —
price, currency, variants, availability, product URLs. Disc never
becomes the authority on what something costs or whether it is in stock.
What Disc adds is inference *about* those products, kept in separate
tables so the two can never be confused.

**If Disc is unavailable, the store is unaffected.** The experience
mounts only after confirming the merchant's Disc is live, so a backend
outage leaves the storefront exactly as it was — including the theme's
own search. Disc must never be a way for a merchant's store to break.

---

## How Disc works

```
the brand's Shopify catalog
        ↓
product intelligence     what each product actually is
        ↓
brand understanding      what this brand's world looks like
        ↓
shopper intent           what this person is trying to decide
        ↓
decision engine          combine all of it into a real recommendation
        ↓
a personalized shopping experience, in the merchant's store
```

What each layer means:

**Product catalog** — what the brand actually sells. Read from Shopify:
products, variants, price, currency, images, availability. Facts, kept as
facts.

**Product intelligence** — what Disc understands *about* those products.
Garment type, fit, volume, weight, drape, pattern, colour family,
formality, season, occasion. Derived by reading the product's text and
looking at its images, and stored separately from the Shopify facts so
inference is never mistaken for truth.

**Brand Brain** — what Disc understands about the brand itself. Its style
vector, palette, formality range, product world, and voice, derived from
the catalog as a whole rather than declared in a settings form. A
merchant can correct it, and a correction is versioned rather than
overwritten.

**Shopper intent** — what this particular person is trying to find or
decide. Budget, occasion, constraints, what they have already rejected,
what they said three messages ago.

**Decision engine** — how those combine. Intent parsing, retrieval,
constraint filtering, outfit assembly, ranking, a judging pass,
diversity, and an explanation drawn from real evidence rather than
generated flattery.

**Brand content** — additional evidence from a brand's own imagery: a
campaign photograph is a record of a styling decision someone made
deliberately. Today this is merchant-uploaded looks; the wider content
layer is direction, not current.

**Storefront runtime** — how the experience reaches the shopper inside
the merchant's store.

---

## One Disc, many brand knowledge worlds

The software is shared. The knowledge is not.

```
ONE DISC SOFTWARE
        +
MANY TENANT-SPECIFIC KNOWLEDGE WORLDS
```

Every merchant runs the same Disc — the same retrieval, the same ranking,
the same interface, the same reasoning. What differs is the world that
Disc reasons about:

- the Shopify catalog, products, variants and availability
- product intelligence derived from them
- the Brand Brain
- the brand's vocabulary and visual identity
- styling relationships and approved looks
- merchandising context
- *(direction)* campaign imagery, video, social content, and the
  relationships between content and products

This is **not** a separate AI model per merchant. The intelligence is one
system; the context it reasons over belongs to one brand at a time.

That boundary is enforced rather than intended. Every tenant-owned row
carries a tenant id, every index leads with it, the vector index filters
on it, and a test reads the schema and fails the build if a new
tenant-scoped table is not covered by tenant deletion. A shopper in one
brand's store cannot reach another brand's catalog, brand model, looks or
analytics.

---

## The product today

Claims here are limited to what the repository implements. Everything
else is in the next section.

**Implemented**

- Shopify catalog ingestion via the Admin API — products, variants,
  price, currency, images, availability, with reconciliation for products
  removed at source
- Product enrichment into structured fashion attributes, from text and
  images, cached so nothing is re-analysed unless its evidence changed
- Embeddings and vector retrieval, filtered by tenant
- Brand Brain derived from the catalog, versioned, merchant-correctable
- Intent parsing — budget, occasion, constraints, follow-ups
- **Discover**: semantic search over the brand's catalog with sold-out
  products filtered out
- **Style**: complete-the-look and outfit assembly with compatibility
  reasoning; merchant-uploaded looks where the merchant confirms which
  catalog products appear, feeding an outfit graph
- **Decide**: ranking, a judging pass, diversity, and explanations
  grounded in real evidence, with every recommendation traced
- Shopper sessions, analytics, and per-tenant model-cost accounting
- Merchant dashboard: overview, brand, catalog, looks, experience,
  analytics, billing, settings
- Billing, rate limiting, tenant isolation and privacy/deletion guarantees
- A Shopify theme app extension: an app embed block that identifies the
  store, passes page context, currency and locale, loads without blocking
  rendering, and starts switched off
- Operational foundation: durable background jobs, idempotent scheduling,
  bounded retry with crash recovery, Shopify and Stripe event ledgers,
  and constant-time catalog health

**Not yet implemented, though named in the product definition**

- **Compare** is declared in the workflow vocabulary and understood by
  intent parsing, but there is no comparison handler and no comparison
  interface. It is direction, not a current capability.
- The small merchant-controlled entry point — a distinct control the
  shopper taps to open Disc — exists as a configuration value that the
  storefront runtime does not yet act on. Disc currently presents as a
  docked bar.
- The app embed exists in the repository but is not published: that needs
  a Shopify Partner account, app registration and review.

---

## Where it is going

Direction, not current functionality.

**Distribution.** Publishing the theme app extension so installation is a
Shopify app install and a switch in the theme editor, with no theme code
edited by hand. Implementing the merchant-controlled entry point, with
its label a merchant setting rather than a fixed word — "Personalized
Style", "Your Style", "Personal Stylist" and "Discover Your Style" are
all candidates and none is canonical.

**Comparison.** Making Compare a real capability: meaningful differences
between relevant products, including the trade-offs.

**Brand content intelligence.** A brand already produces the material
that explains its products — campaign imagery, lookbooks, editorial
photography, video, social content. Today Disc can learn from
merchant-uploaded looks. The direction is a general content layer:

```
content
    ↓  understanding
candidate product associations
    ↓  merchant confirmation
content ↔ product relationships
    ↓
additional evidence for the decision engine
```

For video, the same shape at a finer grain: video → scenes → detected
garments → candidate catalog products → merchant confirmation.

Two rules govern all of it:

**A model may propose; the merchant confirms.** A model can see "a white
shirt" in a photograph and have no idea which of fourteen white shirts it
is. Detection produces candidates. Auto-assigning would teach Disc a
relationship between products that were never photographed together, and
nothing downstream could tell that from a real one.

**Content is evidence, not a dictator.** A campaign showing two pieces
styled together is strong evidence they work together. It must never
override an explicit shopper constraint — "under £200", "no leather",
"available in my size" — and it must never make a brand that uploads
nothing worse off than one that does.

Detailed direction lives in
[`PRODUCT_DIRECTION.md`](PRODUCT_DIRECTION.md) and
[`PRODUCTION_P2_ARCHITECTURE.md`](PRODUCTION_P2_ARCHITECTURE.md).

---

## What Disc is not

Stated explicitly, because each of these is a plausible misreading:

- **Not a marketplace.** There is no Disc storefront, no cross-brand
  catalog, no aggregated inventory. A shopper is in one brand's store
  buying that brand's products.
- **Not a replacement storefront.** The merchant's site, brand,
  navigation, product pages and checkout stay exactly as they are.
- **Not a chatbot.** A text box is how a shopper says what they want. The
  product is what happens after: retrieval, constraint filtering, outfit
  reasoning, ranking, judging, explanation. Conversation is an interface,
  not the thing.
- **Not a generic AI search box.** Search returns matches. Disc is built
  to help someone decide between them.
- **Not a separate AI model per merchant.** One system, many
  tenant-specific knowledge worlds.
- **Not a general ecommerce AI layer.** It is built for fashion, and the
  reasoning — fit, drape, formality, silhouette, what completes a look —
  is fashion-specific.

---

## Architecture

```
/convex          the product backend (TypeScript, Convex)
  schema.ts      the data model — every tenant-owned row carries a tenant id
  ingest.ts      Shopify catalog ingestion
  enrichment.ts  product intelligence
  brand.ts       Brand Brain
  search.ts      discovery
  outfits.ts     styling, ranking, judging, explanation
  looks.ts       merchant-confirmed looks and the outfit graph
  lib/           pure logic: intent, compatibility, taxonomy, judging, retry
  http.ts        storefront, merchant, Shopify and Stripe HTTP surface

/frontend        the storefront runtime — one file, Web Component + Shadow DOM
  tests/         layout and outage suites against real device profiles

/extensions      the Shopify theme app extension (app embed block)

/dashboard       the merchant console (Next.js, server components only —
                 the merchant token never reaches the browser)

/backend         SUPERSEDED. The original Python prototype, kept for
                 history and used by nothing in the shipping path.
```

### Reliability

Disc runs inside other people's storefronts, so failure modes matter more
than features. Each of these is documented with its failure mode, the
invariant introduced, the test that proves it, and how to roll it back:

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
- [`Disc.md`](Disc.md) — the original implementation spec; code comments
  reference its section numbers
- [`Disc audit.md`](Disc%20audit.md) — the traced gap analysis against
  that spec

### Verification

```bash
npm run verify     # typecheck, lint, unit, integration, storefront outage suite
```

The layout suites and the dashboard suite are run separately because they
drive a browser:

```bash
node frontend/tests/devices_test.js    # fits across 14 real device profiles
node frontend/tests/coverage_test.js   # can a shopper see and tap every control
cd dashboard && npm run verify         # typecheck, build, render suite
```
