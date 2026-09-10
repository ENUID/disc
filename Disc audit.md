# DISC — REPOSITORY AUDIT

> **Historical gap analysis against `Disc.md`, kept as written.** For the
> canonical product definition see `README.md`. Where this file says
> "AI Boutique", read it as the spec's name for the shopper experience,
> not as Disc's identity.

Audit of `ENUID/disc` @ `2f70d1f` against `Disc.md` (the master build spec).

**No code was changed to produce this document.** Every claim below was
traced through the actual code path, not inferred from a filename. File
references are `path:line` against the commit above.

Spec §6 asks for this file as `DISC_REPO_AUDIT.md`; it is named
`Disc audit.md` because that is what was explicitly requested. Rename if
you want the spec's name to win.

---

## 0. THE ONE DECISION THAT BLOCKS EVERYTHING

Before any phase can start, one product decision has to be made, because
the spec and the repository's most recent commit point in opposite
directions on it.

**`Disc.md` §10, §13, §77 require the App Store path:** the merchant must
*not* "paste a script" or "edit `theme.liquid`", install must be OAuth →
callback → tenant → dashboard, and the storefront must be reached via a
Theme App Extension / App Embed.

**Commit `2f70d1f` (the current HEAD) deliberately went the other way**,
on explicit instruction that "app building and approval takes time". The
shipping path today is: merchant signs up on our own site, pastes
`<script src=".../embed.js?k=disc_...">` into `layout/theme.liquid`.

These are not reconcilable by compromise, because three subsystems differ
in kind, not degree. I verified each against current Shopify
documentation rather than from memory:

| Subsystem | Self-serve (today) | App Store (spec target) | Verified |
|---|---|---|---|
| Catalog source | public `/products.json`, no auth | GraphQL Admin API, OAuth token | REST Admin API is **legacy as of 2024-10-01**; "Starting April 1, 2025, all new public apps must be built exclusively with the GraphQL Admin API" — shopify.dev/docs/api/admin-rest |
| Billing | Stripe (`backend/billing.py`) | Shopify Billing | "All apps published on the Shopify App Store are required to use a Shopify provided billing solution" — shopify.dev/docs/apps/launch/billing |
| Storefront delivery | merchant pastes script into theme | Theme App Extension + app embed block | "If your app integrates with a Shopify theme and you plan to submit it to the Shopify App Store, you must use theme app extensions" — shopify.dev |

The spec does leave room for a staged approach — §76 and §111 both allow
Stripe "for a private/direct pilot… if it is materially faster for early
sales", and §114 accepts manual onboarding for the first five customers.
So a defensible reading is: **self-serve is the pilot vehicle, App Store
is the destination.** But that has to be a stated decision, because it
determines whether Phase 1 is "build OAuth + GraphQL" or "everything
else, and OAuth later".

My recommendation is in §22 below. **This is the one place I need your
answer before implementing anything.**

A second, smaller consequence: the current `shopify_auth.py` +
`multi_tenant_ingest.fetch_all_products` OAuth path is written against
the **REST** Admin API (`/admin/api/2024-01/products.json`,
`multi_tenant_ingest.py:104`; webhook registration via
`POST /admin/api/2024-01/webhooks.json`, `shopify_auth.py:104`). If the
App Store path is ever taken, that code is **REPLACE, not KEEP** — it
cannot be submitted as-is. It is fine for a *custom/private* app on a
single store, which is the only context it is currently usable in.

---

# PART 1 — CURRENT STATE

## 1. CURRENT PRODUCT ARCHITECTURE

Disc today is **one FastAPI process + one vanilla-JS Web Component**.
There is no separate frontend app, no job queue, no worker, no admin SPA.

What actually exists, end to end:

```
merchant                          shopper
  |                                  |
  POST /sites {domain}               storefront page
  |  probe products.json             |  <script src=/embed.js?k=...>
  |  issue site_key                  |
  |  background full ingest          GET /sites/{k}/status  → mount or stay dormant
  |                                  |
  GET /install?k=...                 POST /search {query, site_key}
  |  snippet + poll status           GET /product/{id}?site_key=...
  |  GET /billing/checkout → Stripe   GET /look/{id}?site_key=...
                                     POST {merchant}/cart/add.js  (direct, not proxied)
```

Four of the spec's "four products inside Disc" (§3):

- **Shopify App** — partially present but dormant/unusable for public
  distribution (see §4 below).
- **Brand Brain** — **does not exist.** No module, no table, no field, no
  prompt. The only per-brand data is a hardcoded default theme object
  (`frontend/disc-widget.js:82-98`) that the shipping install path cannot
  even set (see §13).
- **Decision Engine** — **does not exist as specified.** What exists is
  single-shot vector search (`server.py:233`) plus one heuristic
  cross-category pass (`server.py:346`). No intent parsing, no session,
  no compatibility scoring, no ranker, no judge, no diversity.
- **Merchant Control Plane** — two server-rendered HTML pages
  (`server.py:_SIGNUP_PAGE`, `_INSTALL_PAGE`). No dashboard, no auth, no
  analytics, no brand review.

## 2. CURRENT TECHNICAL ARCHITECTURE

| Layer | Implementation | File |
|---|---|---|
| API | FastAPI, single process, 24 routes | `backend/server.py` |
| Tenant registry | SQLite, one `shops` table | `backend/db.py` |
| Vector store | LanceDB, one table per shop on local disk | `backend/multi_tenant_ingest.py:18` |
| Embeddings | fastembed `BAAI/bge-small-en-v1.5`, 384-dim, ONNX/CPU | `backend/server.py:45` |
| Reasoning | Ollama `phi3` over HTTP, with deterministic fallback | `backend/server.py:47-49` |
| Billing | Stripe REST via `requests`, no SDK | `backend/billing.py` |
| Widget | Vanilla Web Component + Shadow DOM, no build step | `frontend/disc-widget.js` |
| Background work | `BackgroundTasks` + one `asyncio` loop | `server.py:68`, `server.py:74` |

Total dependencies: 7 (`backend/requirements.txt`). No Node build, no
bundler, no ORM, no queue, no cache, no container.

**This minimalism is the repository's main asset and should be
preserved.** Spec §109 explicitly agrees ("Do not buy GPUs. Do not build
Kubernetes.").

## 3. CURRENT DATA FLOW

Ingestion (self-serve path, the one that ships):

```
POST /sites                                   server.py:534
 → public_ingest.normalise_domain()           public_ingest.py:57
 → public_ingest.probe_storefront()           public_ingest.py:97   ← fails fast here
 → db.create_site()                           db.py:81
 → BackgroundTasks → _run_public_ingestion    server.py:571
     → public_ingest.fetch_public_products()  public_ingest.py:73   ← ?page=N pagination
     → multi_tenant_ingest.product_to_record()  multi_tenant_ingest.py:69  (per product)
     → multi_tenant_ingest.write_records()    multi_tenant_ingest.py:129
         → embedder.embed(_embedding_text(r)) multi_tenant_ingest.py:143
         → db.create_table(mode="overwrite")  multi_tenant_ingest.py:147
 → db.set_sync_status(ready, count)           db.py:118
```

Query:

```
POST /search {query, site_key}                server.py:233
 → _resolve_table(shop, site_key)             server.py:200
     → _resolve_tenant()                      server.py:186  ← site_key wins over shop
     → _is_active()                           server.py:673  ← subscription gate
     → lancedb.connect(); open_table()        server.py:227
 → embedder.embed([query])                    server.py:241
 → table.search(vec).limit(n)                 server.py:243
 → per hit: generate_ai_reasoning()           server.py:130  ← N sequential Ollama calls
 → _hit_to_result()                           server.py:256
```

**Note the N-call pattern at `server.py:250`:** one Ollama call *per
result*, sequentially, inside the request. With `resultLimit: 12`
(`disc-widget.js:73`) that is up to 12 sequential 4-second-timeout calls
on the hot path. It is survivable today only because Ollama is usually
absent and the fallback is instant. This directly violates spec §95 ("Do
not do 10 sequential model calls if 4 can run concurrently").

## 4. CURRENT SHOPIFY INSTALL / AUTH FLOW

**Two flows exist. Only one is reachable in the shipping product.**

### 4a. Self-serve (active)

No Shopify authentication of any kind. `POST /sites` (`server.py:534`)
accepts *any* domain from *anyone*, probes its public catalog, and issues
a site key. There is no proof the requester owns the store.

### 4b. OAuth (present, dormant, not App-Store-viable)

- `GET /auth` (`server.py:451`) — validates `shop.endswith(".myshopify.com")`,
  mints a `uuid4` state into the in-process dict `_oauth_states`
  (`server.py:57`), redirects to Shopify consent.
- `GET /auth/callback` (`server.py:460`) — checks state, then
  `shopify_auth.verify_oauth_callback_hmac()` (`shopify_auth.py:40`:
  hex HMAC over sorted `k=v` params), exchanges code, stores token,
  registers webhooks, enqueues ingest.
- Scopes: `read_products` only (`shopify_auth.py:23`). **Correctly
  minimal** and matches spec §11.

Both HMAC schemes are implemented correctly and tested
(`test_multi_tenant.py:63`, `:88`). The *cryptography* is sound. The
*API surface* is not App-Store-viable (REST, see §0).

## 5. CURRENT TENANT MODEL

One SQLite table, `shops` (`db.py:16-28` plus migrations `db.py:30-44`):

```
shop TEXT PRIMARY KEY        -- domain, doubles as tenant id
access_token TEXT NOT NULL   -- PLAINTEXT; empty string for self-serve
scope TEXT NOT NULL
installed_at TEXT
last_synced_at TEXT
product_count INTEGER
sync_status TEXT             -- pending|syncing|ready|error
plan TEXT                    -- added by migration
subscription_id TEXT         -- added by migration
subscription_status TEXT     -- added by migration
site_key TEXT UNIQUE         -- added by migration
source TEXT                  -- 'public' | 'oauth'
email TEXT
```

Against spec §8's required tenant fields: **missing** `tenant_id` (the
domain is the key — renaming a store orphans everything),
`shopify_shop_id`, `installation_id`, `brand_brain_status`,
`widget_status`, `created_at`/`updated_at` as distinct fields.

**Isolation itself is genuinely sound and is the best thing in the
codebase.** One LanceDB table per shop (`table_name_for_shop`,
`multi_tenant_ingest.py:24`), resolved in exactly one place
(`_resolve_table`, `server.py:200`). There is no global index to leak
from. Tested end-to-end through the live endpoint
(`test_multi_tenant.py:137`). This satisfies spec §9 and §35 and should
be preserved as-is.

## 6. CURRENT CATALOG SYNC FLOW

| | Self-serve (active) | OAuth (dormant) |
|---|---|---|
| Initial | `ingest_public_shop` (`public_ingest.py:130`) | `ingest_shop` (`multi_tenant_ingest.py:152`) |
| Pagination | `?page=N`, cap 40 pages / 10k products (`public_ingest.py:41`) | REST `Link` header cursor (`multi_tenant_ingest.py:117`) |
| Incremental | **none** | `products/create|update|delete` webhooks (`server.py:937-971`) |
| Periodic | `_resync_loop`, `DISC_RESYNC_HOURS` default 6 (`server.py:74`) | none |
| Write mode | `mode="overwrite"` — full table replace | same |

Two real problems:

1. **Every sync is a full re-embed and full table overwrite**
   (`multi_tenant_ingest.py:147`). A 10,000-product merchant re-embeds
   all 10,000 products every 6 hours whether or not anything changed.
   Spec §89 asks for reconciliation (diff), not blind replacement.
2. **`_resync_loop` sleeps before its first run** (`server.py:84`), so a
   process restart delays all resyncs by a full interval. Minor, but it
   means "last_synced_at" drift is worse than the configured interval.

## 7. CURRENT PRODUCT DATA MODEL

Two divergent shapes exist:

- `backend/models.py` — Pydantic `Product` / `Variant` / `SearchResult`.
  Used by the **demo** catalog (`ingest.py`) and as the API response
  model.
- `multi_tenant_ingest.product_to_record()` (`multi_tenant_ingest.py:69`)
  — returns a **plain dict**, never a `Product`. This is what every real
  merchant's table actually contains.

Stored fields (`_EMPTY_SCHEMA`, `multi_tenant_ingest.py:211`): `id,
title, description, price, image_url, tags, handle, product_type,
images, variants{id,title,price,available}, colour, vector`.

Against spec §26, the **entire Disc intelligence layer is absent**: no
`garment, fit, volume, silhouette, fabric, weight, drape, pattern,
pattern_scale, color_family, formality, style_vector, occasion_vector,
season_vector, logo_level, visual_weight, confidence, provenance`. Spec
§27 provenance does not exist in any form.

Two concrete defects found in the current shape:

- **`currency` is never ingested.** `models.py:39` and `:60` default it
  to `"USD"`, `product_to_record` never sets it, and the LanceDB schema
  has no column for it. Every non-USD merchant's prices render with the
  wrong symbol (`disc-widget.js:996-1004`). This is a live bug, not a
  gap.
- **`colour` is taken from `variants[0].option1`**
  (`multi_tenant_ingest.py:96`). That is a convention, not a contract —
  on a store whose first option is Size, `colour` silently becomes `"8"`.
  Observed in testing against a real store.

## 8. CURRENT AI / MODEL FLOW

| Role | Implementation | Provider abstraction? |
|---|---|---|
| Embedding | `fastembed.TextEmbedding`, loaded once at startup (`server.py:63`) | **none** — imported and called directly |
| Reasoning | Ollama HTTP `phi3` (`server.py:130`, `:308`) | **none** — URL + model are module constants |
| Vision | **does not exist** | — |

Against spec §83 (`ReasoningProvider` / `VisionProvider` /
`EmbeddingProvider` interfaces, model routing, benchmarking): none of
this exists. Both AI call sites hardcode one vendor, one model, one
endpoint.

The **fallback contract is genuinely good design and matches spec §85's
intent**: `generate_ai_reasoning` (`server.py:130`) and
`generate_styling_note` (`server.py:308`) both catch `RequestException`
and return a deterministic templated sentence, so the API response shape
never changes based on whether Ollama is up. Preserve this pattern; give
it a provider interface around it.

But note what is *not* validated: the model's output is used as free
prose with **no schema validation whatsoever** (spec §85 requires it).
That is currently low-risk only because the output is a display-only
sentence. The moment a model output drives a decision, this becomes a
correctness hole.

## 9. CURRENT PROMPTS

Exactly two, both inline string literals in route-adjacent functions —
precisely what spec §84 forbids ("No giant prompt hidden in a route
file"):

| Prompt | Location | Versioned? |
|---|---|---|
| "why this matched" | `server.py:137-146` | no |
| "HOW TO STYLE" | `server.py:311-319` | no |

No registry, no version tags, no recorded prompt version on any response.
Spec's `brand_extract_v1`, `product_profile_v1`, `intent_parse_v1`,
`outfit_generate_v1`, `outfit_judge_v1`, `explanation_v1` — none exist.

## 10. CURRENT SEARCH / RETRIEVAL FLOW

`POST /search` (`server.py:233`) is the whole of it:

```
query string → embed → LanceDB kNN (limit N) → per-hit LLM sentence → return
```

There is **no** intent parsing, **no** hard filters (budget, category,
availability, banned attributes), **no** query planning, **no** re-rank.
`request.limit` defaults to 3 (`server.py:111`) and the widget asks for
12.

Against spec §44-§48: the pipeline `intent → query plan → candidate pool
→ normalization → hard filters → semantic retrieval → fashion-aware
ranking` exists only as its sixth step. Spec §45's four-way separation
(retrieval / compatibility / ranking / judging) is collapsed into one
kNN call.

Sold-out products are retrieved and shown. Availability is stored
per-variant (`_variant_available`, `multi_tenant_ingest.py:50`) but never
used as a filter anywhere.

## 11. CURRENT OUTFIT / RECOMMENDATION FLOW

`GET /look/{id}` (`server.py:346`) is the only thing resembling styling.
Its actual algorithm:

1. Fetch anchor row by id.
2. kNN over the whole shop table, pool `min(count, max(200, limit*50))`.
3. Skip the anchor itself; skip any hit whose `product_type` equals the
   anchor's; skip any `product_type` already seen.
4. Return the first `limit` survivors.

This is **one product per other category, ranked purely by embedding
distance to the anchor**. It is a reasonable heuristic and it does
produce plausible output (verified on a real store: a wool runner
returned socks / sweatpants / underwear). But measured against spec
§49-§59 it is not an outfit engine:

- no slot model (`top/bottom/shoes/outerwear/accessories`) — categories
  are whatever strings the merchant happened to type into `product_type`
- no pair scoring (color, silhouette, formality, pattern, material)
- no whole-outfit composition score
- no brand coherence score
- no judge, no diversity pass, no confidence
- no combination generation at all — it never considers a *set*, only a
  list of individually-near items

**Known failure mode, unfixed:** on a store that leaves `product_type`
blank (common on small catalogs), `own_type` is `""`, the equality skip
at `server.py:390` is disabled by the `own_type and` guard, and the
seen-types skip at `:394` is disabled by the `hit_type and` guard — so
the endpoint returns the N nearest neighbours, i.e. exactly the
near-duplicate result the function exists to prevent.

## 12. CURRENT WIDGET / STOREFRONT FLOW

`frontend/disc-widget.js`, 1,768 lines, one `<disc-search-bar>` custom
element (`:103`), everything inside one `attachShadow({mode:"open"})`.

Boot (`init`, `:1732`):

```
site key present?
  no  → mount immediately, hide native search      (demo path)
  yes → GET /sites/{k}/status
          active === false → do nothing at all     (dormant)
          otherwise        → mount + hide native search
```

`goDormant()` (`:1719`) restores every input it hid. This is a genuinely
good safety property and satisfies spec §14 and §418 ("Disc is an
enhancement… must never become a single point of failure"). It is tested
in both directions against a live billing-enabled backend
(`frontend/tests/dormant_test.js`).

UI states: idle bar → loading canvas → results grid → product detail
(MATERIALS / HOW TO STYLE chips, size picker, add-to-cart, paged 2×2 look
grid) → wishlist in `localStorage`.

Commerce: `addToCart` (`:1097`) posts to `/cart/add.js` on the merchant's
own domain. Disc never proxies commerce. Correct, and matches spec §14's
spirit.

Against spec §41-§43 the widget exposes **one** entry point ("what are
you looking for"). Missing: `Style this`, `Complete the look` as a shopper
verb, `Find similar`, `Compare`, `Refine`. Spec §42 page context
(`product_id`, `collection_id`, `page_type`) is **not read at all** — the
widget never inspects what page it is on, so "style this" is not
expressible.

Two further gaps against spec §62-§66:

- The widget is not lazy-loaded and is not code-split (spec §94). The
  whole 1,768-line file plus all CSS is parsed on every storefront page
  load, before any interaction.
- Per-merchant theming is **structurally unreachable through the shipping
  install path** — see §13.

## 13. CURRENT MERCHANT EXPERIENCE

Two server-rendered pages, no authentication on either:

- `GET /` (`server.py:616`) — domain + email form, posts to `/sites`.
- `GET /install?k=` (`server.py:621`) — snippet, paste instructions,
  status poll, Stripe CTA.

That is the entire merchant surface. Against spec §70's required
sections (Overview, Brand, Catalog, AI Boutique, Analytics, Billing,
Settings): **only a fragment of Catalog (a product count) and a Billing
link exist.**

**The theming gap is worth calling out separately**, because the
repository documents a capability the product cannot actually deliver.
`DISC_THEME` (`disc-widget.js:82`) merges `window.DiscConfig.theme`, so
per-merchant branding is *implemented in the widget*. But:

- `/embed.js` (`server.py:585`) injects only `apiUrl` and `siteKey`.
- `db.py` has **no theme column** — there is nowhere to store a
  merchant's brand tokens.
- There is no UI to set them.

So a merchant who follows the documented install path gets the hardcoded
cream/serif default, and the only way to change it is to hand-write a
`window.DiscConfig` block into their theme *before* the script tag —
which is exactly the manual theme editing the spec forbids. The
capability exists in the renderer and nowhere else in the pipeline.

## 14. CURRENT BILLING

`backend/billing.py`, Stripe over raw `requests` (no SDK, deliberate).

- `PLANS` (`billing.py:56`) — starter/growth/boutique at $29/$79/$199,
  tiered on catalog size, price IDs from env.
- `create_checkout_session` (`billing.py:117`) — Checkout, 14-day trial,
  shop carried in `client_reference_id` + metadata.
- `verify_webhook_signature` (`billing.py:161`) — `t=…,v1=…`, HMAC over
  `{ts}.{raw body}`, **with a 300-second replay guard**. Correct, and
  tested including the stale-timestamp case
  (`test_multi_tenant.py:test_stripe_webhook_signature`).
- `POST /webhooks/stripe` (`server.py:761`) — verifies before parsing,
  then caches status onto the shop row.
- `billing.enabled()` (`billing.py:87`) — False without
  `STRIPE_SECRET_KEY`, which is what keeps dev/tests from being gated.

Enforcement: `_is_active()` (`server.py:673`) is the single definition,
read by both `_resolve_table` and `/sites/{k}/status`. Cached in SQLite
rather than queried per search — correct, and the webhook is what makes
cancellation take effect.

Against spec §77/§112 pricing hypothesis ($149–$299 / $499–$799 /
$1,500+): **current placeholder plans are 5–10× below the spec's
hypothesis.** Not a code defect, but the numbers in `billing.py` and the
numbers in `Disc.md` disagree and one of them should move.

Against spec §76/§111: only one billing source is active, which satisfies
"never have two active billing sources". If the App Store path is taken,
Stripe must be **retired**, not supplemented.

## 15. CURRENT ANALYTICS

**Nothing exists.** No event table, no event endpoint, no client-side
tracking, no aggregation, no dashboard.

Spec §80 lists 16 required events (`widget_opened`, `query_submitted`,
`intent_created`, `outfit_generated`, `product_clicked`, `add_to_cart`,
`checkout_started`, `purchase`, …). Zero are emitted.
Spec §81's `RecommendationTrace` — the thing that answers "why did Disc
recommend that?" — does not exist in any form. There is no
`recommendation_id` anywhere in the codebase.

This is the **largest single gap** relative to the spec's stated business
model, because §75, §78, §113 and §139 all justify the price with
merchant-visible commerce impact that is currently unmeasurable.

## 16. CURRENT TESTING

| Suite | Location | Covers | Runs |
|---|---|---|---|
| Backend | `backend/test_multi_tenant.py` | 52 checks: 3 signature schemes (Shopify OAuth hex, Shopify webhook base64, Stripe `t=,v1=` + replay), both product-JSON shapes, self-serve signup, per-shop isolation via live `/search`, storefront endpoints | needs server up |
| Ranking | `test_search.py` | one semantic-intent assertion on the demo catalog | needs server up |
| Layout | `frontend/tests/devices_test.js` | 14 device profiles, fit + reachability + no horizontal scroll + no JS errors | Playwright |
| Coverage | `frontend/tests/coverage_test.js` | `elementFromPoint` occlusion, clipped text, overlapping siblings, last row not under bar | Playwright |
| Dormancy | `frontend/tests/dormant_test.js` | inactive tenant stays dormant *and* leaves native search alone; active tenant takes over | needs billing-enabled backend |

**What is genuinely well covered:** tenant isolation, all three signature
schemes, both ingestion shapes, layout across real devices, and the
storefront-safety property.

**What is not covered at all:** every AI behaviour. There is no
evaluation suite (spec §98 asks for 100–300 benchmark cases), no quality
metric, no regression check on recommendation quality. `test_search.py`
is a single hand-written assertion, not a benchmark.

Also absent: any CI. There is no workflow file in the repository — the
only GitHub Actions entry is Shopify-unrelated (`Dependency Graph`,
auto-generated by GitHub). Nothing runs these suites automatically.

## 17. CURRENT DEPLOYMENT

**There is no deployment configuration of any kind.** No Dockerfile, no
Procfile, no fly/render/railway manifest, no `.env.example`, no CI, no
systemd unit. Confirmed by directory listing.

Configuration is entirely environment variables read at import time:
`PUBLIC_URL`, `DISC_RESYNC_HOURS`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `DISC_TRIAL_DAYS`,
`DISC_CURRENCY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_SCOPES`, `APP_URL`, `OLLAMA_*` (constants, not env).

**Single-process by construction**, and the constraints are real:

- `_oauth_states` is an in-process dict (`server.py:57`) — a second
  worker breaks OAuth.
- SQLite with default settings — no WAL, no pooling.
- LanceDB tables are local disk — that disk *is* the state.
- `_resync_loop` is an asyncio task in the web process — N workers means
  N concurrent resyncs of the same catalog.

`PUBLIC_URL` is baked into every install snippet at request time
(`server.py:596`); a startup warning fires if it still looks like
localhost (`server.py:67`).

## 18. CURRENT SECURITY / PRIVACY

**What is done correctly:**

- Both Shopify HMAC schemes verify against the **raw body before
  parsing** (`server.py:_verify_and_parse_webhook`), which is the right
  order. Same for Stripe (`server.py:768`).
- Stripe replay guard present (`billing.py:181`).
- OAuth CSRF `state` token present and checked.
- Scopes minimal (`read_products`).
- No shopper PII collected. Wishlist is `localStorage` only
  (`disc-widget.js:1007`), never transmitted.
- Disc never proxies commerce; cart calls go to the merchant's own domain.

**Findings, in severity order. S1, S2 and S3 were confirmed empirically
against the running server, not inferred from reading the code.**

**S1 — The site key is a public identifier used as a bearer credential
for control-plane actions.** It is documented as non-secret (it ships in
a public storefront's HTML, `server.py:520-524`) and that reasoning is
correct *for search*. But the same key alone authorises:
- `POST /sites/{key}/resync` (`server.py:702`) — anyone reading a
  storefront's source can force unlimited full catalog re-embeds.
- `GET /billing/checkout?k=` (`server.py:731`) — start a Stripe checkout
  in that merchant's name.
- `GET /sites/{key}/status` (`server.py:664`) — read their product count,
  plan and subscription state.
These need a real merchant credential, not the public key. Confirmed:
`POST /sites/{key}/resync` and `GET /sites/{key}/status` both returned
HTTP 200 given nothing but the key.

**S2 — `POST /sites` is completely unauthenticated** (`server.py:534`).
Anyone can register any domain they do not own and cause Disc to fetch
and embed that store's entire catalog. Both an abuse vector and an
unbounded cost vector. No ownership proof, no rate limit, no CAPTCHA.
Confirmed: registering `allbirds.com` — a store nobody here owns —
succeeded and returned a working site key.

**S3 — Filter injection in `/product/{id}` and `/look/{id}`.
CONFIRMED EXPLOITABLE, not theoretical.** Three sites interpolate
unvalidated input into a LanceDB filter predicate:
- `server.py:281` — `where(f"id = '{product_id}'")`, `product_id` taken
  straight from the URL path
- `multi_tenant_ingest.py:191` and `:200` — `delete(f"id = '{...}'")`

Verified against the running server:

```
GET /product/p001                  → 200, "Olive Linen Overshirt"   (correct)
GET /product/x' OR '1'='1          → 200, "Olive Linen Overshirt"   (WRONG — id never matched)
```

The predicate becomes `id = 'x' OR '1'='1'`, which matches every row, and
the endpoint returns the first one. The id lookup is fully bypassable.
Consequences: an id-specific endpoint becomes a catalog enumerator, and
`/look/{id}` will anchor on an arbitrary product.

Blast radius is bounded to the requesting tenant's own table, because
`_resolve_table` picks the table *before* the filter runs — so this is
**not** a cross-tenant leak, and spec §9 still holds. It should
nonetheless be treated as the highest-priority fix here: it is a working
injection against a live endpoint.

**S4 — Shopify access tokens stored in plaintext** (`db.py:20`). Spec §90
requires "encrypted credential storage". Currently empty-string for all
self-serve tenants, so the exposure is latent rather than live — but it
becomes live the moment the OAuth path is used.

**S5 — No rate limiting anywhere.** `/search` runs an embedding per
request; `/product` and `/look` can trigger Ollama calls. No limiter, no
quota, no per-tenant budget (spec §86, §90).

**S6 — CORS `allow_origins=["*"]`** (`server.py:102`). Necessary for an
embedded widget, but combined with S1 it means any origin can call the
control-plane routes.

**S7 — `_oauth_states` grows without bound** (`server.py:57`). Entries
are only removed on successful callback; abandoned installs accumulate
for the process lifetime.

**Privacy:** spec §92 asks for a documented data-handling policy
(what is read, retention, deletion, cross-tenant use). No such document
exists. There are no `/privacy` or `/terms` routes (spec §15 lists both).
GDPR webhook handlers exist (`server.py:1012-1035`) and `shop/redact`
does really delete the tenant's table and row.

## 19. CURRENT LIMITATIONS AND FAILURE POINTS

Ordered by how likely they are to hurt a real merchant:

1. **No brand intelligence at all** — every merchant gets identical
   behaviour and identical visual identity. This is the product's core
   claim and it is absent.
2. **No analytics** — the merchant cannot see any value, and we cannot
   diagnose a bad recommendation.
3. **`product_type`-blank stores get near-duplicate "outfits"** (§11).
4. **Wrong currency for every non-USD merchant** (§7).
5. **`colour` is wrong whenever option1 isn't colour** (§7).
6. **Full re-embed every 6h regardless of change** (§6) — cost and
   latency scale with catalog, not with churn.
7. **N sequential LLM calls on the search hot path** (§3).
8. **Public catalog only** — drafts invisible; a merchant who disables
   `products.json` silently breaks Disc.
9. **Single process** — no horizontal scale (§17).
10. **No CI** — the suites that exist are only run by hand.

---

# PART 2 — SPEC COMPARISON

Status key: **ABSENT** · **PARTIAL** · **PRESENT** · **CONFLICT** (exists
but contradicts the spec).

| SUBSYSTEM | CURRENT IMPLEMENTATION | TARGET SPEC | STATUS | ACTION | EXACT FILES | RISKS | DEPENDENCIES |
|---|---|---|---|---|---|---|---|
| Shopify install/auth | OAuth built but dormant + REST-based; shipping path has no Shopify auth at all | §10, §12: OAuth → callback → tenant → dashboard, no code paste | CONFLICT | REPLACE (if App Store) / KEEP dormant (if pilot) | `backend/shopify_auth.py`, `server.py:451-500` | REST barred for new public apps since 2025-04-01 | §0 decision |
| Admin API client | REST `2024-01` (`products.json`, `webhooks.json`) | §5, §177: GraphQL Admin API | CONFLICT | REPLACE | `multi_tenant_ingest.py:104,117`, `shopify_auth.py:99-107` | Hard App-Store blocker | §0 decision |
| Catalog source | public `products.json` | §29: Shopify Admin, background jobs | PARTIAL | KEEP for pilot; ADD GraphQL alongside | `backend/public_ingest.py` | Published-only; merchant can disable | §0 decision |
| Storefront delivery | merchant pastes `<script>` into `theme.liquid` | §13: Theme App Extension + app embed | CONFLICT | ADD extension (if App Store) | `server.py:585` `/embed.js` | Spec explicitly forbids the paste | §0 decision |
| Tenant model | `shops` table keyed on domain | §8: tenant_id, shopify_shop_id, installation_id, statuses | PARTIAL | REFACTOR | `backend/db.py` | Domain-as-key breaks on rename | none — do early |
| Tenant isolation | one LanceDB table per shop, one resolver | §9, §35 | PRESENT | **KEEP — do not touch** | `multi_tenant_ingest.py:24`, `server.py:200` | — | — |
| Vector index | LanceDB local, 384-dim bge-small | §110: keep, document limits | PRESENT | KEEP | `multi_tenant_ingest.py:18,211` | single-process | — |
| Product source layer | id/title/desc/price/images/variants/handle/type/colour | §26 source layer | PARTIAL | REFACTOR (+currency, +collections, +inventory) | `models.py`, `multi_tenant_ingest.py:69` | currency bug live | none |
| Product intelligence layer | **none** | §26–§28: ~18 fashion attributes + taxonomy | ABSENT | ADD | new module | Largest data-model gap | product model refactor |
| Provenance | **none** | §27: value/source/model/confidence/version/timestamp | ABSENT | ADD | new | Cannot audit inferences | intelligence layer |
| Vision enrichment | **none** | §32: garment/fit/silhouette/pattern/colour from images | ABSENT | ADD | new | Cost control critical | provider iface, cache |
| Enrichment cache | **none** | §31: key on tenant+product+image+schema+prompt+model version | ABSENT | ADD | new | Re-vision on every request = cost blowup | vision |
| Embeddings | fastembed bge-small, text-only | §34: semantic + visual + style similarity | PARTIAL | KEEP text; ADD image later | `server.py:63`, `multi_tenant_ingest.py:143` | — | — |
| Provider abstraction | **none** — Ollama + fastembed hardcoded | §83: Reasoning/Vision/Embedding interfaces + routing | ABSENT | ADD | `server.py:130,308` | Vendor lock, no benchmarking | — |
| Prompt registry | 2 inline literals, unversioned | §84: named, versioned, recorded per response | ABSENT | ADD | `server.py:137,311` | Silent quality drift | provider iface |
| Model output validation | **none** | §85: schema-validate everything | ABSENT | ADD | `server.py:130,308` | Low risk today, blocking later | provider iface |
| Brand Brain | **none** | §20–§25: structured, versioned tenant intelligence | ABSENT | ADD | new | The core product claim | catalog + enrichment |
| Brand visual profile | hardcoded `DISC_THEME` default; no persistence, not in `/embed.js` | §21, §64, §65: derived tokens, per tenant | PARTIAL | REFACTOR + ADD storage | `disc-widget.js:82`, `server.py:585`, `db.py` | Documented but undeliverable | tenant model |
| Intent engine | **none** — raw string → embedding | §38, §39: deterministic + reasoning, schema-validated | ABSENT | ADD | new | — | provider iface |
| Shopper session | **none** — every query standalone | §36, §37: structured session state | ABSENT | ADD | new + widget | "Make it cheaper" impossible | intent |
| Page context | **none** — widget never reads the page | §42: product_id/collection_id/page_type | ABSENT | ADD | `disc-widget.js:1732` | "Style this" impossible | widget |
| Workflows | 1 (search) + `/look` | §43: SEARCH, SIMILAR, STYLE_PRODUCT, COMPLETE_LOOK, OUTFIT, COMPARE, REFINE | PARTIAL | ADD | `server.py:233,346` | — | intent, session |
| Hard filters | **none** — sold-out items are returned | §47: tenant, category, availability, budget | ABSENT | ADD | `server.py:243` | Shows unbuyable products | product model |
| Compatibility engine | **none** | §49–§53: colour/silhouette/formality/pattern/material scoring | ABSENT | ADD | new | Cannot build real outfits | intelligence layer |
| Outfit object | **none** — flat list | §56: slots, direction, scores, issues, confidence | ABSENT | ADD | new | — | compatibility |
| Ranker | embedding distance only | §55 hierarchy incl. brand coherence + merch boosts | ABSENT | ADD | `server.py:386-400` | — | compatibility, Brand Brain |
| Judge | **none** | §57, §58: independent critic, structured scores | ABSENT | ADD | new | — | outfit engine |
| Diversity | one-per-`product_type` heuristic | §59: palette/silhouette/formality/style diversity | PARTIAL | REPLACE | `server.py:392-396` | Fails on blank product_type | product intelligence |
| Explanation | 1 Ollama sentence from title/desc/tags | §60: generated from actual score components | PARTIAL | REFACTOR | `server.py:130` | Not evidence-based → invented reasons | ranker scores |
| Widget shell | Web Component + Shadow DOM, device-tested | §62–§66 | PRESENT | **KEEP** | `frontend/disc-widget.js` | — | — |
| Widget entry points | 1 (search box) | §41: 5 entry points | PARTIAL | ADD | `disc-widget.js:298` | — | page context |
| Widget performance | full 1,768-line file parsed on every page | §94: lazy load, code split, small initial bundle | PARTIAL | REFACTOR | `frontend/disc-widget.js` | Storefront perf | — |
| Storefront failure safety | boot status check + `goDormant()`, tested both ways | §14: store must survive Disc being down | PRESENT | **KEEP** | `disc-widget.js:1703-1760`, `tests/dormant_test.js` | — | — |
| Merchant dashboard | 2 unauthenticated HTML pages | §70–§74: 7 sections | ABSENT | ADD | `server.py:616,621` | No merchant auth at all | tenant model, analytics |
| Merchant auth | **none** | §12, §90 | ABSENT | ADD | — | S1, S2 | tenant model |
| Marketing site | one signup form | §15, §16: full route set | ABSENT | ADD | `server.py:616` | — | — |
| Billing | Stripe, working, tested | §76, §111: Shopify-native for App Store; Stripe OK for pilot | PARTIAL | KEEP for pilot / REPLACE for App Store | `backend/billing.py` | Two sources would need reconciliation | §0 decision |
| Pricing | $29/$79/$199 | §77: $149–299 / $499–799 / $1,500+ | CONFLICT | REFACTOR (numbers only) | `billing.py:56` | Under-pricing vs stated model | — |
| Analytics events | **none** | §80: 16 events, tenant+session scoped | ABSENT | ADD | new | Merchant sees no value | tenant model |
| Recommendation trace | **none** | §81: full lineage per result | ABSENT | ADD | new | Cannot answer "why this?" | versioning |
| Debug panel | **none** | §82 | ABSENT | ADD | new | Support impossible | trace |
| Background jobs | `BackgroundTasks` + 1 asyncio loop | §87: 8 job types, idempotent | PARTIAL | REFACTOR | `server.py:74,571` | Jobs die with the process | — |
| Job idempotency | **none** | §88: deterministic keys | ABSENT | ADD | new | Duplicate work | jobs |
| Reconciliation | blind full overwrite | §89: diff and repair | PARTIAL | REFACTOR | `multi_tenant_ingest.py:129` | Cost scales with catalog not churn | — |
| Evaluation suite | 1 assertion | §98–§101: 100–300 cases, 12 dimensions, error taxonomy | ABSENT | ADD | `test_search.py` | Silent AI regressions | decision engine |
| Versioning | **none** | §117: 9 version axes | ABSENT | ADD | — | Cannot reproduce a recommendation | trace |
| Security — credential storage | plaintext tokens | §90: encrypted | PARTIAL | REFACTOR | `db.py:20` | S4 | tenant model |
| Security — rate limiting | **none** | §90 | ABSENT | ADD | `server.py` | S5 | — |
| Security — webhook verify | correct, raw-body-first, all 3 schemes tested | §91 | PRESENT | **KEEP** | `server.py:918`, `billing.py:161` | — | — |
| Privacy policy | **none** | §92, §15 | ABSENT | ADD | — | App Store blocker | — |
| Deployment | nothing | §118 | ABSENT | ADD | — | Cannot ship | — |
| CI | nothing | §118 | ABSENT | ADD | — | Suites only run by hand | — |

---

# PART 3 — CODE HEALTH

## Duplicate systems

1. **Two ingestion paths** — `public_ingest.ingest_public_shop` and
   `multi_tenant_ingest.ingest_shop`. *Not* true duplication: they share
   `product_to_record` and `write_records`, differing only in fetch. This
   is correct factoring; keep it.
2. **Two product shapes** — `models.Product` (Pydantic, demo only) vs
   `product_to_record`'s dict (real merchants). These *are* duplicative
   and they drift: `currency` exists in one and not the other, which is
   the source of the currency bug. **Consolidate.**
3. **Two tenant identifiers** — `site_key` and `shop`, both accepted by
   `/search`, `/product`, `/look`. Deliberate for back-compat, resolved
   in one place (`_resolve_tenant`). Acceptable; revisit after the §0
   decision.
4. **Two status endpoints** — `/sites/{key}/status` and
   `/shops/{shop}/status` (`server.py:664`, `:686`) return near-identical
   payloads. Minor; collapse when merchant auth lands.

## Dead / unused code

- `Product.currency` and `SearchResult.currency` (`models.py:39,60`) —
  never populated from any real source.
- `Product.embedding_text()` (`models.py:41`) — the multi-tenant path
  uses `multi_tenant_ingest._embedding_text` instead; only `ingest.py`
  calls the model method.
- `shopify_auth.py` in its entirety, plus `server.py:451-500` and the
  four Shopify product/subscription webhook handlers — **dormant, not
  dead.** Reachable only if `SHOPIFY_API_KEY` is set. Keep, but label.
- `SearchResponse.status` docstring (`server.py:124-127`) documents only
  `ready`/`syncing`; `inactive` was added later and is undocumented.

## Experimental / prototype shortcuts

- The Ollama dependency itself — optional by design, absent in practice.
  Every deployment so far has run on the deterministic fallback, meaning
  **the "AI explanation" the product markets has never actually run in
  anger.**
- `GET /placeholder/{name}` (`server.py:405`) — demo-only SVG generator.
  Harmless, correctly scoped, but it is prototype scaffolding.
- `_infer_product_type` / `_SIZES_BY_TYPE` (`ingest.py:187,178`) —
  keyword heuristics for the demo catalog only.
- `test.html` — fake storefront. Keep; it is what the device suites run
  against.

## Risky code

- `server.py:281`, `multi_tenant_ingest.py:191,200` — **working filter
  injection** (S3), confirmed by request.
- `server.py:534` — unauthenticated tenant creation (S2).
- `server.py:702,731` — control-plane actions gated by a public key (S1).
- `server.py:57` — unbounded in-memory dict (S7).
- `server.py:250` — N sequential blocking LLM calls in a request handler.
- `multi_tenant_ingest.py:147` — `mode="overwrite"` means a failed
  mid-sync leaves the shop with a **partially rebuilt or empty** index.
  There is no atomic swap and no rollback.

## Architecture that should be preserved

These are correct, tested, and hard-won. Do not refactor them for
tidiness:

1. **Per-shop LanceDB table + single `_resolve_table` chokepoint.** The
   whole isolation guarantee rests on this and it is clean.
2. **The graceful-degradation contract** — Ollama down never changes the
   API response shape.
3. **`goDormant()` + boot status check.** A storefront must never lose
   its search box because of us. Tested in both directions.
4. **Raw-body-before-parse webhook verification**, all three signature
   schemes, all tested.
5. **`_variant_available` / `_tag_list`** — the two-source parsing
   helpers. These encode a real, verified, silent-corruption bug class.
6. **Cart calls go direct to the merchant's domain.** Never proxy
   commerce.
7. **Seven dependencies, no build step.** Spec §109 agrees. Defend this.

## Architecture that will prevent the target product from working

1. **REST Admin API** — hard blocker for App Store distribution.
2. **No shopper session** — the widget sends a bare string and keeps
   nothing. Spec §37, §40, §61 (follow-ups, slot swaps, refinement) are
   all unreachable without this. It is the deepest structural gap in the
   client.
3. **No product intelligence layer** — compatibility, ranking, judging
   and brand coherence all read attributes that are never computed. Every
   Phase 10/11 feature is blocked on this one gap.
4. **Domain-as-tenant-key** — blocks `shopify_shop_id` correlation and
   breaks on domain change.
5. **Single-process assumptions** (`_oauth_states`, local LanceDB,
   in-process resync loop) — fine now, blocks horizontal scale.
6. **No trace/versioning** — spec §81, §117 and the entire §102 learning
   loop are unimplementable retroactively; traces must be written from
   the first recommendation or the history is lost.

---

# PART 4 — RECOMMENDATIONS

## 20. Biggest architectural gaps, ranked

1. **Brand Brain is entirely absent** — the product's central claim.
2. **Product intelligence layer is absent** — blocks every styling,
   compatibility and ranking feature downstream.
3. **No analytics or recommendation trace** — merchant cannot see value,
   we cannot debug quality, and §102's learning loop cannot start later
   because the data is never written.
4. **No shopper session or intent model** — refinement, follow-ups and
   slot swaps are structurally impossible today.
5. **Distribution conflict (§0)** — self-serve vs App Store, unresolved,
   blocking three subsystems.
6. **No merchant control plane or merchant auth** — plus S1/S2, which are
   live security issues today, not future ones.
7. **No evaluation harness** — every AI change from here is unmeasurable.

## 21. Recommended implementation order

The spec's own phase list (§122) is sound. I would reorder three things,
for reasons of dependency and risk rather than preference:

- **Bring security forward.** S1 and S2 are live and cheap to fix. They
  should not wait for Phase 14.
- **Bring trace/events forward.** Spec puts analytics at Phase 12, but
  traces cannot be backfilled. Write the event + trace spine *before* the
  decision engine, so every recommendation is traceable from the first
  one.
- **Bring evaluation forward, in skeleton.** 20 cases before Phase 9 is
  worth more than 300 after Phase 11.

Proposed order:

```
1  Security + tenant model hardening   (S1,S2,S3,S4; tenant_id; theme storage)
2  Canonical product model + currency  (spec Phase 4; fixes 2 live bugs)
3  Event + trace spine                 (spec Phase 12, moved early)
4  Product enrichment + taxonomy       (spec Phase 5 — the unblocker)
5  Brand Brain v1                      (spec Phase 6)
6  Merchant dashboard + auth           (spec Phase 13 + 7)
7  Intent + session                    (spec Phase 9)
8  Compatibility + outfit engine       (spec Phase 10)
9  Ranking + judge + diversity         (spec Phase 11)
10 Evaluation suite proper             (spec Phase 15)
11 Distribution decision executed      (Phase 1/2/3/8 — GraphQL + extension, if chosen)
12 Production hardening                (spec Phase 16)
```

Note that **11 is deliberately late**: if the pilot path is chosen,
everything above delivers merchant value without touching distribution,
and the App Store migration becomes a swap of three well-isolated
subsystems rather than a prerequisite.

## 22. My recommendation on §0

**Stage it: pilot on self-serve, build toward the App Store.**

Reasoning:
- The spec permits it (§76, §111, §114).
- Nothing in items 1–10 above depends on the distribution choice. Brand
  Brain, product intelligence, trace, session and outfit engine are all
  identical either way.
- The App Store migration is genuinely isolated: swap `public_ingest` for
  a GraphQL client, add a theme extension, swap Stripe for Shopify
  Billing. Three subsystems, each already behind a seam.
- The one thing to do *now* is stop writing new code against the REST
  Admin API, since it can never ship publicly.

**But this is your call, not mine** — it is a business decision about
time-to-first-revenue versus conformance to the spec's stated target, and
I have deliberately not acted on it.

## 23. Recommended Phase 1

**PHASE:** Security + tenant model hardening.

**GOAL:** No control-plane action is authorised by a public identifier;
no unauthenticated party can create a tenant or trigger unbounded work;
the tenant row carries a stable identity and can hold brand tokens.

**IN SCOPE:**
- Merchant credential distinct from `site_key` (opaque session token,
  emailed magic link or password — simplest sufficient mechanism).
- Gate `/sites/{key}/resync`, `/billing/checkout`, `/install` and the
  status endpoints on that credential; leave `/search`, `/product`,
  `/look` and `/embed.js` keyed by `site_key` (correct as-is).
- Ownership proof + rate limit on `POST /sites`.
- Parameterise or strictly validate the three LanceDB filter strings.
- `tenant_id` (stable, non-domain), `shopify_shop_id`, `created_at`,
  `updated_at`, `brand_tokens` (JSON), `widget_status` on `shops`.
- Encrypt `access_token` at rest.
- Bound `_oauth_states` with a TTL.

**OUT OF SCOPE:** Brand Brain, enrichment, dashboard UI, the §0
distribution decision, any AI change, any widget UX change.

**DATA CHANGES:** additive `ALTER TABLE` migrations only, in the existing
`db._MIGRATIONS` list — no new database, no ORM, no rewrite.

**AI CHANGES:** none.

**UI CHANGES:** `/install` gains a login gate; no storefront change.

**FAILURE HANDLING:** every new check fails closed on the control plane
and **open on the storefront** — a shopper-facing request must never
break because an auth check errored.

**TESTS:** extend `backend/test_multi_tenant.py`: public site key cannot
resync / cannot start checkout / cannot read status; unauthenticated
`POST /sites` is rejected; a `'`-bearing product id cannot alter a filter;
existing 52 checks still pass. `frontend/tests/dormant_test.js` must stay
green — the storefront path is untouched.

**ACCEPTANCE:** all existing suites green; the four new abuse cases
rejected; no storefront behaviour change observable in the device and
coverage suites.

**FILES PHASE 1 WOULD TOUCH:**

| File | Change |
|---|---|
| `backend/db.py` | new columns via `_MIGRATIONS`; `tenant_id` generation; token encryption helpers; TTL for state |
| `backend/server.py` | merchant-auth dependency; gate `:664`, `:686`, `:702`, `:731`, `:621`; ownership + rate limit on `:534`; parameterise `:281`; bound `_oauth_states` `:57` |
| `backend/multi_tenant_ingest.py` | parameterise `:191`, `:200` |
| `backend/test_multi_tenant.py` | new abuse-case tests |
| `backend/requirements.txt` | possibly one crypto dependency for token encryption — the only addition, and only if stdlib is insufficient |
| `CLAUDE.md` | record the new auth boundary |
| **new** `backend/auth.py` | merchant session issue/verify — small, one responsibility |

---

**STOPPING HERE as instructed. No implementation has begun. Awaiting
approval on §0 and on Phase 1.**
