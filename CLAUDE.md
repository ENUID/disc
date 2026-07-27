# Disc — Intent Search Widget

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and get a conversational search bar that floats fixed
above the whole store — like Claude's own bottom-docked composer, on
every device, sized and spaced for whatever viewport it's opened in. The
page scrolls underneath it, visible blurred through the glass. The
theme's own native search input is hidden as soon as Disc attaches (its
layout space is preserved so nothing else on the page reflows — this is
not a DOM removal) since merchants don't need two search boxes once Disc
is installed.

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
  ingest.py       -> builds the LanceDB vector table from the product catalog
  server.py       -> FastAPI app, POST /search
  requirements.txt
  data/           -> generated LanceDB directory (gitignored; rebuild with `python ingest.py`)
/frontend
  disc-widget.js  -> the entire client: Web Component + Shadow DOM + native-input takeover
test.html         -> a fake Shopify PDP/search page for local end-to-end testing
test_search.py    -> scripted test hitting POST /search with a real intent query
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
  never changes shape based on whether Ollama is up.

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
   portrait/landscape, tablet, desktop) without a device-specific branch:
   the `min()`/`env()`-based host sizing and the panel's `dvh`-capped
   height are what do that work. Verify any future CSS change against at
   least a narrow phone (~320–375px), a short landscape phone (~375px
   tall), and a wide desktop viewport — it's cheap to check with
   Playwright and easy to silently break one of them while fixing another.

There is no photo-attachment/visual-search capability, deliberately. A
reference implementation this was ported from had one (attach a photo,
search visually against it), but our backend has no image-embedding
pipeline, and the user explicitly asked for that icon to be removed
rather than have a button that looks functional but does nothing. Don't
re-add an attach button without both a real backend capability behind it
and the user asking for it.

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

## Local dev

```bash
cd backend
pip install -r requirements.txt
python ingest.py          # builds backend/data/disc_lancedb from the sample catalog
uvicorn server:app --reload --port 8000
```

Open `test.html` in a browser (it loads `frontend/disc-widget.js` and
points it at `http://localhost:8000`) to see the fake theme's own search
input get hidden and Disc's own glass bar floating at the bottom.

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
