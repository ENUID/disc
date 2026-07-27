"""Build the Disc LanceDB vector table from the demo product catalog.

Run this once (and again any time the catalog changes):

    python ingest.py

It embeds each product's title + description + tags with fastembed
(CPU-only, no torch) and writes the vectors + metadata into a local
LanceDB table at ./data/disc_lancedb. No network calls, no paid APIs.
"""

from pathlib import Path

import lancedb
from fastembed import TextEmbedding

from models import Product

DB_PATH = Path(__file__).parent / "data" / "disc_lancedb"
TABLE_NAME = "products"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"

CATALOG: list[Product] = [
    Product(
        id="p001",
        title="Olive Linen Overshirt",
        description="A breathable, lightweight overshirt woven from 100% European linen. "
        "Relaxed boxy fit, breast pockets, designed to be worn open over a tee in humid, "
        "warm-weather climates. Wrinkle-prone by design for a lived-in, vacation-ready look.",
        price=128.00,
        image_url="https://images.disc.dev/products/olive-linen-overshirt.jpg",
        tags=["linen", "breathable", "summer", "beach", "lightweight", "layering", "vacation"],
    ),
    Product(
        id="p002",
        title="Heavyweight Boxy Hoodie",
        description="A dense, 450gsm heavyweight cotton fleece hoodie built for cold weather "
        "and warmth retention. Oversized boxy silhouette, brushed interior fleece, ribbed cuffs.",
        price=98.00,
        image_url="https://images.disc.dev/products/heavyweight-boxy-hoodie.jpg",
        tags=["fleece", "warm", "winter", "streetwear", "cotton", "oversized"],
    ),
    Product(
        id="p003",
        title="Silk Evening Slip Dress",
        description="A bias-cut slip dress in mulberry silk charmeuse with delicate adjustable "
        "straps. Fluid drape, cool to the touch, designed for evening events and dinner dates.",
        price=245.00,
        image_url="https://images.disc.dev/products/silk-evening-slip.jpg",
        tags=["silk", "evening", "formal", "date-night", "elegant", "dress"],
    ),
    Product(
        id="p004",
        title="Wide-Leg Tailored Trouser",
        description="High-rise wide-leg trouser in a structured wool-blend twill. Sharp double "
        "pleats, a fluid drape through the leg, built for the office or a formal occasion.",
        price=165.00,
        image_url="https://images.disc.dev/products/wide-leg-tailored-trouser.jpg",
        tags=["tailored", "formal", "office", "wool", "trouser", "workwear"],
    ),
    Product(
        id="p005",
        title="Ribbed Cotton Tank",
        description="A close-fitting ribbed cotton tank with a slightly cropped hem. Soft, "
        "stretchy, breathable — a warm-weather layering basic or standalone summer top.",
        price=42.00,
        image_url="https://images.disc.dev/products/ribbed-cotton-tank.jpg",
        tags=["cotton", "summer", "basics", "breathable", "layering", "tank"],
    ),
    Product(
        id="p006",
        title="Shearling Collar Leather Jacket",
        description="A cropped leather moto jacket with a plush shearling collar for maximum "
        "insulation. Built for freezing temperatures and harsh winter wind.",
        price=890.00,
        image_url="https://images.disc.dev/products/shearling-leather-jacket.jpg",
        tags=["leather", "winter", "warm", "shearling", "outerwear", "cold-weather"],
    ),
    Product(
        id="p007",
        title="Technical Rain Shell",
        description="A fully seam-taped waterproof shell with a packable hood, designed for "
        "unpredictable weather. Lightweight, breathable membrane, articulated sleeves.",
        price=210.00,
        image_url="https://images.disc.dev/products/technical-rain-shell.jpg",
        tags=["waterproof", "technical", "rain", "outerwear", "lightweight", "shell"],
    ),
    Product(
        id="p008",
        title="Cashmere Crewneck Sweater",
        description="A featherweight two-ply cashmere crewneck. Soft next-to-skin hand feel, "
        "ideal as a warm mid-layer for cool but not freezing days.",
        price=310.00,
        image_url="https://images.disc.dev/products/cashmere-crewneck.jpg",
        tags=["cashmere", "sweater", "warm", "soft", "mid-layer", "luxury"],
    ),
    Product(
        id="p009",
        title="Cotton Poplin Camp Collar Shirt",
        description="A short-sleeve camp collar shirt in crisp cotton poplin. Open weave, "
        "airy fit, tailored for hot, humid climates and beach resort settings.",
        price=88.00,
        image_url="https://images.disc.dev/products/poplin-camp-collar-shirt.jpg",
        tags=["cotton", "summer", "resort", "breathable", "beach", "vacation"],
    ),
    Product(
        id="p010",
        title="Merino Wool Base Layer",
        description="A next-to-skin merino wool base layer designed for temperature regulation "
        "in cold conditions. Naturally odor-resistant, moisture-wicking, warm.",
        price=95.00,
        image_url="https://images.disc.dev/products/merino-base-layer.jpg",
        tags=["merino", "wool", "warm", "base-layer", "winter", "technical"],
    ),
    Product(
        id="p011",
        title="Distressed Straight-Leg Denim",
        description="Rigid selvedge denim in a classic straight-leg cut with subtle distressing "
        "at the knee. Mid-weight, holds a crease, built to fade with wear.",
        price=175.00,
        image_url="https://images.disc.dev/products/distressed-straight-denim.jpg",
        tags=["denim", "casual", "everyday", "selvedge", "straight-leg"],
    ),
    Product(
        id="p012",
        title="Quilted Puffer Vest",
        description="A down-filled quilted puffer vest for core warmth without bulk on the "
        "arms. High collar, wind-resistant shell, built for cold layering.",
        price=140.00,
        image_url="https://images.disc.dev/products/quilted-puffer-vest.jpg",
        tags=["puffer", "down", "warm", "winter", "vest", "layering"],
    ),
    Product(
        id="p013",
        title="Linen-Blend Drawstring Shorts",
        description="Relaxed drawstring shorts in a breathable linen-cotton blend. Elastic "
        "waistband, side pockets, cut for hot weather and beach days.",
        price=68.00,
        image_url="https://images.disc.dev/products/linen-drawstring-shorts.jpg",
        tags=["linen", "shorts", "summer", "beach", "breathable", "vacation"],
    ),
    Product(
        id="p014",
        title="Structured Wool Overcoat",
        description="A single-breasted wool overcoat with a structured shoulder and full "
        "canvas construction. Heavy, warm, formal — built for city winters.",
        price=520.00,
        image_url="https://images.disc.dev/products/wool-overcoat.jpg",
        tags=["wool", "overcoat", "formal", "winter", "warm", "outerwear"],
    ),
    Product(
        id="p015",
        title="Performance Mesh Training Tee",
        description="A moisture-wicking mesh performance tee with laser-cut ventilation "
        "panels. Ultra-lightweight, quick-dry, built for high-output training.",
        price=54.00,
        image_url="https://images.disc.dev/products/mesh-training-tee.jpg",
        tags=["athletic", "performance", "breathable", "training", "moisture-wicking"],
    ),
]


def build_table() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(DB_PATH))

    print(f"Loading embedding model '{EMBED_MODEL}' (CPU, ONNX runtime, no torch)...")
    embedder = TextEmbedding(model_name=EMBED_MODEL)

    texts = [product.embedding_text() for product in CATALOG]
    print(f"Embedding {len(texts)} products...")
    vectors = list(embedder.embed(texts))

    records = [
        {
            "id": product.id,
            "title": product.title,
            "description": product.description,
            "price": product.price,
            "image_url": product.image_url,
            "tags": product.tags,
            "vector": vector.tolist(),
        }
        for product, vector in zip(CATALOG, vectors)
    ]

    print(f"Writing table '{TABLE_NAME}' to {DB_PATH}...")
    db.create_table(TABLE_NAME, data=records, mode="overwrite")
    print(f"Done. {len(records)} products indexed.")


if __name__ == "__main__":
    build_table()
