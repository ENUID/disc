# Disc — Intent Search Widget

## What this is

Disc is a B2B product from Enuid Labs. Shopify merchants install a single
`<script>` tag and their native storefront search silently becomes an
AI-powered semantic intent engine. There is no new UI chrome to configure —
Disc hijacks the merchant's existing search input and renders results in a
floating overlay.

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

**Critical rule: no double search bars.** Disc never renders its own
visible `<input>`. It must not duplicate the merchant's search box.

1. A `DOMScanner` polls every 500ms for a native input matching
   `input[name="q"], input[type="search"]` (extend selectors as needed
   per-theme). Once found, the interval is cleared — scanning never runs
   forever.
2. Disc attaches listeners directly to that native input: `focus`,
   `input` (300ms debounced fetch), and `keydown` for Enter. It also
   listens for the enclosing `<form>` `submit` and calls
   `e.preventDefault()` so the native Shopify search page never loads
   underneath the overlay.
3. All rendered UI — the dropdown, skeleton loaders, result cards — lives
   inside a single `<disc-search-overlay>` custom element with an open
   `attachShadow({ mode: "open" })` root. Shadow DOM is what gives CSS
   isolation on an arbitrary, unknown Shopify theme; styles are injected
   as a `<style>` tag inside the shadow root, never into the host
   document's `<head>`.
4. The overlay is absolutely positioned directly beneath the native input
   (computed from `getBoundingClientRect()`), not injected inline into the
   theme's DOM tree.

### Design system

Monochrome premium fashion-OS look: black/white/gray palette, `Inter` /
`system-ui` font stack, 1px hairline borders, `backdrop-filter: blur(12px)`
glassmorphism, 0.2s ease opacity transitions, skeleton-loader shimmer while
a request is in flight.

## Local dev

```bash
cd backend
pip install -r requirements.txt
python ingest.py          # builds backend/data/disc_lancedb from the sample catalog
uvicorn server:app --reload --port 8000
```

Open `test.html` in a browser (it loads `frontend/disc-widget.js` and
points it at `http://localhost:8000`) to exercise the full hijack + search
flow against a fake Shopify search form.

`python test_search.py` sends a real intent query straight to `POST
/search` and asserts on the ranking (semantic search should rank "Olive
Linen Overshirt" above "Heavyweight Boxy Hoodie" for a humid-beach-vacation
query).
