/**
 * Embedding provider adapter (spec §83: "Do not hardcode one vendor").
 *
 * The Python prototype called `fastembed` directly at two call sites,
 * which made the model impossible to change or benchmark. This is the
 * seam. It matters more than it looks: the local model was text-only,
 * and spec §34 wants visual similarity too, so this stack is going to
 * change again.
 *
 * Dimensions are declared per provider and must match
 * `schema.ts`'s `vectorIndex.dimensions`. Changing the model is
 * therefore a schema change plus a full re-embed of every tenant — there
 * is no conversion between embedding spaces.
 */

import type { UsageSink } from "./providers";

export type EmbeddingProvider = {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

/** Matches schema.ts. Changing this requires re-embedding every tenant. */
export const EMBEDDING_DIMENSIONS = 1536;

class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai:text-embedding-3-small";
  readonly dimensions = 1536;

  // Explicit field rather than a parameter property — those emit
  // runtime code that Node's type-stripping test runner rejects.
  private apiKey: string;
  private sink: UsageSink;

  constructor(apiKey: string, sink: UsageSink) {
    this.apiKey = apiKey;
    this.sink = sink;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = await response.json();

    // Embeddings are the cheapest thing here per call and the easiest to
    // dismiss as free — but a query is embedded on every single /search,
    // which is the one cost on that path that scales with traffic rather
    // than with catalog size. Unmetered, it hides underneath ingestion.
    await this.sink({
      model: "text-embedding-3-small",
      inputTokens: payload.usage?.prompt_tokens ?? payload.usage?.total_tokens ?? 0,
      outputTokens: 0,
    });

    // The API may return results out of order; `index` is authoritative.
    // Trusting array position here would mis-assign vectors to products,
    // which corrupts search silently rather than failing.
    const out: number[][] = new Array(texts.length);
    for (const item of payload.data) {
      out[item.index] = item.embedding;
    }
    return out;
  }
}

/**
 * Deterministic local embeddings, for tests only.
 *
 * Not a real semantic model — it hashes tokens into a fixed-width vector.
 * It exists so the ingest and tenant-isolation paths can be tested
 * without a network call or an API key, exactly as the Python suite could
 * be run with no credentials. Never selected when an API key is present.
 */
export class DeterministicEmbeddings implements EmbeddingProvider {
  readonly name = "deterministic-test";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array(this.dimensions).fill(0);
      const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
      for (const token of tokens) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i++) {
          h = Math.imul(h ^ token.charCodeAt(i), 16777619) >>> 0;
        }
        vec[h % this.dimensions] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
      return vec.map((x) => x / norm);
    });
  }
}

export function getEmbeddingProvider(
  apiKey: string,
  sink: UsageSink,
): EmbeddingProvider {
  if (apiKey) return new OpenAIEmbeddings(apiKey, sink);
  return new DeterministicEmbeddings();
}
