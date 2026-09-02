# Disc — AI Boutique Widget

> **Read `PRODUCT_DIRECTION.md` before starting a new phase.** It records
> the agreed target architecture — Disc as a white-label AI shopping
> layer inside the merchant's own storefront, with a first-class brand
> content layer — and, importantly, what is *deferred* until the
> reliability sequence finishes. This file describes the system as it is
> today; that one describes where it is going and what must not break on
> the way. Where they disagree about distribution, this file is the
> current state and that one is the target.

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and get a conversational **AI boutique**: a glass bar
docked above their store that, once used, opens a full-screen shopping
experience — editorial results, product detail with sizes and real
add-to-cart, complete-the-look outfitting, and a saved-items list.

**Disc is sold direct, not through the Shopify App Store.** That was a
deliberate call: building and getting an app approved takes weeks, and
the self-serve path ships now. A merchant signs up on our own site, we
read their catalog, they paste one line into their theme. Everything
about how Disc reaches a storefront, identifies a tenant, and gets paid
follows from that decision — see "Distribution" below. The Shopify OAuth
app code is still here, unused but working, because it's the upgrade
path once a listing exists; don't delete it, and don't wire the product
to it without checking first.

The shape of the experience is modelled on Brunello Cucinelli's "AI
Online Boutique" (the reference the user supplied as a screen recording):

```
bar (always docked)   single-row pill: [+] query text [x] [^]
                      [+] swaps the row for a tools pill: [x] | clip | compose
  -> loading canvas   ornament + rotating serif headline + line drawing
  -> results canvas   "Get inspired by these creations" + editorial grid
                      (image, heart, name + chevron — nothing else)
  -> product detail   full-height imagery, scrolled sideways, with the
                      product bar floating over it — the search bar is
                      HIDDEN here; never two bars stacked at once
                      MATERIALS + / HOW TO STYLE + chips above the card;
                      card = thumb, title, heart, price, colour,
                      [Add to cart] [Select size] [x]
                      expanding a chip shows its panel and collapses the
                      card to a compact pill: [Add to cart] title/price [x]
                      HOW TO STYLE = paged 2x2 look grid with < > and dots
```

**Match the reference exactly; don't add to it.** This layout is taken
from a screen recording of the reference experience, frame by frame. Two
things were invented in an earlier pass and had to be removed: match
rationale printed under every result card, and a `for "<query>"`
subheading. If something isn't in the recording, it doesn't belong on
screen.

**The brand layer is data, never code.** Disc is sold to many stores, so
canvas colour, ink, serif stack, headline copy, loading messages and the
loading illustration all come from `DISC_THEME`, overridable per merchant
via `window.DiscConfig.theme`. Copying one brand's identity into the
widget would make it unsellable to the next merchant — verified by a test
that renders the whole canvas in a completely different (near-black)
identity from config alone.

The theme's own native search input is hidden as soon as Disc attaches
(its layout space is preserved so nothing else on the page reflows — this
is not a DOM removal) since merchants don't need two search boxes once
Disc is installed. Disc never navigates or mutates the merchant's page:
the canvas is an overlay in Disc's own Shadow DOM, so closing it returns
the shopper exactly where they were.

This has gone through three iterations; don't reintroduce an earlier one
without checking with the user first:
1. Hijacking the native input directly (reusing its DOM node, attaching
   listeners to it, `preventDefault()` on its form submit).
2. An independent bar fixed to the bottom of the viewport, coexisting
   with an untouched native search elsewhere on the page.
3. Disc's own bar positioned exactly over the native input's location
   (not fixed-bottom), with the native input hidden.

The current (fourth) model combines pieces of 2 and 3: Disc's bar is
fixed to the bottom of the viewport like iteration 2 — **not** tied to
the native input's position — but the native input is hidden like
iteration 3, via a simple scan-and-hide with no position-tracking
attached to it.

Product name is **Disc** everywhere: package name, web component tag,
CSS class prefixes, file names, log lines, comments. Never "Discern",
"discern-widget", or any other spelling — that was an early working name
and is wrong everywhere it appears now.

## The two backends: `/convex` is the product, `/backend` is history

**`/convex` is the real backend.** All 17 spec phases are implemented and
tested — catalog ingestion, product intelligence, Brand Brain, intent,
the decision engine, the Look Builder, billing, analytics, rate limiting
and usage metering. It is **written and tested but not yet deployed**,
because deploying needs a Convex project on the owner's account. Nothing
about that is provisional: `Disc.md` is the spec and `Disc audit.md` is
the traced gap analysis, and the gaps are closed.

**`/backend` (FastAPI + LanceDB + fastembed) is the original prototype
and is now dead weight.** It is superseded on every axis — it has no
merchant/public credential split, no product intelligence layer, no
Brand Brain, no outfit engine, no looks, and a confirmed injection bug in
its product lookup. Nothing in the shipping path depends on it. It is
still here only because deleting it has not been agreed; do not build
against it, and do not treat its behaviour as the reference for
anything.

The widget talks to whichever backend its `apiUrl` points at: the Convex
HTTP routes deliberately mirror the Python paths and response shapes
(`POST /search`, `GET /product/{id}`, `GET /look/{id}`,
`GET /sites/{key}/status`), so `frontend/disc-widget.js` needs no edits
and its Playwright suites stay valid either way. That is what made the
cutover reversible while it was in progress.

### Known structural debt

Named here rather than fixed, because the fixes were proposed and not yet
agreed:

- **`/backend`** — 2,685 lines of superseded Python, per above.
- **`convex/http.ts` is ~1,000 lines.** The one genuine "giant api.ts" in
  the repo: storefront routes, OAuth, Shopify webhooks, Stripe webhooks,
  the merchant control plane, looks and admin all register in one file.
  It is grouped by comment banner and would split cleanly into
  `convex/routes/*`. `http.itest.ts` guards the duplicate-registration
  failure that is the only real hazard in doing so.
- **`frontend/disc-widget.js` is ~1,800 lines.** Everything the shopper
  sees, in one file. Splitting it means adding a bundler to the most
  fragile delivery path in the product — a script that runs on other
  people's storefronts — so it is a real trade rather than an obvious win.

Everything else already has one owner per responsibility: 15 Convex
function modules averaging ~330 lines, and 25 pure-logic libraries under
`convex/lib/`.

**The security boundary the Python version lacks**, and the reason this
phase came first:

```
publicKey      identifies a tenant. Ships in storefront HTML, so it is
               NOT a secret. Authorises reading that shop's own catalog.
merchant token authenticates a merchant. Bearer, hashed at rest, expires.
               Required for resync, billing, settings — anything that
               spends money or changes state.
```

In the Python backend these are the same value, which is why
`POST /sites/{key}/resync` and `GET /sites/{key}/status` both answer to
anything anyone can read off a storefront. Don't reintroduce that.

Two more things that were bugs there and are structural here: product
`currency` is a required field (it was never ingested, so every non-USD
merchant showed dollar prices), and product lookups go through indexed
equality rather than an interpolated filter string (the old
`where(f"id = '{id}'")` was confirmed exploitable — `x' OR '1'='1`
returned a product whose id never matched).

Embeddings move from local `fastembed` (384-dim) to a hosted provider
(1536-dim) behind `convex/lib/embeddings.ts`, because Convex has no
Python runtime and a 130 MB ONNX model will not load in a 512 MiB
action. The two vector spaces are incompatible — every tenant must be
re-ingested, there is no conversion.

`frontend/tests/package.json` pins those suites to CommonJS. The repo
root gained `"type": "module"` for the Convex backend, which would
otherwise reinterpret the existing `require()`-based Playwright files as
ES modules.

## Architecture

```
/backend                    SUPERSEDED — the original prototype. Kept, not used.
                            See "The two backends" above before touching any of it.
  ingest.py               -> builds the DEMO LanceDB table (backend/data/disc_lancedb) from
                              the 15-item sample catalog — used when no shop is registered,
                              e.g. this repo's own test.html
  server.py               -> FastAPI app: /search, signup, /embed.js, billing, webhooks
  db.py                   -> SQLite tenant registry (domain -> site key, sync + subscription state)
  public_ingest.py        -> catalog ingestion via the storefront's public products.json —
                              no OAuth, no credentials. Was the shipping path; the Convex
                              backend uses the Shopify Admin API instead.
  billing.py              -> Stripe plans, Checkout sessions, webhook signature verification
  multi_tenant_ingest.py  -> record shape + per-shop table writer, shared by both ingestion
                              sources; also the (dormant) Admin API fetch
  shopify_auth.py         -> DORMANT: OAuth + Shopify webhook HMAC, for a future App Store listing
  test_multi_tenant.py    -> signature schemes, both parsing shapes, self-serve signup,
                              per-shop isolation (no real credentials needed)
  requirements.txt
  data/                   -> gitignored: disc_lancedb (demo), disc_lancedb_multi (per real shop,
                              one LanceDB table each), shops.db (SQLite)
/frontend
  disc-widget.js  -> the entire client: Web Component + Shadow DOM + native-input takeover
  tests/          -> Playwright suites. These live in the repo rather than a scratch dir
                     because they are the only check on layout regressions:
                       devices_test.js  -> does it fit, across 14 real device profiles
                       coverage_test.js -> can the shopper actually see and hit it
                       dormant_test.js  -> an inactive tenant must not cost a store its search
/dashboard
  app/            -> the merchant console (spec §70-§76), Next.js App Router on Vercel.
                     Overview, Brand, Catalog, Looks, AI Boutique, Analytics,
                     Billing, Settings.
  lib/api.ts      -> the ONLY place the merchant bearer token is read
  app/actions.ts  -> every state change, as server actions
  tests/          -> render_test.js + a mock backend. Three scenarios
                     (healthy / fresh install / lapsed) x three viewports
test.html         -> a fake Shopify PDP/search page for local end-to-end testing
test_search.py    -> scripted test hitting POST /search with a real intent query (demo catalog)
```

### The Look Builder and the outfit graph

A brand's campaign imagery already contains styling decisions someone
made deliberately. Disc could not see them: compatibility was inferred
from product attributes alone. The Look Builder turns those decisions
into structured data.

```
upload image -> vision detects garments -> Disc suggests catalog matches
             -> MERCHANT CONFIRMS -> structured look -> outfit graph
```

**The capitalised step is the product.** A model can see "a white shirt"
in a photograph and have no idea which of fourteen white shirts it is.
Detection produces *candidates*; auto-assigning would quietly teach Disc
a relationship between products that were never photographed together,
and nothing downstream could tell that from a real one. `looks.detected`
(what the model saw) and `looks.items` (what the merchant confirmed) are
separate fields for the same reason `products` and `productProfiles` are
separate tables.

**The cold-start guarantee is load-bearing, and it is tested twice.**
Looks add a capped bonus (`MAX_AFFINITY_BONUS`, currently 0.06 on a ~0..1
scale) *on top of* the existing weighted sum — never folded into it,
because a sixth term inside would renormalise the other five and shift
every existing result for every tenant. A tenant with no looks gets zero.
If ranking ever came to depend on approved looks, a brand that installed
Disc this morning would get worse results than one that never opens the
feature.

The two assertions, both in `lib/looks.test.ts`:
- `rankOutfits(...)` with no affinity argument must **deep-equal** the
  same call with an empty graph. Passing nothing and passing empty are
  indistinguishable.
- A vouched outfit must score higher through the **bonus alone**, with
  compatibility, brand, fit and relevance unchanged — otherwise
  "inertness" is trivially satisfied by a feature that does nothing.

The cap exists to stop twenty looks from one black campaign turning the
whole boutique black for every shopper. The bonus also ramps in with
library size, so the first look uploaded doesn't outrank everything it
touches on the evidence of one image.

**Approval is a separate, explicit act.** Saving lands a look as a draft;
only approving lets it into the graph. Un-approving genuinely removes its
edges, and re-mapping rebuilds them rather than adding — a stale edge
would keep teaching a relationship the merchant explicitly withdrew.

**`looks.imageStorageId` is the one deletion hole `privacy.itest.ts`
cannot see**, because Convex file storage is not a table and the guard
reads the schema. `purgeTenant` deletes the files explicitly, and
`looks.itest.ts` asserts storage is empty after a purge. Any future
feature that stores files needs the same treatment.

Deliberately not built: Disc-generated looks with approve/reject. It's a
separate workflow, and the merchant-upload path is the half with no
cold-start problem — a brand's campaign imagery already exists.

### The dashboard's one architectural rule

**Every page is a server component, and the merchant token never reaches
the browser.** That token authorises resync, billing and settings for a
merchant's whole store, so a copy of it in client JavaScript is a copy
any injected script on the page can take.

It arrives once in a query string from the OAuth callback, is swapped for
an httpOnly cookie by `app/app/route.ts`, and after that is read only in
`lib/api.ts`, server-side. State changes are server actions rather than
client fetches for the same reason. `render_test.js` asserts it on every
page in every scenario: the token appears in neither the rendered HTML
nor any client script payload.

Two things there are load-bearing and easy to undo by accident:

- `app/app/route.ts` returns a **relative** `Location`. Building an
  absolute one from `request.url` trusts the incoming Host header, which
  behind Vercel's proxy is not necessarily the host the merchant is on —
  and redirecting to a different origin drops the cookie that was just
  set, so a successful login lands back on the sign-in page. This was a
  real failure caught by the suite.
- `/app` is a route handler, so the overview lives at `/app/overview`;
  a `page.tsx` cannot share a path with a `route.ts`.

The scenarios that matter in `render_test.js` are `fresh` and `lapsed`,
not `healthy`. Any dashboard looks fine full of data. Those two are where
a merchant either understands what is wrong or concludes the product is
broken — so the suite asserts that a rate with no denominator never
renders as `0%`, that a missing Brand Brain reads as pending rather than
failed, and that `past_due` reaches the merchant as "Payment failed"
rather than as raw Stripe vocabulary.

### Backend

- **FastAPI** (`server.py`) exposes `POST /search { "query": str }`.
- **fastembed** (`TextEmbedding`, BAAI/bge-small-en-v1.5) embeds both the
  catalog (offline, in `ingest.py`) and the live query (online, in
  `server.py`). No PyTorch, no OpenAI, no paid API calls anywhere in the
  pipeline — this is the whole point: near-zero marginal cost per search.
- **LanceDB** is the embedded/serverless vector store. The table lives on
  local disk at `backend/data/disc_lancedb`. No server process, no network
  hop for the vector search itself.
- **Ollama** (optional, local) generates the one-sentence "why this
  matched" explanation via `POST http://localhost:11434/api/generate`
  using `phi3` (or `llama3`). If Ollama is not running, is unreachable, or
  times out, `generate_ai_reasoning()` catches the failure and falls back
  to a deterministic templated sentence — the API contract to the widget
  never changes shape based on whether Ollama is up. `generate_styling_note()`
  (the HOW TO STYLE copy) follows the same contract.

### Endpoints the boutique experience runs on

- `POST /search` — ranked results, each with match reasoning.
- `GET /product/{id}` — everything the detail view needs: full image set,
  variants (size, price, per-variant availability), colour, handle, plus
  freshly-generated HOW TO STYLE copy. Styling copy is generated on open
  rather than at ingest time, so a catalog isn't charged for products
  nobody looks at.
- `GET /look/{id}` — **complete the look**. Plain nearest-neighbour search
  is useless here: a cardigan's nearest neighbours are four more
  cardigans. So it searches wide in the same embedding space (which
  already encodes style, season and material affinity), then filters *out*
  the anchor's own `product_type` and keeps the closest match from each
  remaining category. That yields trousers/outerwear/a knit that share the
  piece's character — an outfit, not near-duplicates. Covered by tests.
- `GET /placeholder/{name}` — generated SVG stand-in imagery for the demo
  catalog only. The sample catalog has no photography, and a grid of
  broken images makes the whole experience look broken. Real shops never
  hit this; their records carry real CDN URLs.

**Ingestion carries more than search needs.** `product_to_record` keeps
variants, all images, `handle` and `product_type` even though the vector
search itself uses none of them — the detail view, size picker,
add-to-cart, storefront links and complete-the-look each depend on one of
them. `_hit_to_result` reads every one of these defensively, so a shop
table written before these fields existed degrades to a plain result
rather than 500ing the search.

### Distribution — how one paste becomes that store's AI

This is what makes Disc *that particular store's* AI rather than a demo,
and it happens without an app install:

1. **Signup**: merchant enters their domain at `GET /`. `POST /sites`
   normalises it and probes `https://{domain}/products.json` *before
   writing anything* — a store that doesn't serve a readable catalog
   can't be made to work later, and failing on the signup form beats
   failing after they've pasted the snippet and are watching an empty
   bar. On success it issues a **site key** (`disc_<32 hex>`) and queues
   the first ingestion in the background.
2. **Ingestion**: `public_ingest.ingest_public_shop()` pages the public
   catalog (`?page=N` — *not* the Admin API's Link-header cursor), maps
   it through the shared `product_to_record`, and overwrites a table
   named `shop_<sanitized-domain>` in `backend/data/disc_lancedb_multi`.
   One table per merchant is what keeps one store's products out of
   another's results.
3. **Install**: the merchant pastes exactly one line into
   `layout/theme.liquid`:
   `<script src="https://you/embed.js?k=disc_..." defer></script>`.
   `/embed.js` serves the widget with `apiUrl` and `siteKey` baked in at
   request time, so the snippet carries nothing they can get wrong and a
   widget fix reaches every store without anyone editing a theme.
4. **Staying in sync**: there are **no product webhooks** — those need an
   app — so `_resync_loop()` re-reads every self-serve catalog every
   `DISC_RESYNC_HOURS` (default 6). That interval *is* how stale a
   merchant's index can get after they edit a product; `POST
   /sites/{key}/resync` forces it immediately.
5. **`POST /search`** takes `site_key` (and still accepts `shop`).
   `_resolve_table()` is the single place that decides what a query runs
   against: no tenant identified falls back to the shared demo catalog —
   this is what keeps `test.html`/`test_search.py` working unchanged — a
   shop whose `sync_status` isn't `"ready"` returns `status: "syncing"`
   with empty results (the widget says "still learning this store's
   catalog", not a silent "no matches"), an unsubscribed shop returns
   `status: "inactive"`, and a ready shop gets its own table.

**The site key is an identifier, not a secret.** It ships in a script tag
on a public storefront, so anyone can read it. It's random so nobody can
guess *other* merchants' keys, and prefixed so it's recognisable in a log.
Re-running signup for a domain deliberately **keeps the existing key** —
minting a new one would silently kill Disc on a theme that already has
the old one pasted in.

**`PUBLIC_URL` must be set in any real deployment.** It's baked into
every snippet `/embed.js` hands out, so leaving it at the localhost
default gives every merchant a script tag their storefront can't load —
and it fails on *their* site, silently. The server logs a warning at
startup if it still looks like localhost.

#### Billing (Stripe, not Shopify)

Selling direct means Shopify's Billing API isn't available — that one is
only for installed apps. So: Stripe Checkout, `billing.py`. The trade
against an App Store listing is 100% minus Stripe's ~2.9% and no $19
Partner fee or revenue share, against losing Shopify's billing UI, its
distribution, and charges landing on the merchant's existing Shopify
invoice.

Pricing tiers on **catalog size**, because that's the only thing about a
shop that costs anything real — embedding is a one-time CPU cost and each
shop's vectors sit on disk. Queries are effectively free (fastembed is
local, no per-search API call to anyone), so charging per search would
tax the part that costs nothing. `PLANS` in `billing.py` holds
placeholder numbers; set them and the matching Stripe price IDs.

`billing.enabled()` is False without `STRIPE_SECRET_KEY`, which is what
keeps local dev and the test suite from being locked out by a
subscription check they can't satisfy.

**A lapsed subscription must never leave a storefront worse than Disc
found it.** Disc hides the theme's own search box on the promise that its
bar replaces it; if the tenant goes inactive that promise is broken, and
hiding it anyway would leave the shop with *no* way to search. So the
widget checks `/sites/{key}/status` once on boot **before hiding
anything**, and stays dormant if `active` is false — and `goDormant()`
restores any input it already hid if a search later comes back
`inactive`. `frontend/tests/dormant_test.js` asserts both directions
against a live billing-enabled backend. The one small cost is a status
request per page load; a network failure resolves as "carry on", because
Disc briefly misbehaving beats a shop losing its search bar to a blip.

### The Shopify OAuth app — built, tested, currently dormant

Kept because it's strictly better on three counts once an App Store
listing exists: it reads unpublished products, it gets real product
webhooks instead of a polling interval, and it can't be switched off by a
merchant disabling their public JSON. Nothing in the shipping path
depends on it.

1. **Install**: merchant hits `GET /auth?shop=xyz.myshopify.com` ->
   redirected to Shopify's OAuth consent screen -> Shopify redirects back
   to `GET /auth/callback` with a `code` and an `hmac`-signed query
   string. `shopify_auth.verify_oauth_callback_hmac()` rejects anything
   not actually signed by Shopify; a `state` token (stored in the
   in-process `_oauth_states` dict) guards against CSRF. The code is
   exchanged for a permanent Admin API access token
   (`shopify_auth.exchange_code_for_token`), stored in `db.py`'s SQLite
   `shops` table, and product webhooks are registered
   (`shopify_auth.register_webhooks`).
2. **First ingestion** runs as a `BackgroundTasks` job right after
   install (`_run_full_ingestion` in `server.py`) so the OAuth redirect
   itself returns immediately rather than blocking on however long the
   catalog takes to embed. `multi_tenant_ingest.ingest_shop()` paginates
   `GET /admin/api/2024-01/products.json` via the response's `Link`
   header, strips HTML from `body_html`, embeds every product, and
   `mode="overwrite"`s a table named `shop_<sanitized-domain>` in
   `backend/data/disc_lancedb_multi`.
3. **Staying in sync**: `products/create` and `products/update` webhooks
   re-embed just the one changed product (`upsert_product` — delete the
   old row by id, add the new one) rather than re-ingesting the whole
   catalog; `products/delete` removes it; `app/uninstalled` and the
   mandatory `shop/redact` GDPR webhook both drop the shop's table and
   its `shops.db` row entirely. Every webhook handler verifies
   `X-Shopify-Hmac-Sha256` against the **raw** request body
   (`shopify_auth.verify_webhook_hmac`) before touching the payload —
   parse-then-verify would let a forged request through.
4. **`POST /search`** takes an optional `shop` field. `_resolve_table()`
   is the single place that decides what a query runs against: no
   `shop` (or a `shop` not found in `shops.db`) falls back to the shared
   demo catalog — this is what keeps `test.html`/`test_search.py`
   working unchanged — a registered shop whose `sync_status` isn't
   `"ready"` yet returns `status: "syncing"` with empty results (the
   widget shows "Disc is still learning this store's catalog," not a
   silent "no matches"), and a ready shop gets its own table, so one
   merchant's products can never leak into another's results.
5. Mandatory GDPR webhooks (`customers/data_request`,
   `customers/redact`, `shop/redact`) are required by Shopify for every
   app regardless of what it stores. Disc holds no customer PII at all —
   only product catalog data — so the first two are acknowledgements,
   not real data operations; `shop/redact` is the one that actually
   deletes something (the shop's table + registry row).

**What can and can't be tested without real credentials**:
`backend/test_multi_tenant.py` covers everything that doesn't require a
Shopify Partner app, a Stripe account, or a public deployment — **three
different signature schemes** (Shopify OAuth callback hex/sorted-params,
Shopify webhook base64/raw-body, and Stripe's `t=…,v1=…` including its
replay guard), product JSON parsing for *both* source shapes, the
self-serve signup path end to end with the storefront fetch
monkeypatched, and full per-shop isolation queried through the live
`/search` endpoint. It deliberately does *not* verify that a real Stripe
checkout completes or that a real OAuth round trip works.

**Two ingestion sources, one record shape.** `product_to_record` parses
both the Admin API and the public storefront JSON, which differ in
exactly two ways — and both differences corrupt an index silently rather
than raising, which is why each has its own named helper and its own
test. `tags` is a comma-separated *string* from the Admin API and a real
*list* from the storefront (`_tag_list`). Availability is
`inventory_quantity`/`inventory_management` from the Admin API but an
explicit `available` boolean from the storefront (`_variant_available`) —
reading it wrong marks every sold-out size as buyable, which a shopper
only discovers at checkout. Verified against a real 291-product store
where 2,098 of 2,509 variants are genuinely sold out.

### Frontend — the widget contract

**Critical rule: no double search bars.** Once Disc attaches, there is
exactly one visible, usable search entry point on the page — Disc's own.

1. `<disc-search-bar>` mounts and is immediately usable: `position:
   fixed`, horizontally centred, `width: min(640px, calc(100vw - 32px))`.
   It is **not** positioned relative to the native search input — it
   doesn't need to know where that is, or even whether one exists, to
   render and function.
   **It has two resting heights, measured off the reference.** Idle over
   the store it floats in the lower third, centred at ~72% of viewport
   height (`bottom: 23dvh`); once the canvas opens it docks to the bottom
   (`bottom: max(20px, env(safe-area-inset-bottom))`, bar bottom ~97%).
   `_updateBarOffset()` owns both, and is re-run on open/close — the
   keyboard offset stacks on top of whichever is current. A test asserts
   both positions against the values measured from the recording.
2. Separately, a `DOMScanner` polls every 500ms for a native input
   matching `input[name="q"], input[type="search"]` (extend selectors as
   needed per-theme). Once found, the interval clears and the input is
   set to `visibility: hidden` (not `display: none` — visibility
   preserves its layout space, so the rest of the theme doesn't reflow
   around a collapsed box) and otherwise left alone.
3. All rendered UI — the input, the results panel, skeleton loaders,
   result cards — lives inside `<disc-search-bar>`'s own `attachShadow({
   mode: "open" })` root. Styles are injected as a `<style>` tag inside
   the shadow root, never into the host document's `<head>`.
4. The results panel opens **upward** (`position: absolute; bottom:
   calc(100% + 12px)`) since the bar sits at the bottom of the viewport.
   Its `max-height` is capped at `min(420px, 52dvh)` so it can't overflow
   a short viewport (e.g. a phone in landscape) — check this if you ever
   see it clipped or the bar itself pushed off-screen. The percentage has
   headroom baked in for the bar's own height + its bottom offset + the
   gap above it; it's been tuned down once already (60 -> 52) after the
   bar grew a few px taller and started clipping on a 375px-tall
   landscape viewport, so re-verify at that size if the bar's height
   changes again.
5. The bar's input is a `<textarea>` (not a single-line `<input>`), auto-
   growing up to 120px via `_autoGrow()` on the `input` event, then
   scrolling internally (scrollbar hidden via CSS `overflow: hidden`, but
   still keyboard/cursor-navigable — that's native `<textarea>` behavior,
   not something disabled). Plain `Enter` sends; `Shift+Enter` inserts a
   newline by falling through to the textarea's own default handling.
6. `bindPressSpring()` drives a real per-frame spring integration (ported
   from a reference React implementation's `useSpring` hook, kept
   numerically identical rather than made frame-rate-independent) for the
   "squish on press, spring back on release" feel on both the bar and the
   send button — not a CSS transition. Because it sets `el.style.transform`
   directly every frame, nothing else may put `transform` in that
   element's own `transition` list (they'd fight each other); the send
   button's CSS transition intentionally only covers
   `background-color`/`opacity`.
7. `_setLoading(true/false)` swaps the send button to a busy state
   (bordered pill + small square) while a request is in flight, without
   ever disabling the textarea — a shopper can keep refining their next
   query underneath it. This fires for every debounced type-ahead search,
   not just an explicit send, so it doubles as a lightweight "thinking"
   indicator.
8. `_bindKeyboardOffset()` tracks `window.visualViewport` so the bar lifts
   above the on-screen keyboard on iOS/Android instead of being covered by
   it, adding the delta on top of the normal `safe-area-inset-bottom`
   offset. `focusout` is a fallback resync, since `visualViewport`'s
   resize event doesn't always fire on iPad after the keyboard closes.
9. Sizing holds up across the full device range without device-specific
   branches. `devices_test.js` runs the whole flow — idle, results,
   detail, look expanded — against 14 real profiles (iPhone SE/12/14 Pro
   Max, Pixel 7, Galaxy S9+, iPad Mini/Pro 11 both orientations, plus
   320px, laptop, 1440 and 1920) and asserts the bar and buy card stay
   inside the viewport, Add to cart stays reachable, the page never
   scrolls horizontally, and no JS errors fire. Run it after any CSS
   change; the short-landscape and narrow-phone cases have caught several
   real bugs.
   The results grid uses `minmax(min(240px, 46%), 1fr)`, which gives two
   products per row on a phone and scales to 3 / 4 / 5 / 7 columns on
   tablet through 1920px, rather than one oversized column on mobile.

   `coverage_test.js` is the companion check and asks a different
   question: not "does it fit" but "can the shopper actually see and hit
   it". At every stage (idle, results, detail, sizes revealed, look
   expanded) it uses `shadowRoot.elementFromPoint()` on each control's own
   centre to prove nothing is stacked on top of it, flags text clipped
   without an `ellipsis` rule, flags overlapping sibling blocks in
   `.disc-detail-ui`, and scrolls the results to the bottom to confirm the
   last product row isn't parked under the bar. **A container that
   scrolls is not the same as content that is visible** — that distinction
   is what it exists to catch, and CSS that merely "fits" can still fail
   it.

   The one thing that has failed it: on a short landscape phone the
   expandable panel only gets ~130px between the chips and the buy card,
   so the complete-the-look 2×2 image grid (~290px) pushed its second row
   and its pagination arrows into the panel's own hidden-scrollbar
   overflow — reachable in theory, invisible in practice. Under
   `@media (max-height: 520px)` the grid becomes one shallow row of four
   (`repeat(4, 1fr)`, `aspect-ratio: auto`, `height: clamp(44px, 17dvh,
   92px)`) with a compressed nav, so a whole page plus its arrows and dots
   is on screen at once. The row height is in `dvh` rather than a fixed
   px so it tracks the viewport instead of needing re-tuning the next time
   the panel gains a few px.

   **A missing `<meta name="viewport">` on the host page breaks this
   entirely** — a mobile browser then lays out at 980px and scales down,
   so Disc renders at desktop widths on a phone. Every real Shopify theme
   ships the tag; `test.html` was missing it, which is what the device
   matrix caught. Disc deliberately does not inject one: that would mutate
   the merchant's page, and a storefront without it is already broken for
   its own layout, not just ours.
10. `detectShop()` reads `window.Shopify.shop` (a global every Shopify
    storefront injects) and sends it with every call — this is what makes
    multi-tenancy zero-config for the merchant; there's nothing to paste
    into the script tag. Falls back to `null` on pages without it (this
    repo's own `test.html`), which the backend treats as "use the shared
    demo catalog." A `status: "syncing"` response renders as its own
    message — a shopper on a freshly-installed store shouldn't read
    "still indexing" as "this store has nothing you want."

#### The takeover canvas

11. Searching opens `.disc-canvas`, a full-screen view inside the Shadow
    DOM. The host is `position: fixed; inset: 0` but
    `pointer-events: none` while idle, so it never swallows clicks on the
    merchant's page; only the bar (and the canvas, once open) are
    interactive. Opening also locks `documentElement.overflow` so the
    store doesn't scroll behind the takeover.
12. The bar is a **single-row pill**, not a two-row stack: round `+` at
    the left, textarea between, round send at the right, with a small
    clear appearing beside send once there is text. `+` hides
    `.disc-bar-inner` and shows `.disc-tools` — close / attach / compose,
    separated by hairline dividers. Attaching a photo previews it above
    the row; **it is not yet wired to visual search**, because there is no
    image-embedding pipeline behind it (see the note at the end of this
    section).
13. **One bar at a time.** Opening a product hides the docked search bar
    (`this._bar.hidden = true`) and the product bar takes its place;
    leaving the detail view restores it. The reference never stacks a
    product bar under a search bar, and doing so wasted a band of screen.
    Because the search bar is hidden there, `.disc-overlay` no longer
    reserves its height — it sits just above the safe-area inset. Detail
    imagery is full-height and scrolls horizontally so photography fills
    the canvas behind the card rather than ending in empty space.
14. **Everything is horizontally centred** — bar, results heading, chips,
    look panel and buy card all sit on the viewport's centre line.
    `centre_test.js` asserts each one is within 2px of centre at phone,
    tablet and both desktop widths. Note this is a **deliberate
    divergence from the reference**, which left-aligns the detail column;
    it was requested. Flipping `.disc-detail-ui` back to
    `align-items: flex-start` restores the reference layout.
15. **The detail view's glass card lives in `.disc-overlay`, outside the
    scrolling `.disc-body`.** This is deliberate and load-bearing: sticky
    positioning can't keep it pinned, because a sticky element stops as
    soon as its own parent's content ends — that bug left the card
    floating mid-page. Within the overlay `.disc-chip-panel` is the only
    flexible child; `.disc-chips` and `.disc-buy` are `flex-shrink: 0`,
    so on a short viewport the panel clips rather than Add-to-cart being
    pushed out of reach. That was a real bug found on a 390px-tall
    landscape phone, where the purchase card was completely unreachable.
16. `[hidden] { display: none !important; }` is required — without it the
    attribute is a no-op on anything given an explicit `display` value,
    which is why the Back button once appeared on the results view.
17. Canvas chrome must be **theme-proof**: nav buttons and secondary text
    derive from `--disc-ink` (with opacity) or neutral translucent grey,
    never hardcoded white/black. A merchant's canvas may be near-black,
    and a white pill on white is invisible — a bug the dark-theme test
    caught.
18. Add-to-cart posts to Shopify's own AJAX Cart API (`/cart/add.js`) on
    the merchant's domain; Disc never proxies commerce. On a page that
    isn't a Shopify storefront there is no cart, so it resolves as
    `"demo"` and the UI says so plainly rather than faking success.
    A multi-size product refuses to add until a size is chosen, mirroring
    how real storefronts behave.
19. The wishlist is `localStorage` only — no account, no PII, nothing sent
    to the backend. Toggling a heart updates every instance of that
    product on screen at once (grid card, look tray, detail card).

**Open question — the attach button.** The reference bar's `+` menu has a
paperclip, so it is present here for fidelity, and attaching a photo does
really preview it. But nothing searches by that image: the backend has no
image-embedding pipeline. `fastembed` does ship CLIP-style image
embeddings, so this is buildable — it just isn't built. Until it is,
attaching a photo and sending falls back to the text query. Either wire it
up or drop the button; don't leave it looking functional indefinitely.

### Design system

Liquid Glass: monochrome black/white/gray palette, `-apple-system`/`Inter`
font stack, real live `backdrop-filter: blur(30px) saturate(200%)` (actual
pixels behind the widget, not a screenshot), a pointer-tracked specular
highlight, a light-catching gradient rim, layered ambient/contact shadows,
spring-eased motion (`cubic-bezier(0.34, 1.56, 0.64, 1)`), and a one-shot
diagonal sheen on open. True optical refraction (geometric lensing of the
background) is deliberately not attempted — the only CSS route there is a
noisy SVG turbulence filter that silently fails on browsers without
support for filters inside `backdrop-filter`, which isn't acceptable for
a widget embedded on arbitrary merchant storefronts.

Two things worth remembering if you touch the CSS again:
- The specular highlight and sheen use plain alpha compositing, not
  `mix-blend-mode: overlay`/`soft-light` — those blend modes go nearly
  invisible against an already-light base, which is exactly this
  widget's light-mode surface.
- All panel text inherits a subtle `text-shadow` from `.disc-root`. A
  translucent glass panel has no guaranteed contrast against whatever
  backdrop happens to blur through it, so text carries its own shadow as
  a legibility safety net rather than relying on the glass tint alone.

## Going live: what this repo can't do for you

The code is written and tested as far as it can be without real
credentials (see `test_multi_tenant.py` above). What's left needs *your*
accounts and a real deployment.

**To take money and onboard merchants — the shipping path:**

1. **Deploy this backend behind a real, public HTTPS URL.** Merchants'
   storefronts load `/embed.js` from it and every shopper's search hits
   it, so it has to be reachable and reasonably quick. Set `PUBLIC_URL`
   to that address — it's baked into every install snippet, and the
   startup log warns if it still looks like localhost.
2. **Create a Stripe account**, add a recurring Price for each tier, and
   set `STRIPE_SECRET_KEY` plus `STRIPE_PRICE_STARTER` /
   `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_BOUTIQUE`. Edit the numbers in
   `billing.PLANS` to match — the ones there now are placeholders.
3. **Point a Stripe webhook** at `{PUBLIC_URL}/webhooks/stripe` for
   `checkout.session.completed` and `customer.subscription.*`, and set
   `STRIPE_WEBHOOK_SECRET`. Without this, cancellations and failed
   payments never take effect, because `/search` reads the cached
   subscription status rather than calling Stripe per query.
4. **Decide what runs the LLM copy.** Ollama is optional and everything
   degrades to deterministic templated sentences without it, so the
   product works with no LLM at all — but the "why this matched" and HOW
   TO STYLE lines are noticeably better with one. If you want it, run
   Ollama alongside the backend; if you don't, delete nothing, the
   fallback is already the contract.
5. **Test the whole loop on a real store you control**: sign up at `/`,
   watch `GET /sites/{key}/status` go `pending` -> `syncing` -> `ready`,
   paste the snippet into `layout/theme.liquid`, and search.

Scaling notes for when it works: `db.py` is SQLite and `_oauth_states` is
an in-process dict, so this runs as **one backend process**. Multiple
workers need both moved to shared storage first. Each shop's LanceDB
table is on local disk, so that disk is state — back it up or be able to
re-ingest.

**Only if you later want an App Store listing** (not needed for any of
the above): a Shopify Partner account ($19 one-time to register for the
App Store), an app registered in the Partner Dashboard for
`SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`, `APP_URL` set, the three
mandatory GDPR webhook endpoints configured there, and a **theme app
extension** — Shopify's docs are explicit that an app integrating with a
theme must use one rather than a script tag, so the merchant-pastes-a-tag
install in this repo is not itself listable. Listing also brings app
review, a privacy policy URL, listing assets, and switching billing from
Stripe to Shopify's Billing API (which then takes 0% of your first $1M
and 15% above it). That's a separate project, not a blocker on anything
above.


## Local dev

```bash
cd backend
pip install -r requirements.txt
python ingest.py          # builds backend/data/disc_lancedb from the sample catalog
uvicorn server:app --reload --port 8000
```

`python test_multi_tenant.py` (from `/backend`, with the server running)
runs everything testable without real credentials: three signature
schemes, both product-JSON shapes, the self-serve signup path, and full
per-shop search isolation between two fake shops.

The layout suites need the backend up too, and run from the repo root:

```bash
node frontend/tests/devices_test.js    # does it fit, 14 device profiles
node frontend/tests/coverage_test.js   # can the shopper see and hit it

# dormant_test needs a second backend with billing switched on:
STRIPE_SECRET_KEY=sk_test_fake PUBLIC_URL=http://localhost:8001 \
  uvicorn server:app --port 8001
DISC_API=http://localhost:8001 DISC_KEY=disc_... \
  node frontend/tests/dormant_test.js
```

The dashboard verifies itself, and needs no backend at all — its suite
ships a mock one, which is what makes the three scenarios possible:

```bash
cd dashboard && npm install
npm run verify                 # typecheck, build, then the render suite
DISC_TEST_OUT=./shots npm test # same, keeping the screenshots
```

It is not in the repo root's `npm run verify` on purpose: it builds Next
and drives a browser, which is a couple of minutes rather than a couple
of seconds. Same reason the widget's Playwright suites are not in there
either.

To exercise the real signup path locally, `POST /sites` with any real
Shopify store's domain — it reads the public catalog, so no credentials
are involved:

```bash
curl -X POST localhost:8000/sites -H 'Content-Type: application/json' \
  -d '{"domain":"somestore.com"}'
```

Open `test.html` in a browser (it loads `frontend/disc-widget.js` and
points it at `http://localhost:8000`) to walk the whole boutique flow:
the fake theme's own search input gets hidden, Disc's bar docks at the
bottom, and searching opens the loading canvas -> results -> product
detail with sizes, add-to-cart and complete-the-look.

Because `test.html` isn't a real Shopify storefront, two things
deliberately behave differently there and **this is correct, not a bug**:
the backend serves the shared demo catalog (no `window.Shopify.shop` to
scope to), and add-to-cart reports itself as a demo instead of pretending
to succeed against a cart that doesn't exist.

Known limitation worth knowing about before "fixing" it: the widget's
dark-mode colors follow the shopper's OS-level `prefers-color-scheme`,
not the actual lightness of the merchant's page. A shopper in OS dark
mode on a site that's only ever light-themed will see Disc's dark-glass
text against a light backdrop bleeding through the blur, which can read
low-contrast. Properly fixing this means sampling the actual backdrop's
luminance (expensive, and not attempted here) rather than trusting the
OS preference as a proxy for it.

`python test_search.py` sends a real intent query straight to `POST
/search` and asserts on the ranking (semantic search should rank "Olive
Linen Overshirt" above "Heavyweight Boxy Hoodie" for a humid-beach-vacation
query).
