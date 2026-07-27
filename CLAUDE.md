# Disc — Intent Search Widget

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and Disc takes over the spot on the page where the
theme's own search input lives. That native input is hidden (its layout
space is preserved so nothing else on the page reflows — this is not a
DOM removal) and Disc's own glass conversational bar is positioned
exactly on top of it. Merchants don't need two search boxes once Disc is
installed, so the native one visually disappears in place.

This has gone through two prior iterations, both retired deliberately —
don't reintroduce either without checking with the user first:
1. Hijacking the native input directly (reusing its DOM node, attaching
   listeners to it, `preventDefault()` on its form submit).
2. An independent bar fixed to the bottom of the viewport, coexisting
   with an untouched native search elsewhere on the page.

The current model is a hybrid: Disc owns its own separate input/DOM (not
the native node, same as iteration 2), but is positioned at the native
input's location and hides it (closer to iteration 1's visual outcome,
achieved without touching the native element's events).

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

1. A `DOMScanner` polls every 500ms for a native input matching
   `input[name="q"], input[type="search"]` (extend selectors as needed
   per-theme). Once found, the interval is cleared and `attachTo()` runs.
2. `attachTo(nativeInputEl)` sets `nativeInputEl.style.visibility =
   "hidden"` (not `display: none` — visibility preserves the element's
   layout space, so the rest of the theme doesn't reflow around a
   collapsed box) and positions Disc's own host element exactly over it,
   vertically centered on the native input's center point since Disc's
   two-row bar is taller than a typical single-line search input.
3. `<disc-search-bar>` is `position: fixed` and starts `visibility:
   hidden` in `connectedCallback` — it stays invisible until `attachTo()`
   knows where to put it, so there's no flash at the wrong spot (e.g. the
   top-left corner) while the scanner is still looking.
4. Position is recalculated on `scroll` (capture phase, so it catches
   scrolling inside any container, not just the window) and `resize`,
   the same way the very first hijack-based iteration did it —
   `getBoundingClientRect()` on the native input, applied to the fixed
   host's `left`/`top`/`width`.
5. All rendered UI — the input, the results panel, skeleton loaders,
   result cards — lives inside that one element's `attachShadow({ mode:
   "open" })` root. Styles are injected as a `<style>` tag inside the
   shadow root, never into the host document's `<head>`.
6. The results panel opens **downward** (`position: absolute; top:
   calc(100% + 12px)`) since the bar now typically sits near the top of
   the page rather than pinned to the viewport bottom — check this if
   you ever see it rendering off-screen above the viewport.

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
input get hidden and Disc's glass bar take its exact place.

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
