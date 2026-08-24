/**
 * Model provider adapters (spec §83: "Do not hardcode one vendor").
 *
 * Three roles, three interfaces, because they have genuinely different
 * cost and latency profiles and should be routed differently (§83's
 * model routing table): cheap model for extraction, stronger model for
 * ambiguous reasoning and judging, vision model only when there is an
 * image worth looking at.
 *
 * Every call returns which model and prompt version produced it, so a
 * recommendation trace can record it (§81) and a quality regression can
 * be attributed to a specific change rather than guessed at.
 */

export type ModelResponse = {
  text: string;
  model: string;
  promptVersion: string;
  /** Rough token accounting, when the provider reports it. */
  inputTokens?: number;
  outputTokens?: number;
};

export type ReasoningRequest = {
  system: string;
  user: string;
  promptVersion: string;
  /** Hard cap. Spec §86 requires token budgets, not best effort. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask the provider for strict JSON where it supports it. */
  json?: boolean;
};

export type VisionRequest = ReasoningRequest & {
  imageUrls: string[];
};

export interface ReasoningProvider {
  readonly name: string;
  complete(request: ReasoningRequest): Promise<ModelResponse>;
}

export interface VisionProvider {
  readonly name: string;
  describe(request: VisionRequest): Promise<ModelResponse>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

/**
 * Anthropic — used for both reasoning and vision.
 *
 * One provider covering both roles keeps the moving parts down; the
 * interfaces stay separate so either can be pointed elsewhere after
 * benchmarking, which §83 asks for.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

class AnthropicProvider implements ReasoningProvider, VisionProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.name = `anthropic:${model}`;
  }

  private async call(
    body: Record<string, unknown>,
    promptVersion: string,
  ): Promise<ModelResponse> {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // 429 and 5xx are worth retrying; a 400 means the request itself
      // is wrong and retrying just burns money.
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        `Model request failed (${response.status})`,
        retryable,
      );
    }

    const payload = await response.json();
    const text = (payload.content ?? [])
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("");

    return {
      text,
      model: this.model,
      promptVersion,
      inputTokens: payload.usage?.input_tokens,
      outputTokens: payload.usage?.output_tokens,
    };
  }

  async complete(request: ReasoningRequest): Promise<ModelResponse> {
    return this.call(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens ?? 1024,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
      request.promptVersion,
    );
  }

  async describe(request: VisionRequest): Promise<ModelResponse> {
    // Images are capped: spec §86 requires image-size control, and a
    // product's fifth photograph rarely changes the answer while
    // multiplying the cost of every enrichment.
    const images = request.imageUrls.slice(0, 2).map((url) => ({
      type: "image",
      source: { type: "url", url },
    }));

    return this.call(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens ?? 1024,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: [
          { role: "user", content: [...images, { type: "text", text: request.user }] },
        ],
      },
      request.promptVersion,
    );
  }
}

/**
 * Deterministic stand-in, for tests and for a deployment with no model
 * key configured.
 *
 * This is the same contract the Python prototype got right and is worth
 * preserving: when the model is unavailable the response *shape* never
 * changes, so no caller needs a second code path. It returns valid empty
 * JSON — "we established nothing" — rather than inventing attributes,
 * which is the honest failure for an enrichment step.
 */
export class NullReasoningProvider implements ReasoningProvider, VisionProvider {
  readonly name = "null-provider";

  async complete(request: ReasoningRequest): Promise<ModelResponse> {
    return { text: "{}", model: this.name, promptVersion: request.promptVersion };
  }

  async describe(request: VisionRequest): Promise<ModelResponse> {
    return { text: "{}", model: this.name, promptVersion: request.promptVersion };
  }
}

/**
 * Model routing (spec §83).
 *
 * Extraction is high-volume and structured, so it gets the cheap model.
 * Judging and ambiguous intent decide what a shopper sees, so they get
 * the stronger one. Both are overridable by env without a code change.
 */
export function reasoningProvider(apiKey: string, tier: "fast" | "strong" = "fast") {
  if (!apiKey) return new NullReasoningProvider();
  const model =
    tier === "strong"
      ? process.env.DISC_MODEL_STRONG || "claude-sonnet-4-5"
      : process.env.DISC_MODEL_FAST || "claude-haiku-4-5-20251001";
  return new AnthropicProvider(apiKey, model);
}

export function visionProvider(apiKey: string): VisionProvider {
  if (!apiKey) return new NullReasoningProvider();
  const model = process.env.DISC_MODEL_VISION || "claude-haiku-4-5-20251001";
  return new AnthropicProvider(apiKey, model);
}

/**
 * Extract a JSON object from a model response.
 *
 * Models wrap JSON in prose or fences even when told not to. This
 * recovers the object rather than discarding an otherwise-good answer,
 * and returns null rather than throwing when there is nothing usable —
 * spec §85's "repair/retry → fallback", with the fallback being an
 * honest empty result.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
