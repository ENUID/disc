"""UCP-compliant product schema shared by ingest.py and server.py.

"UCP" here = Universal Catalog Product: the minimal, storefront-agnostic
shape Disc needs from any commerce platform (Shopify today, others later)
to embed and search a catalog. Keeping it as its own module means ingest
and search never drift out of sync on field names.
"""

from pydantic import BaseModel, Field


class Product(BaseModel):
    id: str
    title: str
    description: str
    price: float
    image_url: str
    tags: list[str] = Field(default_factory=list)

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
