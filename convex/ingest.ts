import { usageSink } from "./usage";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { adminGraphQL, PRODUCTS_PAGE_QUERY } from "./shopify/admin";
import { decryptSecret } from "./lib/crypto";
import { ENCRYPTION_KEY, env } from "./lib/env";
import { getEmbeddingProvider } from "./lib/embeddings";
import {
  CanonicalProduct,
  contentHash,
  embeddingText,
  fromGraphQL,
} from "./lib/products";

/**
 * Catalog ingestion as a background job.
 *
 * Spec §29 is explicit that enrichment must not run synchronously during
 * installation, and §87 wants this as a real job. In the prototype it
 * was a FastAPI `BackgroundTasks` callback, which meant an in-flight
 * sync died silently with the process and nothing retried it.
 *
 * Runs in batches so a large catalog cannot blow the action time limit,
 * and so a failure part-way through leaves the tenant with a partial but
 * coherent index rather than an empty one — the prototype used
 * `mode="overwrite"` on the whole table, so a mid-sync crash left the
 * merchant with no catalog at all.
 */

const PAGE_LIMIT = 40; // 50 products per page → 2,000 per run

export const syncCatalog = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.runQuery(internal.tenants.getById, { tenantId });
    if (!tenant) return null;
    if (!tenant.accessTokenCipher) {
      await ctx.runMutation(internal.tenants.setCatalogStatus, {
        tenantId,
        catalogStatus: "error",
        error: "No Shopify credentials for this tenant",
      });
      return null;
    }

    await ctx.runMutation(internal.tenants.setCatalogStatus, {
      tenantId,
      catalogStatus: "syncing",
    });

    try {
      const accessToken = await decryptSecret(tenant.accessTokenCipher, ENCRYPTION_KEY());
      const provider = getEmbeddingProvider(
        env("OPENAI_API_KEY"),
        usageSink(ctx, tenantId, "embedding"),
      );

      let cursor: string | null = null;
      let pages = 0;
      const seenIds: string[] = [];

      do {
        const result: any = await adminGraphQL(
          tenant.shopDomain,
          accessToken,
          PRODUCTS_PAGE_QUERY,
          { cursor },
        );

        const shopCurrency = result.data?.shop?.currencyCode ?? "USD";
        const edges = result.data?.products?.edges ?? [];

        const batch: CanonicalProduct[] = [];
        for (const edge of edges) {
          const canonical = fromGraphQL(edge.node, shopCurrency);
          if (canonical) {
            batch.push(canonical);
            seenIds.push(canonical.shopifyProductId);
          }
        }

        if (batch.length > 0) {
          // Only products whose embedding text changed come back, so a
          // resync of an unchanged catalog costs nothing in embeddings.
          const changedIds: Id<"products">[] = await ctx.runMutation(
            internal.products.upsertBatch,
            { tenantId, products: batch },
          );
          if (changedIds.length > 0) {
            await embedProducts(ctx, tenantId, changedIds, provider);
          }
        }

        cursor = result.data?.products?.pageInfo?.hasNextPage
          ? result.data.products.pageInfo.endCursor
          : null;
        pages++;
      } while (cursor && pages < PAGE_LIMIT);

      // Reconciliation (spec §89): anything no longer in the source
      // catalog is removed. Only safe because we paged the whole catalog
      // — if PAGE_LIMIT truncated it, skip the sweep rather than delete
      // products that were simply never reached.
      if (!cursor) {
        await ctx.runMutation(internal.products.deleteMissing, {
          tenantId,
          seenShopifyIds: seenIds,
        });
      }

      const count: number = await ctx.runQuery(internal.products.countForTenant, {
        tenantId,
      });
      await ctx.runMutation(internal.tenants.setCatalogStatus, {
        tenantId,
        catalogStatus: "ready",
        productCount: count,
      });

      // Enrichment is scheduled, never awaited. Spec §29 is explicit that
      // the full enrichment job must not run synchronously during
      // installation — the merchant should see "catalog ready" in
      // seconds, with product intelligence filling in behind it.
      await ctx.scheduler.runAfter(0, internal.crons.drainEnrichment, { tenantId });
    } catch (err) {
      await ctx.runMutation(internal.tenants.setCatalogStatus, {
        tenantId,
        catalogStatus: "error",
        error: (err as Error).message.slice(0, 300),
      });
    }
    return null;
  },
});

/**
 * Embed a set of products.
 *
 * Chunked because embedding APIs cap inputs per request, and because a
 * single failure should cost one chunk rather than the whole catalog.
 */
async function embedProducts(
  ctx: any,
  tenantId: Id<"tenants">,
  productIds: Id<"products">[],
  provider: ReturnType<typeof getEmbeddingProvider>,
): Promise<void> {
  const CHUNK = 96;
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const slice = productIds.slice(i, i + CHUNK);
    const docs = await ctx.runQuery(internal.products.listForEmbedding, {
      productIds: slice,
    });
    if (docs.length === 0) continue;

    const texts = docs.map((d: any) =>
      embeddingText({
        title: d.title,
        description: d.description,
        tags: d.tags,
      } as CanonicalProduct),
    );
    const vectors = await provider.embed(texts);

    await ctx.runMutation(internal.products.saveEmbeddings, {
      tenantId,
      model: provider.name,
      entries: docs.map((d: any, idx: number) => ({
        productId: d._id,
        embedding: vectors[idx],
        contentHash: contentHash(texts[idx], provider.name),
      })),
    });
  }
}

/** Re-ingest one product, for products/create and products/update webhooks. */
export const syncSingleProduct = internalAction({
  args: { tenantId: v.id("tenants"), shopifyProductId: v.string() },
  returns: v.null(),
  handler: async (ctx, { tenantId, shopifyProductId }) => {
    const tenant = await ctx.runQuery(internal.tenants.getById, { tenantId });
    if (!tenant?.accessTokenCipher) return null;

    try {
      const accessToken = await decryptSecret(tenant.accessTokenCipher, ENCRYPTION_KEY());
      const result: any = await adminGraphQL(
        tenant.shopDomain,
        accessToken,
        (await import("./shopify/admin")).SINGLE_PRODUCT_QUERY,
        { id: `gid://shopify/Product/${shopifyProductId}` },
      );

      const node = result.data?.product;
      if (!node) {
        await ctx.runMutation(internal.products.deleteByShopifyId, {
          tenantId,
          shopifyProductId,
        });
        return null;
      }

      const canonical = fromGraphQL(node, result.data?.shop?.currencyCode ?? "USD");
      if (!canonical) return null;

      const changed: Id<"products">[] = await ctx.runMutation(
        internal.products.upsertBatch,
        { tenantId, products: [canonical] },
      );
      if (changed.length > 0) {
        const provider = getEmbeddingProvider(
          env("OPENAI_API_KEY"),
          usageSink(ctx, tenantId, "embedding"),
        );
        await embedProducts(ctx, tenantId, changed, provider);
      }
    } catch {
      // A single failed product must not mark the whole catalog broken;
      // the periodic resync will pick it up.
    }
    return null;
  },
});
