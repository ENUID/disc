# Product direction — the target architecture

**Status: direction, not backlog. Nothing below is being built yet.**

Recorded after P1.3. The reliability sequence (P1.4 → P1.6) finishes
first, unchanged. This document exists so that the instruction *"before
each subsequent phase, re-read the architecture direction and identify
what is relevant to that phase versus what is explicitly deferred"* is
executable by someone — or some session — that was not present when the
direction was given.

---

## The thesis

Disc is **not** a standalone shopping application that happens to use a
merchant's catalog. It is a **white-label AI shopping layer for Shopify
fashion brands**.

The merchant keeps their storefront, branding, navigation, PDPs and
checkout. Disc is a small branded entry point inside that storefront,
opening into a full-screen experience.

```
ONE DISC SOFTWARE  +  MANY TENANT-SPECIFIC KNOWLEDGE WORLDS
```

The software is Disc. The merchant supplies the world. The shopper
experiences Disc inside that world.

The central loop, which no phase may drift away from:

```
understand the brand -> understand the catalog -> understand the brand's
content -> understand the shopper -> a better shopping decision -> buy
from that brand
```

Entry-point copy is undecided. Candidates: "Your Style", "Personalized
Style", "Personal Stylist", "Discover Your Style". To be tested, not
picked in code.

---

## Five layers

| Layer | What it is | State today |
| --- | --- | --- |
| 1. Storefront runtime | The entry point and the full-screen experience | exists (`frontend/disc-widget.js`); **distribution must change** |
| 2. Decision engine | intent → retrieval → constraints → assembly → ranking → judge → diversity → explanation | exists, correct, **keep** |
| 3. Brand knowledge layer | catalog + product intelligence + Brand Brain + looks + **content** + relationships | partially exists; content is the gap |
| 4. Merchant control plane | install, onboard, correct, manage content, analytics, billing, preview, activate | exists; needs a Content section |
| 5. Reliability / orchestration | durable jobs, idempotency, retry, webhooks, observability, cost | **in progress — P1.4 to P1.6** |

---

## What stays

Retained without rewrite. This is the valuable foundation:

- Tenant-scoped everything — the schema already enforces it and
  `privacy.itest.ts` guards it against drift
- Catalog ingestion with Shopify as the authoritative source of price,
  availability, variants and URLs
- The separation of Shopify source facts (`products`) from model-derived
  inference (`productProfiles`)
- Product Intelligence and Brand Brain
- The Look Builder, including the `detected` / `items` split and the rule
  that only *approved* looks reach the outfit graph
- The staged decision engine
- The cold-start guarantee: looks contribute a capped additive bonus, and
  a tenant with no looks is unaffected
- Compiler-enforced usage metering (`UsageSink` is a required parameter)
- The durable job / idempotency / retry architecture from P1.1–P1.3

---

## What changes, and when

**None of this is in scope until the reliability sequence completes.**

| Phase | Change | Builds on (do not reinvent) |
| --- | --- | --- |
| P2 | Shopify App Embed / Theme App Extension distribution, replacing the pasted script tag | the dormant OAuth app in `convex/shopify/`; the existing widget as runtime |
| P3 | First-class `content` model — image, video, lookbook, editorial, social_post, social_video, article | the `looks` table's shape and its approval semantics |
| P4 | Content → product graph, with explicit relationships | `lookEdges`; `purgeTenant` + the `privacy.itest.ts` schema guard |
| P5 | Video ingestion, scene and timestamp mapping | durable jobs; `looks.imageStorageId` file-deletion handling |
| P6 | Merchant Content dashboard section | `dashboard/` server-component architecture; the token never reaches the browser |
| P7 | Content-aware decision engine — content as **evidence** | the capped-additive-bonus pattern from `rankOutfits` |
| P8 | Preview / activation | `widgetStatus`, already in the schema |
| P9 | Analytics on content influence | `recommendationTraces`, `events` |
| Later | Instagram / TikTok / YouTube connectors, creator content, automated matching | the content abstraction from P3 — connectors are adapters, never core |

---

## Invariants the future work must not break

These are not preferences. Each already has enforcement or a test today,
and each is the kind of thing a new subsystem breaks by accident.

1. **Merchant confirmation is authoritative.** A model may *propose* that
   a content item contains a catalog product. It may never silently
   assert it. This is the same rule that makes `looks.detected` and
   `looks.items` separate fields, and it is the product — not a
   safeguard around it.

2. **Shopify is the commerce truth.** No video model, social post or LLM
   may become the authority for price, availability, variants or
   identity. Derived intelligence stays in separate tables.

3. **Content is evidence, not a ranking dictator.** A campaign video
   showing two items styled together is strong compatibility evidence. It
   must never override an explicit shopper constraint — "under £200", "no
   leather", "available in my size". The capped-additive-bonus pattern
   exists precisely so a new evidence source cannot renormalise the
   existing terms.

4. **Cold start must stay harmless.** A brand that uploads nothing must
   not get worse results than one that does. Tested twice for looks; the
   same two assertions are owed by any content-derived signal.

5. **Tenant isolation, with no global content index.** Every content
   item, relationship, scene and detection belongs to exactly one tenant.
   A shopper in Brand A must never retrieve Brand B's anything. The
   schema-reading guard in `privacy.itest.ts` fails the build when a new
   tenant-scoped table is not purged — new content tables must be added
   to `purgeTenant`, and **file storage is invisible to that guard**, so
   any table holding a storage id needs explicit deletion and its own
   test, as `looks` has.

6. **The storefront degrades safely.** If Disc cannot reach its backend,
   the merchant's own search must not stay hidden. This is P0.1, already
   enforced and tested in `frontend/tests/outage_test.js`. **Moving to an
   App Embed changes how the widget mounts and must not lose it** — the
   suite runs the widget from disk against a stub, so it will still catch
   a regression if the mount path is re-pointed rather than rewritten.

7. **Every expensive operation is a durable job**, tenant-scoped,
   idempotent, bounded, retryable where appropriate, observable, and safe
   under duplicate invocation. `JOB_TYPES` is a closed set and
   `scheduleWorker` throws for a type with no branch, so adding
   `content_ingest`, `image_analysis`, `video_analysis` or
   `content_product_matching` is a deliberate two-place edit rather than
   a silent no-op. That is by design.

---

## Tensions worth deciding early

Recorded now because each is cheaper to settle before P2 than during it.

**P2 has a dependency P1.x does not.** `CLAUDE.md` documents the
script-tag path as a deliberate call: App Store approval takes weeks, and
Shopify requires a theme app extension for a listable app. Moving
distribution to an App Embed therefore depends on a Shopify Partner
account, an app registration, app review, a privacy policy URL and
listing assets — external and slow. It also implies switching billing
from Stripe to Shopify's Billing API (0% of the first $1M, 15% above),
which changes the economics. None of that blocks P1.4–P1.6; all of it
blocks P2. Worth starting the Partner registration in parallel.

**`looks` and `content` will overlap.** A look is an uploaded image with
detected garments, merchant-confirmed product mappings and an approval
step — which is exactly the content pipeline, already built once. P3
should decide deliberately between making `looks` a content *type* and
keeping two systems with a documented boundary. The default of "add
content alongside looks" would leave two approval flows, two purge paths
and two places to fix the same bug.

**Video cost does not scale with catalog size.** Pricing tiers on catalog
size today, on the sound reasoning that it is the only thing that costs
anything real. Vision over video scenes breaks that: a merchant with 40
products and 200 campaign videos is cheap on the current model and
expensive in reality. The metering layer already attributes the spend
correctly — the *pricing model* is what will need revisiting, and §79
still forbids exposing token pricing to merchants.

**P2-7 gets worse before it gets better.** The Brand Brain already
rebuilds unconditionally on every 6-hourly sweep. If approved content
also triggers rebuilds, the churn compounds. Worth fixing before P7
rather than after.

---

## What Disc must not become

- a generic chatbot
- a generic AI search box
- a social-media aggregation product
- an autonomous agent swarm
- a content feed disconnected from commerce
