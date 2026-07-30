# Disc — AI Boutique Widget

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and get a conversational **AI boutique**: a glass bar
docked above their store that, once used, opens a full-screen shopping
experience — editorial results, product detail with sizes and real
add-to-cart, complete-the-look outfitting, and a saved-items list.

The shape of the experience is modelled on Brunello Cucinelli's "AI
Online Boutique" (the reference the user supplied as a screen recording):

```
bar (always docked)
  -> loading canvas   ornament + rotating serif headline + line drawing
  -> results canvas   "Get inspired by these creations" + editorial grid
  -> product detail   full-bleed imagery + floating glass card
                      (MATERIALS / HOW TO STYLE, price, colour, sizes,
                       Add to cart, complete-the-look tray)
```

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

## Architecture

```
/backend
  ingest.py               -> builds the DEMO LanceDB table (backend/data/disc_lancedb) from
                              the 15-item sample catalog — used when no shop is registered,
                              e.g. this repo's own test.html
  server.py               -> FastAPI app: POST /search, OAuth install flow, webhooks
  db.py                   -> SQLite shop registry (shop -> access token, sync status)
  shopify_auth.py         -> OAuth authorize-URL building, token exchange, HMAC verification
  multi_tenant_ingest.py  -> per-shop catalog ingestion via the Admin API
  test_multi_tenant.py    -> HMAC + parsing + per-shop isolation tests (no real credentials needed)
  requirements.txt
  data/                   -> gitignored: disc_lancedb (demo), disc_lancedb_multi (per real shop,
                              one LanceDB table each), shops.db (SQLite)
/frontend
  disc-widget.js  -> the entire client: Web Component + Shadow DOM + native-input takeover
test.html         -> a fake Shopify PDP/search page for local end-to-end testing
test_search.py    -> scripted test hitting POST /search with a real intent query (demo catalog)
```

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

### Multi-tenant Shopify app — how one install becomes that store's AI

This is what makes Disc *that particular store's* AI rather than a demo:
a real Shopify OAuth app, one isolated LanceDB table per installed shop,
built from that shop's actual Admin API catalog and kept in sync by
product webhooks.

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

**What can and can't be tested without a real Partner app**:
`backend/test_multi_tenant.py` covers everything that doesn't require
real Shopify credentials or a public deployment — HMAC verification
(accepts a correctly-signed request, rejects a tampered one, in both the
OAuth-callback and webhook signature schemes, which are different),
Admin API product JSON parsing against a fixture, and full per-shop
isolation (two fake shops ingested via a monkeypatched `fetch_all_products`,
then queried through the live `/search` endpoint to confirm neither sees
the other's catalog). It deliberately does *not* and *cannot* verify that
the real OAuth round trip or webhook delivery works against Shopify's
actual servers — see "Going live" below for what that requires.

### Frontend — the widget contract

**Critical rule: no double search bars.** Once Disc attaches, there is
exactly one visible, usable search entry point on the page — Disc's own.

1. `<disc-search-bar>` mounts and is immediately usable: `position:
   fixed`, centered near the bottom of the viewport (`bottom: max(20px,
   env(safe-area-inset-bottom))`, `width: min(640px, calc(100vw -
   32px))`). It is **not** positioned relative to the native search input
   — it doesn't need to know where that is, or even whether one exists,
   to render and function.
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
9. Sizing is meant to hold up across the full device range (phone
   portrait/landscape, tablet, desktop) without a device-specific branch.
   Verify any future CSS change against at least a narrow phone
   (~320–390px), a **short landscape phone (~390px tall)**, and a wide
   desktop viewport — it's cheap with Playwright and easy to silently
   break one while fixing another. The landscape case has already caught
   two real bugs.
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
12. **The detail view's glass card lives in `.disc-overlay`, outside the
    scrolling `.disc-body`.** This is deliberate and load-bearing: sticky
    positioning can't keep it pinned, because a sticky element stops as
    soon as its own parent's content ends — that bug left the card
    floating mid-page. Within the overlay only `.disc-detail-secondary`
    (chips, panels, look tray) scrolls; `.disc-buy` is `flex-shrink: 0`,
    so on a short viewport the chips clip rather than Add-to-cart being
    pushed out of reach. That was a real bug found on a 390px-tall
    landscape phone, where the purchase card was completely unreachable.
13. `[hidden] { display: none !important; }` is required — without it the
    attribute is a no-op on anything given an explicit `display` value,
    which is why the Back button once appeared on the results view.
14. Canvas chrome must be **theme-proof**: nav buttons and secondary text
    derive from `--disc-ink` (with opacity) or neutral translucent grey,
    never hardcoded white/black. A merchant's canvas may be near-black,
    and a white pill on white is invisible — a bug the dark-theme test
    caught.
15. Add-to-cart posts to Shopify's own AJAX Cart API (`/cart/add.js`) on
    the merchant's domain; Disc never proxies commerce. On a page that
    isn't a Shopify storefront there is no cart, so it resolves as
    `"demo"` and the UI says so plainly rather than faking success.
    A multi-size product refuses to add until a size is chosen, mirroring
    how real storefronts behave.
16. The wishlist is `localStorage` only — no account, no PII, nothing sent
    to the backend. Toggling a heart updates every instance of that
    product on screen at once (grid card, look tray, detail card).

There is no photo-attachment/visual-search capability, deliberately. Both
reference implementations had one (attach a photo, search visually), but
our backend has no image-embedding pipeline, and the user explicitly
asked for that icon to be removed rather than ship a button that looks
functional but does nothing. Don't re-add it without both a real backend
capability behind it and the user asking for it.

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

## Going live: manual setup this repo cannot do for you

Every line of the OAuth/webhook/ingestion code is written and tested (as
far as it can be without real credentials — see `test_multi_tenant.py`
above). What's left is entirely outside what a coding session can do,
because it requires *your* Shopify account and a real public deployment:

1. **Create a Shopify Partner account** (partners.shopify.com, free) and
   **register an app** in the Partner Dashboard. This produces the
   `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` that `shopify_auth.py`
   reads from the environment — nothing in this codebase can generate
   or guess these; they only exist once you create the app.
2. **Deploy this backend somewhere with a real, public HTTPS URL.**
   `localhost:8000` cannot receive Shopify's OAuth redirect or its
   webhooks — both are requests *from* Shopify's servers *to* this
   backend, so they need a real reachable address. Set that URL as the
   `APP_URL` environment variable (it's used to build the OAuth
   `redirect_uri` and every webhook `address`).
3. **Set the environment variables** the deployed process needs:
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES` (defaults to
   `read_products`, which is all this app needs), `APP_URL`.
4. **In the Partner Dashboard**, set the app's URL and allowed redirect
   URL to `{APP_URL}` and `{APP_URL}/auth/callback`. Configure the three
   mandatory GDPR webhook endpoints there too (Shopify requires these to
   be registered in the Dashboard, not via the Admin API):
   `{APP_URL}/webhooks/customers/data_request`,
   `{APP_URL}/webhooks/customers/redact`,
   `{APP_URL}/webhooks/shop/redact`.
5. **Install it on a real (or development) store** by visiting
   `{APP_URL}/auth?shop=your-dev-store.myshopify.com` — this is the
   first point where any of this code actually talks to Shopify's
   servers, so it's also the first real end-to-end test. Watch the
   backend logs during `_run_full_ingestion`; `GET
   /shops/{shop}/status` reports `sync_status` (`pending` ->
   `syncing` -> `ready`, or `error`) without needing log access.
6. If you intend to list this on the Shopify App Store rather than use
   it privately: that adds app review, a privacy policy URL, listing
   assets, and (if charging merchants) the Billing API — none of that
   is built here, and it's a separate scope decision from "the app
   works," not a coding task blocked on anything above.

## Local dev

```bash
cd backend
pip install -r requirements.txt
python ingest.py          # builds backend/data/disc_lancedb from the sample catalog
uvicorn server:app --reload --port 8000
```

`python test_multi_tenant.py` (from `/backend`, with the server running)
runs everything about the OAuth/webhook/multi-tenant pipeline that's
testable without real Shopify credentials: HMAC verification, Admin API
product parsing, and full per-shop search isolation between two fake
shops.

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
