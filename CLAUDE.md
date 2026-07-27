# Disc — Intent Search Widget

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and get a persistent AI-powered conversational search bar
docked to the bottom of the viewport. **The store itself is never
touched** — Disc does not hijack, restyle, or intercept the theme's own
native search. It's a second, independent, always-visible entry point,
not a replacement for anything already on the page.

(An earlier iteration of this widget hijacked the theme's native search
input instead of adding its own bar. That approach is gone — don't
reintroduce DOM-scanning/hijack logic without checking with the user
first, since moving away from it was a deliberate product decision.)

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
  disc-widget.js  -> the entire client: Web Component + Shadow DOM + DOM hijack logic
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

**Critical rule: the store stays the same.** Disc adds exactly one new
element to the page and touches nothing else — no restyling the theme, no
intercepting its search form, no second input competing with the native
one for the same spot on the page.

1. `<disc-search-bar>` is a single custom element, appended to `<body>`
   once on page load (or `DOMContentLoaded` if the script runs before the
   body exists). No DOM scanning, no waiting for a native element —
   Disc owns its input from the start and the bar is present for the
   whole page lifetime.
2. The host element is `position: fixed`, centered near the bottom of the
   viewport (`bottom: max(20px, env(safe-area-inset-bottom))`). Only the
   results panel above it opens and closes; the bar itself never
   disappears.
3. All rendered UI — the input, the results panel, skeleton loaders,
   result cards — lives inside that one element's `attachShadow({ mode:
   "open" })` root. Shadow DOM is what gives CSS isolation on an
   arbitrary, unknown Shopify theme; styles are injected as a `<style>`
   tag inside the shadow root, never into the host document's `<head>`.
4. The results panel is positioned with plain CSS (`position: absolute;
   bottom: calc(100% + 12px)`) relative to the bar, inside the same
   shadow root — no `getBoundingClientRect` math needed, since both live
   in the same fixed-position container.

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
points it at `http://localhost:8000`) to see the persistent bar at the
bottom of the page and confirm the fake theme's own search form above it
is completely untouched.

`python test_search.py` sends a real intent query straight to `POST
/search` and asserts on the ranking (semantic search should rank "Olive
Linen Overshirt" above "Heavyweight Boxy Hoodie" for a humid-beach-vacation
query).
