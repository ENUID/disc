"""UCP-compliant product schema shared by ingest.py and server.py.

"UCP" here = Universal Catalog Product: the minimal, storefront-agnostic
shape Disc needs from any commerce platform (Shopify today, others later)
to embed and search a catalog. Keeping it as its own module means ingest
and search never drift out of sync on field names.
"""

from pydantic import BaseModel, Field


class Variant(BaseModel):
    """One purchasable size/colour combination.

    `id` is the platform's own variant id — it's what a real add-to-cart
    call needs, so it has to survive ingestion intact.
    """

    id: str
    title: str
    price: float
    available: bool = True


class Product(BaseModel):
    id: str
    title: str
    description: str
    price: float
    image_url: str
    tags: list[str] = Field(default_factory=list)
    # Everything below supports the storefront experience (detail view,
    # size picker, cart, complete-the-look) rather than search itself.
    handle: str = ""
    product_type: str = ""
    images: list[str] = Field(default_factory=list)
    variants: list[Variant] = Field(default_factory=list)
    colour: str = ""
    currency: str = "USD"

    def embedding_text(self) -> str:
        """Text blob fed to the embedding model: title + description + tags."""
        return f"{self.title}. {self.description} Tags: {', '.join(self.tags)}"


class SearchResult(BaseModel):
    id: str
    title: str
    description: str
    price: float
    image_url: str
    tags: list[str]
    score: float
    reasoning: str
    handle: str = ""
    product_type: str = ""
    images: list[str] = Field(default_factory=list)
    variants: list[Variant] = Field(default_factory=list)
    colour: str = ""
    currency: str = "USD"
