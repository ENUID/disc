"""Disc search API.

FastAPI service exposing POST /search for the Disc storefront widget.
Pipeline: embed the query with fastembed -> vector search in LanceDB ->
generate a one-sentence "why this matched" explanation with a local
Ollama model -> return ranked results. Everything here runs on CPU with
open-source components; there is no OpenAI or other paid API in the loop.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import lancedb
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastembed import TextEmbedding
from pydantic import BaseModel

from models import SearchResult

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("disc.server")

DB_PATH = Path(__file__).parent / "data" / "disc_lancedb"
TABLE_NAME = "products"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi3"
OLLAMA_TIMEOUT_SECONDS = 4

ml_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading fastembed model '%s'...", EMBED_MODEL)
    ml_state["embedder"] = TextEmbedding(model_name=EMBED_MODEL)
    logger.info("Connecting to LanceDB at %s...", DB_PATH)
    db = lancedb.connect(str(DB_PATH))
    ml_state["table"] = db.open_table(TABLE_NAME)
    logger.info("Disc search backend ready.")
    yield
    ml_state.clear()


app = FastAPI(title="Disc Search API", lifespan=lifespan)

# The widget runs embedded on arbitrary Shopify storefront domains, so the
# API must accept cross-origin requests from anywhere it's installed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SearchRequest(BaseModel):
    query: str
    limit: int = 3


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]


def generate_ai_reasoning(query: str, item: dict) -> str:
    """Ask a local Ollama model for a one-sentence explanation of the match.

    Falls back to a deterministic templated sentence if Ollama isn't
    running, isn't reachable, or doesn't respond within the timeout — the
    caller always gets a usable string back, never an exception.
    """
    prompt = (
        "You are a fashion search assistant. In exactly one short sentence, "
        "explain why this product matches the shopper's search. Be specific "
        "and concrete, do not repeat the product title verbatim.\n\n"
        f"Shopper search: \"{query}\"\n"
        f"Product: {item['title']}\n"
        f"Description: {item['description']}\n"
        f"Tags: {', '.join(item['tags'])}\n\n"
        "One-sentence explanation:"
    )

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.4, "num_predict": 60},
            },
            timeout=OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        text = response.json().get("response", "").strip()
        if text:
            return text.split("\n")[0].strip()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Ollama unavailable (%s), using fallback reasoning.", exc)

    return _fallback_reasoning(query, item)


def _fallback_reasoning(query: str, item: dict) -> str:
    top_tags = ", ".join(item["tags"][:3]) if item["tags"] else "its design"
    return f'Matches "{query}" thanks to its {top_tags} qualities.'


@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    embedder: TextEmbedding = ml_state["embedder"]
    table = ml_state["table"]

    query_vector = next(iter(embedder.embed([request.query]))).tolist()

    hits = table.search(query_vector).limit(request.limit).to_list()

    results = []
    for hit in hits:
        # LanceDB returns L2 distance; convert to a bounded 0-1 similarity
        # score that's friendlier for the widget to render (e.g. as a bar).
        score = 1.0 / (1.0 + hit["_distance"])
        reasoning = generate_ai_reasoning(request.query, hit)
        results.append(
            SearchResult(
                id=hit["id"],
                title=hit["title"],
                description=hit["description"],
                price=hit["price"],
                image_url=hit["image_url"],
                tags=hit["tags"],
                score=round(score, 4),
                reasoning=reasoning,
            )
        )

    return SearchResponse(query=request.query, results=results)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "disc-search"}
