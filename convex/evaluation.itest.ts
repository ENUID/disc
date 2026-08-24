import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DeterministicEmbeddings } from "./lib/embeddings";
import {
  evaluateCase,
  formatSummary,
  summarise,
  type CaseResult,
} from "./lib/evaluation";
import { emptyIntent } from "./lib/intent";
import type { Candidate, Outfit } from "./lib/outfit";
import { expandedCases } from "../evaluation/cases";
import {
  FIXTURE_BRAND_STYLE,
  FIXTURE_CATALOG,
  fixtureProfile,
} from "../evaluation/fixture-catalog";

/**
 * The benchmark run (spec §98, §134).
 *
 * Runs every case against the real engine on a fixed catalog with no
 * model keys, so the score is reproducible and a drop points at a code
 * change rather than at model variance.
 *
 * The threshold at the bottom is the actual regression gate: it fails
 * the build if the pass rate drops. That is what "no silent quality
 * regression" means in practice — not a report someone might read, but a
 * number that stops a merge.
 */

const modules = import.meta.glob("./**/*.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicApi = () => api as any;

/**
 * Minimum pass rate.
 *
 * Set to 1.0 because the engine is deterministic and the catalog is
 * fixed, so there is no flakiness for slack to absorb — every failure is
 * a real change in behaviour.
 *
 * When a case fails, fix the engine or fix the case. Never lower this to
 * make a build go green: the number dropping is the signal, and muting
 * it is the one action that guarantees the regression ships.
 */
const PASS_RATE_FLOOR = 1.0;

async function seedFixtureShop(t: ReturnType<typeof convexTest>) {
  const provider = new DeterministicEmbeddings();

  const tenantId: Id<"tenants"> = await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      shopDomain: "fixture.myshopify.com",
      publicKey: "disc_fixture",
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      productCount: FIXTURE_CATALOG.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  await t.run(async (ctx) => {
    await ctx.db.insert("brandBrains", {
      tenantId,
      version: 1,
      isCurrent: true,
      styleVector: FIXTURE_BRAND_STYLE,
      palette: { dominant: ["navy", "white", "beige"] },
      formality: { min: 1, max: 4, median: 3 },
      productWorld: {},
      voice: { tone: ["quiet", "editorial"], preferredTerms: ["piece"], avoidTerms: ["deal"] },
      summary: "Quiet, classic menswear in muted neutrals.",
      derivedFrom: {},
      source: "derived",
      confidence: 0.9,
      createdAt: Date.now(),
    });
  });

  for (const product of FIXTURE_CATALOG) {
    const [embedding] = await provider.embed([product.description]);
    await t.run(async (ctx) => {
      const productId = await ctx.db.insert("products", {
        tenantId,
        shopifyProductId: product.id,
        title: product.title,
        description: product.description,
        handle: product.id,
        productType: product.productType,
        vendor: "Fixture",
        tags: [],
        price: product.price,
        currency: "USD",
        imageUrl: "https://cdn/a.jpg",
        images: ["https://cdn/a.jpg"],
        colour: "",
        variants: [
          { id: `${product.id}-v`, title: "M", price: product.price, available: product.available },
        ],
        anyVariantAvailable: product.available,
        ingestedAt: Date.now(),
      });
      await ctx.db.insert("productEmbeddings", {
        tenantId,
        productId,
        embedding,
        embeddingModel: provider.name,
        contentHash: product.id,
        createdAt: Date.now(),
      });
      await ctx.db.insert("productProfiles", {
        tenantId,
        productId,
        profile: fixtureProfile(product),
        provenance: {},
        completeness: 0.8,
        cacheKey: product.id,
        schemaVersion: "profile_v1",
        lastEnrichedAt: Date.now(),
      });
    });
  }

  return tenantId;
}

/**
 * Rebuild the Outfit shape the evaluator expects from the action's wire
 * response. The action returns a shopper-facing payload; the evaluator
 * needs prices, availability and profiles to check constraints against.
 */
function toOutfits(
  response: { outfits: Array<{ slots: Record<string, string>; products: Array<{ id: string }> }> },
): Outfit[] {
  return response.outfits.map((outfit) => {
    const pieces: Candidate[] = outfit.products.map((product) => {
      const fixture = FIXTURE_CATALOG.find((f) => f.id === product.id);
      return {
        productId: product.id,
        title: fixture?.title ?? product.id,
        price: fixture?.price ?? 0,
        currency: "USD",
        available: fixture?.available ?? true,
        profile: fixture ? fixtureProfile(fixture) : ({} as never),
        slot: null,
        relevance: 0,
      };
    });
    return {
      slots: outfit.slots as never,
      pieces,
      direction: "",
      scores: { compatibility: 0, brand: 0, shopperFit: 0, relevance: 0, final: 0 },
      detail: {
        total: 0, pairwise: 0, worstPair: 0, palette: 0, cohesion: 0,
        issues: [], notes: [],
      },
      issues: [],
      confidence: 0,
    };
  });
}

test(
  "benchmark: the decision engine against a fixed catalog",
  { timeout: 180_000 },
  async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedFixtureShop(t);

    const cases = expandedCases();
    const results: CaseResult[] = [];

    for (const testCase of cases) {
      const sessionKey = `eval-${testCase.id}`;
      const started = Date.now();

      // Refinement cases need prior state, and establishing it through
      // the real action is the point — a mocked session would not
      // exercise the transform §128 asks about.
      if (testCase.priorQuery) {
        await t.action(publicApi().outfits.buildLook, {
          publicKey: "disc_fixture",
          query: testCase.priorQuery,
          sessionKey,
        });
      }

      const response = await t.action(publicApi().outfits.buildLook, {
        publicKey: "disc_fixture",
        query: testCase.query,
        anchorProductId: testCase.anchorProductId,
        sessionKey: testCase.priorQuery ? sessionKey : undefined,
      });

      const latencyMs = Date.now() - started;

      // The intent that actually ran, for conversation-state checks.
      // Read the session the action actually wrote. An earlier version
      // keyed this on `response.tenantId`, which the wire response does
      // not carry — so it matched nothing and every refinement case
      // silently compared against an empty intent instead.
      const session = testCase.priorQuery
        ? await t.run(async (ctx) => {
            return await ctx.db
              .query("shopperSessions")
              .withIndex("by_tenant_and_key", (q) =>
                q.eq("tenantId", tenantId).eq("sessionKey", sessionKey),
              )
              .first();
          })
        : null;

      results.push(
        evaluateCase(
          testCase,
          toOutfits(response),
          (session?.state as never) ?? emptyIntent(testCase.query),
          latencyMs,
        ),
      );
    }

    const summary = summarise(results);
    console.log("\n" + formatSummary(summary, results) + "\n");

    // §98 asks for 100-300 cases.
    expect(summary.total).toBeGreaterThanOrEqual(30);

    // The regression gate. A drop below the floor fails the build.
    expect(
      summary.passRate,
      `pass rate ${(summary.passRate * 100).toFixed(1)}% is below the ${PASS_RATE_FLOOR * 100}% floor.\n` +
        formatSummary(summary, results),
    ).toBeGreaterThanOrEqual(PASS_RATE_FLOOR);

    // Two failures are never acceptable at any pass rate, because both
    // are promises to a shopper rather than quality judgements:
    // recommending something unbuyable, and inventing an answer when
    // there isn't one.
    expect(summary.byError.availability_error ?? 0).toBe(0);
    expect(summary.byError.hallucinated_fact ?? 0).toBe(0);
  },
);
