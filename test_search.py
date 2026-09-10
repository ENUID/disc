"""Scripted test: simulate a real shopper intent query against POST /search.

Verifies the whole ingest -> embed -> LanceDB -> rank pipeline actually
understands intent rather than just keyword-matching: a "breathable ...
humid beach vacation" query should surface linen/breathable summer pieces
above a heavyweight winter hoodie.

Run with the server already up:
    uvicorn server:app --port 8000   (from /backend)
    python test_search.py            (from repo root)
"""

import sys

import requests

API_URL = "http://localhost:8000/search"
QUERY = "I need a breathable layer for a humid beach vacation"


def main() -> int:
    print(f"POST {API_URL}")
    print(f"query: {QUERY!r}\n")

    try:
        response = requests.post(API_URL, json={"query": QUERY, "limit": 5}, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"FAIL: request error: {exc}")
        return 1

    data = response.json()
    results = data["results"]

    print(f"{'rank':<5}{'score':<8}{'title'}")
    for i, item in enumerate(results, start=1):
        print(f"{i:<5}{item['score']:<8}{item['title']}")
        print(f"      reasoning: {item['reasoning']}")

    titles = [item["title"] for item in results]

    hoodie = "Heavyweight Boxy Hoodie"
    linen_overshirt = "Olive Linen Overshirt"

    hoodie_rank = titles.index(hoodie) if hoodie in titles else len(titles)
    linen_rank = titles.index(linen_overshirt) if linen_overshirt in titles else 999

    ok = True

    if linen_overshirt not in titles:
        print(f"\nFAIL: expected '{linen_overshirt}' to appear in top {len(titles)} results.")
        ok = False

    if hoodie in titles and hoodie_rank < linen_rank:
        print(f"\nFAIL: '{hoodie}' ranked above '{linen_overshirt}' — semantic search is not working.")
        ok = False

    if ok:
        print(
            f"\nPASS: '{linen_overshirt}' ranked at #{linen_rank + 1}, "
            f"'{hoodie}' correctly excluded from/ranked below it."
        )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
