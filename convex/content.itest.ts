import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DeterministicEmbeddings } from "./lib/embeddings";
import { emptyProfile, type FashionProfile } from "./lib/fashion-profile";

/**
 * The content intelligence foundation (P2.3), against the real runtime.
 *
 * One invariant matters more than everything else here:
 *
 *   PRESENCE       product X appears in this content
 *   COMPATIBILITY  product X and product Y were styled together
 *
 * A still-image look asserts both, because everything in a styled
 * photograph was put there by one decision. Nothing else does. A
 * lookbook video showing a shirt at minute 2 and trousers at minute 16
 * asserts presence twice and compatibility not at all, and the failure
 * mode this file exists to catch is the day that distinction quietly
 * stops holding — because the outfit graph is merchant-APPROVED
 * evidence, so a pair that leaks into it carries the authority of a
 * human decision nobody made.
 */

const modules = import.meta.glob("./**/*.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicApi = () => api as any;

async function seedTenant(t: ReturnType<typeof convexTest>, slug: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      source: "shopify_oauth" as const,
      catalogStatus: "ready" as const,
      brandBrainStatus: "ready" as const,
      widgetStatus: "live" as const,
      subscriptionStatus: "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  id: string,
  profile: Partial<FashionProfile> = {},
  opts: { text?: string; productType?: string; available?: boolean } = {},
): Promise<Id<"products">> {
  const text = opts.text ?? id;
  const provider = new DeterministicEmbeddings();
  const [embedding] = await provider.embed([text]);

  return await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: id,
      title: id,
      description: text,
      handle: id,
      productType: opts.productType ?? "Apparel",
      tags: [],
      price: 100,
      currency: "GBP",
      imageUrl: "https://cdn/a.jpg",
      images: ["https://cdn/a.jpg"],
      colour: "",
      variants: [
        { id: `${id}-v1`, title: "M", price: 100, available: opts.available !== false },
      ],
      anyVariantAvailable: opts.available !== false,
      ingestedAt: Date.now(),
    });
    await ctx.db.insert("productEmbeddings", {
      tenantId,
      productId,
      embedding,
      embeddingModel: provider.name,
      contentHash: id,
      createdAt: Date.now(),
    });
    await ctx.db.insert("productProfiles", {
      tenantId,
      productId,
      profile: { ...emptyProfile(), ...profile },
      provenance: {},
      completeness: 0.8,
      cacheKey: id,
      schemaVersion: "profile_v1",
      lastEnrichedAt: Date.now(),
    });
    return productId;
  });
}

/** Every compatibility edge a tenant holds. */
async function edgesOf(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("lookEdges").collect()).filter((e) => e.tenantId === tenantId),
  );
}

type PresenceRow = {
  productId: Id<"products">;
  state: string;
  scope: { kind: string };
  detectedLabel: string | null;
  confidence: number | null;
  detectedBy: string;
};

/**
 * `presenceFor` is an internalQuery without a `returns` validator, so its
 * type does not survive `t.query`. Annotated here rather than adding a
 * validator purely for the tests' benefit.
 */
async function presenceRows(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  contentId: Id<"looks">,
): Promise<PresenceRow[]> {
  return await t.query(internal.content.presenceFor, { tenantId, contentId });
}

/** Every presence row a tenant holds. */
async function presenceOf(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("contentProducts").collect()).filter(
      (r) => r.tenantId === tenantId,
    ),
  );
}

/** Save content in one step. `role` is what decides its meaning. */
async function saveContent(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  opts: {
    title: string;
    productIds: Id<"products">[];
    role?: string;
    mediaKind?: string;
    origin?: string;
    approve?: boolean;
  },
) {
  const saved = await t.mutation(internal.looks.saveLook, {
    tenantId,
    title: opts.title,
    source: "merchant_built",
    role: opts.role,
    mediaKind: opts.mediaKind,
    origin: opts.origin,
    items: opts.productIds.map((productId) => ({ productId })),
  });
  if ("error" in saved) throw new Error(saved.error);
  if (opts.approve !== false) {
    await t.mutation(internal.looks.setLookStatus, {
      tenantId,
      lookId: saved.lookId,
      status: "approved",
    });
  }
  return saved.lookId;
}

// =====================================================================

describe("presence and compatibility are different claims", () => {
  test("an approved LOOK still produces compatibility edges", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-look");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // Unchanged behaviour: this is what the Look Builder has always done
    // and P2.3 must not have altered it.
    await saveContent(t, tenantId, {
      title: "Dinner look",
      productIds: [shirt, trouser],
    });

    const edges = await edgesOf(t, tenantId);
    expect(edges.length).toBe(1);
    expect([edges[0].productA, edges[0].productB].sort()).toEqual(
      [shirt, trouser].sort(),
    );
  });

  test("APPROVED CONTENT THAT IS NOT A LOOK CREATES NO EDGES", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-campaign");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // THE INVARIANT. Every other role asserts only that these products
    // appear in the content. Approving a lookbook is a merchant saying
    // "yes, these products are in this" — not "these go together".
    for (const role of ["campaign", "lookbook", "editorial", "social_post"]) {
      await saveContent(t, tenantId, {
        title: `${role} piece`,
        productIds: [shirt, trouser],
        role,
      });
    }

    expect(await edgesOf(t, tenantId)).toEqual([]);

    // And the presence claim was still recorded — the products ARE in
    // that content. Refusing the edge is not refusing the knowledge.
    const presence = await presenceOf(t, tenantId);
    expect(presence.length).toBe(8); // four items x two products
    expect(presence.every((r) => r.state === "confirmed")).toBe(true);
  });

  test("a video role cannot smuggle co-presence into the outfit graph", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-video");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // The concrete case from the product direction: a shirt at minute 2
    // and trousers at minute 16 of a lookbook film. Nobody styled those
    // two together, and the graph must not learn that they did.
    const contentId = await saveContent(t, tenantId, {
      title: "Autumn film",
      productIds: [shirt, trouser],
      role: "lookbook",
      mediaKind: "video",
    });

    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: shirt,
      state: "confirmed",
      scope: { kind: "interval", startMs: 120_000, endMs: 128_000 },
    });
    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: trouser,
      state: "confirmed",
      scope: { kind: "interval", startMs: 960_000, endMs: 968_000 },
    });

    expect(await edgesOf(t, tenantId)).toEqual([]);

    // The scopes survived, so a future rule CAN tell these apart from
    // two products in one frame. That is the whole reason scope exists.
    const rows = await presenceRows(t, tenantId, contentId);
    const scopes = rows.map((r) => r.scope.kind).sort();
    expect(scopes).toEqual(["interval", "interval"]);
  });

  test("presence and compatibility are stored and queried separately", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-sep");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const lookId = await saveContent(t, tenantId, {
      title: "A look",
      productIds: [shirt, trouser],
    });

    // Both relations exist for a look, in different tables, answering
    // different questions.
    expect((await edgesOf(t, tenantId)).length).toBe(1);
    expect((await presenceOf(t, tenantId)).length).toBe(2);

    // Removing the compatibility claim leaves the presence claim intact:
    // un-approving a look means "these were not styled together", not
    // "these products were never in this photograph".
    await t.mutation(internal.looks.setLookStatus, {
      tenantId,
      lookId,
      status: "draft",
    });

    expect(await edgesOf(t, tenantId)).toEqual([]);
    expect((await presenceOf(t, tenantId)).length).toBe(2);
  });
});

describe("detected, confirmed and rejected", () => {
  test("a detection is not a confirmation", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-detect");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const other = await seedProduct(t, tenantId, "other");

    const contentId = await saveContent(t, tenantId, {
      title: "Campaign",
      productIds: [shirt],
      role: "campaign",
    });

    await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId,
      detections: [{ productId: other, detectedLabel: "a white shirt", confidence: 0.7 }],
    });

    const rows = await presenceRows(t, tenantId, contentId);
    const detected = rows.find((r) => r.productId === other);
    const confirmed = rows.find((r) => r.productId === shirt);

    expect(detected!.state).toBe("detected");
    expect(confirmed!.state).toBe("confirmed");

    // A model's proposal is never authoritative knowledge, so the read
    // a future ranker would use returns only what a human confirmed.
    const authoritative = await t.query(internal.content.contentForProduct, {
      tenantId,
      productId: other,
    });
    expect(authoritative).toEqual([]);
  });

  test("provenance survives confirmation rather than being erased by it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-prov");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const contentId = await saveContent(t, tenantId, {
      title: "Campaign",
      productIds: [shirt],
      role: "campaign",
    });
    await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId,
      detections: [
        { productId: trouser, detectedLabel: "navy wool trousers", confidence: 0.62 },
      ],
    });
    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: trouser,
      state: "confirmed",
    });

    const row = (await presenceRows(t, tenantId, contentId)).find(
      (r) => r.productId === trouser,
    )!;

    expect(row.state).toBe("confirmed");
    // "Did a human approve this, and what did the model originally
    // think?" has to stay answerable a week later.
    expect(row.detectedLabel).toBe("navy wool trousers");
    expect(row.confidence).toBeCloseTo(0.62);
    expect(row.detectedBy).toBe("model");
  });

  test("confirming through the look path does not erase provenance", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-prov2");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);

    // A later analysis proposes a third product, with provenance.
    const extra = await seedProduct(t, tenantId, "extra");
    await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId: saved.lookId,
      detections: [
        { productId: extra, detectedLabel: "brown leather belt", confidence: 0.55 },
      ],
    });

    // The merchant accepts it by re-saving the look — a path that does
    // NOT resend the model's label. Convex deletes a field patched to
    // `undefined`, so a naive rewrite here erases the provenance.
    await t.mutation(internal.looks.saveLook, {
      tenantId,
      lookId: saved.lookId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: trouser }, { productId: extra }],
    });

    const row = (await presenceRows(t, tenantId, saved.lookId)).find(
      (r) => r.productId === extra,
    )!;
    expect(row.state).toBe("confirmed");
    expect(row.detectedLabel).toBe("brown leather belt");
    expect(row.confidence).toBeCloseTo(0.55);
    expect(row.detectedBy).toBe("model");
  });

  test("A REJECTION IS NOT RESURRECTED BY RE-ANALYSIS", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-reject");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const wrong = await seedProduct(t, tenantId, "wrong");

    const contentId = await saveContent(t, tenantId, {
      title: "Campaign",
      productIds: [shirt],
      role: "campaign",
    });

    await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId,
      detections: [{ productId: wrong, detectedLabel: "white shirt", confidence: 0.8 }],
    });
    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: wrong,
      state: "rejected",
    });

    // The content is analysed again — a new model, a better prompt, a
    // re-upload — and proposes the same wrong product with MORE
    // confidence. A merchant who has already said no should not have to
    // keep saying it.
    const result = await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId,
      detections: [{ productId: wrong, detectedLabel: "white shirt", confidence: 0.99 }],
    });

    expect(result.preserved).toBe(1);
    expect(result.proposed).toBe(0);

    const row = (await presenceRows(t, tenantId, contentId)).find(
      (r) => r.productId === wrong,
    )!;
    expect(row.state).toBe("rejected");
    expect(row.confidence).toBeCloseTo(0.8);
  });

  test("a confirmation is not downgraded by re-analysis either", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-confirm");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const contentId = await saveContent(t, tenantId, {
      title: "Campaign",
      productIds: [shirt],
      role: "campaign",
    });
    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: trouser,
      state: "confirmed",
    });

    const result = await t.mutation(internal.content.recordDetections, {
      tenantId,
      contentId,
      detections: [{ productId: trouser, detectedLabel: "maybe", confidence: 0.2 }],
    });
    expect(result.preserved).toBe(1);

    const row = (await presenceRows(t, tenantId, contentId)).find(
      (r) => r.productId === trouser,
    )!;
    expect(row.state).toBe("confirmed");
  });

  test("a scope that cannot be read falls back to the whole item", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-scope");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const contentId = await saveContent(t, tenantId, {
      title: "Campaign",
      productIds: [shirt],
      role: "campaign",
    });

    // An interval that ends before it starts is not a narrower claim
    // than "the whole item" — it is an unreadable one, and downstream
    // code would treat an unreadable bound as real.
    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId,
      productId: trouser,
      state: "confirmed",
      scope: { kind: "interval", startMs: 900, endMs: 100 },
    });

    const row = (await presenceRows(t, tenantId, contentId)).find(
      (r) => r.productId === trouser,
    )!;
    expect(row.scope.kind).toBe("whole");
  });
});

describe("tenancy and lifecycle", () => {
  test("one tenant's content presence never reaches another", async () => {
    const t = convexTest(schema, modules);
    const a = await seedTenant(t, "brand-iso-a");
    const b = await seedTenant(t, "brand-iso-b");
    const aShirt = await seedProduct(t, a, "a-shirt");
    const aTrouser = await seedProduct(t, a, "a-trouser");
    const bShirt = await seedProduct(t, b, "b-shirt");

    const contentId = await saveContent(t, a, {
      title: "A's campaign",
      productIds: [aShirt, aTrouser],
      role: "campaign",
    });

    // B cannot read A's content.
    expect(await presenceRows(t, b, contentId)).toEqual([]);

    // B cannot write into A's content.
    expect(
      await t.mutation(internal.content.setPresenceState, {
        tenantId: b,
        contentId,
        productId: bShirt,
        state: "confirmed",
      }),
    ).toBe(false);

    // And A cannot pull B's product into A's content — the claim would
    // be about a product that is not in A's catalog at all.
    expect(
      await t.mutation(internal.content.setPresenceState, {
        tenantId: a,
        contentId,
        productId: bShirt,
        state: "confirmed",
      }),
    ).toBe(false);

    const detections = await t.mutation(internal.content.recordDetections, {
      tenantId: a,
      contentId,
      detections: [{ productId: bShirt, detectedLabel: "not ours" }],
    });
    expect(detections.proposed).toBe(0);

    expect(await presenceOf(t, b)).toEqual([]);
  });

  test("deleting content removes its presence and its edges", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-del");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const lookId = await saveContent(t, tenantId, {
      title: "A look",
      productIds: [shirt, trouser],
    });
    expect((await presenceOf(t, tenantId)).length).toBe(2);
    expect((await edgesOf(t, tenantId)).length).toBe(1);

    await t.mutation(internal.looks.deleteLook, { tenantId, lookId });

    // Neither relation may outlive the content it describes.
    expect(await presenceOf(t, tenantId)).toEqual([]);
    expect(await edgesOf(t, tenantId)).toEqual([]);
  });

  test("re-mapping content rebuilds presence rather than accumulating it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-remap");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");
    const jeans = await seedProduct(t, tenantId, "jeans");

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);

    await t.mutation(internal.looks.saveLook, {
      tenantId,
      lookId: saved.lookId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: jeans }],
    });

    const rows = await presenceOf(t, tenantId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.productId).sort()).toEqual([shirt, jeans].sort());
  });

  test("a merchant's rejection survives a re-map", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-remap-reject");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");
    const wrong = await seedProduct(t, tenantId, "wrong");

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);

    await t.mutation(internal.content.setPresenceState, {
      tenantId,
      contentId: saved.lookId,
      productId: wrong,
      state: "rejected",
    });

    await t.mutation(internal.looks.saveLook, {
      tenantId,
      lookId: saved.lookId,
      title: "A look",
      source: "merchant_built",
      items: [{ productId: shirt }, { productId: trouser }],
    });

    const rejected = (await presenceOf(t, tenantId)).find(
      (r) => r.productId === wrong,
    );
    expect(rejected?.state).toBe("rejected");
  });

  test("purging a tenant removes content presence and stored media", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-purge");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["campaign-bytes"], { type: "image/jpeg" })),
    );

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "Campaign",
      source: "uploaded",
      role: "campaign",
      imageStorageId: storageId,
      items: [{ productId: shirt }, { productId: trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);

    expect((await presenceOf(t, tenantId)).length).toBe(2);

    await t.mutation(internal.tenants.purgeTenant, { tenantId });

    expect(await presenceOf(t, tenantId)).toEqual([]);

    // FILE STORAGE IS NOT A TABLE, so the schema-reading guard in
    // `privacy.itest.ts` cannot see it. Generalising the content model
    // did not change that, and a campaign photograph outliving a
    // redacted shop would break the promise `shop/redact` makes.
    const files = await t.run(async (ctx) =>
      ctx.db.system.query("_storage").collect(),
    );
    expect(files).toEqual([]);
  });
});

describe("ranking is unaffected by presence", () => {
  test("content presence contributes nothing to the affinity graph", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-rank");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // A pile of approved, confirmed, non-look content naming the same
    // two products over and over.
    for (let i = 0; i < 12; i++) {
      await saveContent(t, tenantId, {
        title: `Campaign ${i}`,
        productIds: [shirt, trouser],
        role: "campaign",
      });
    }

    // Ranking reads the graph through exactly one query, and that query
    // has nothing to report — presence is not evidence of styling.
    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges).toEqual([]);
    expect(graph.lookCount).toBe(12);

    // Meanwhile the presence rows are all there. The knowledge exists;
    // it simply does not reach compatibility.
    expect((await presenceOf(t, tenantId)).length).toBe(24);
  });

  test("a cold-start tenant gets an empty graph", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-cold");
    await seedProduct(t, tenantId, "shirt");

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges).toEqual([]);
    expect(graph.lookCount).toBe(0);
  });
});

describe("evidence never outranks an explicit constraint", () => {
  test("a sold-out product stays out however much content vouches for it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-constraint");

    const text = "crisp white cotton oxford shirt";
    // The available shirt the outfit should choose instead.
    await seedProduct(
      t,
      tenantId,
      "shirt",
      { garment: "shirt", colorFamily: "white", formality: 3, styleVector: { classic: 0.9 } },
      { text },
    );
    const trouser = await seedProduct(
      t,
      tenantId,
      "trouser",
      { garment: "trouser", colorFamily: "navy", formality: 3, styleVector: { classic: 0.9 } },
      { text: "tailored navy wool trouser" },
    );
    const loafer = await seedProduct(
      t,
      tenantId,
      "loafer",
      { garment: "loafer", colorFamily: "brown", formality: 3, styleVector: { classic: 0.9 } },
      { text: "polished brown leather loafer" },
    );
    // THE SOLD-OUT PRODUCT COMPETES FOR A SLOT THE OUTFIT ACTUALLY USES.
    // An unbuyable jacket proves nothing when the outfit never wanted
    // outerwear — the first version of this test passed for exactly that
    // reason, and kept passing with the availability constraint removed.
    // So this is a second shirt: same slot as the one above, a better
    // text match for the query, and heavily vouched for.
    const soldOut = await seedProduct(
      t,
      tenantId,
      "gone",
      { garment: "shirt", colorFamily: "white", formality: 3, styleVector: { classic: 0.95 } },
      { text, available: false },
    );

    // Pile every kind of evidence Disc has onto the sold-out product:
    // approved looks pairing it with the rest of the outfit
    // (compatibility), and a stack of confirmed campaign presence.
    for (const partner of [trouser, loafer]) {
      await saveContent(t, tenantId, {
        title: `Hero ${partner}`,
        productIds: [soldOut, partner],
      });
    }
    for (let i = 0; i < 10; i++) {
      await saveContent(t, tenantId, {
        title: `Campaign ${i}`,
        productIds: [soldOut, trouser],
        role: "campaign",
      });
    }

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges.length).toBeGreaterThan(0); // the evidence really is there

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_brand-constraint",
      query: text,
    });

    const ids = result.outfits.flatMap((o: { products: Array<{ id: string }> }) =>
      o.products.map((p) => p.id),
    );

    // Availability is a hard constraint applied BEFORE ranking, so no
    // amount of merchant evidence can put an unbuyable product in front
    // of a shopper. Content tilts a ranking; it never overrules what the
    // shopper can actually purchase.
    expect(ids).not.toContain("gone");
    // And the outfit is still built — the constraint removed a
    // candidate, it did not empty the result.
    expect(ids).toContain("shirt");
  });
});

describe("content that is not a look", () => {
  test("a single-product campaign is valid; a single-product look is not", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-single");
    const shirt = await seedProduct(t, tenantId, "shirt");

    // A styled combination of one piece is not a combination. That floor
    // is what makes a look's items a compatibility claim.
    const asLook = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "One piece",
      source: "merchant_built",
      items: [{ productId: shirt }],
    });
    expect("error" in asLook).toBe(true);

    // A campaign photograph of one product is a perfectly good statement
    // about that product, and outfit semantics must not be applied to
    // something that never claimed to be an outfit.
    const asCampaign = await t.mutation(internal.looks.saveLook, {
      tenantId,
      title: "One piece",
      source: "merchant_built",
      role: "campaign",
      items: [{ productId: shirt }],
    });
    expect("error" in asCampaign).toBe(false);

    expect(await edgesOf(t, tenantId)).toEqual([]);
    expect((await presenceOf(t, tenantId)).length).toBe(1);
  });

  test("an unreadable role degrades to a look, not to unbounded content", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-badrole");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // The safe direction. An unrecognised role must not widen what the
    // content is allowed to assert — it must fall back to the one
    // meaning the system has always had, which the merchant already
    // approves explicitly.
    await saveContent(t, tenantId, {
      title: "Mystery",
      productIds: [shirt, trouser],
      role: "not_a_real_role",
    });

    const stored = await t.run(async (ctx) =>
      (await ctx.db.query("looks").collect()).find((l) => l.tenantId === tenantId),
    );
    expect(stored!.role).toBe("look");
  });

  test("rows written before P2.3 still behave as looks", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-legacy");
    const shirt = await seedProduct(t, tenantId, "shirt");
    const trouser = await seedProduct(t, tenantId, "trouser");

    // A look with no `role`, `mediaKind` or `origin` — exactly the shape
    // every row had before this phase. It must keep producing edges.
    const lookId = await t.run(async (ctx) =>
      ctx.db.insert("looks", {
        tenantId,
        title: "Legacy look",
        source: "uploaded" as const,
        items: [
          { productId: shirt, slot: "top" },
          { productId: trouser, slot: "bottom" },
        ],
        status: "draft" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(internal.looks.setLookStatus, {
      tenantId,
      lookId,
      status: "approved",
    });

    expect((await edgesOf(t, tenantId)).length).toBe(1);
  });
});
