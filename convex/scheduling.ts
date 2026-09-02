import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  DEFAULT_MAX_ATTEMPTS,
  idempotencyKey,
  isJobType,
  type JobType,
} from "./lib/jobs";

/**
 * Idempotent scheduling (P1.2).
 *
 * The seam between "this logical work should happen" and "an execution
 * of it is scheduled". Everything durable goes through `enqueue`, and
 * `enqueue` is the only place in the codebase that schedules durable
 * business work.
 *
 * THE ONE STRUCTURAL DECISION: the dedupe and the scheduling happen in
 * the SAME MUTATION.
 *
 *   createJob (mutation, commits)
 *      ... caller dies here ...
 *   scheduler.runAfter (never happens)
 *
 * would leave a `queued` job that nothing will ever run — a row that
 * looks like pending work and is actually an orphan, and which the next
 * enqueue would then deduplicate against. Convex schedules from inside
 * a mutation transactionally: if the mutation commits, the function is
 * scheduled; if it aborts, neither the row nor the schedule exists.
 * Doing both here is what makes "created implies scheduled" true rather
 * than probable.
 *
 * It is also what satisfies "the dedupe decision must occur BEFORE
 * scheduling" in the strongest available sense: not merely earlier in
 * program order, but in the same transaction, so there is no window in
 * which a second caller can observe the gap.
 *
 * This module deliberately does NOT decide when to retry, how long to
 * back off, or what to do about a stuck job. It schedules first
 * attempts. Retry is P1.3.
 */

/** Result of an enqueue. `created` is the signal a caller acts on. */
type EnqueueResult = {
  jobId: Id<"jobs">;
  created: boolean;
  status: Doc<"jobs">["status"];
};

/**
 * How long two catalog syncs are considered the same piece of work.
 *
 * A full catalog sync has no natural version to key on — the "logical
 * input" is just the tenant, and the same tenant is legitimately synced
 * again six hours later. So the key carries a coarse time bucket, and
 * this is its width.
 *
 * Five minutes collapses a merchant clicking Resync four times (which
 * the rate limit permits) into one job, and leaves the six-hourly cron
 * unaffected. The cost is that a genuinely-wanted resync inside the
 * window is suppressed; that is acceptable because the work is
 * idempotent in effect — the catalog is re-read from the same source and
 * lands in the same place — so suppressing it loses nothing but a
 * duplicate read.
 *
 * The boundary is a heuristic: two triggers a second apart can straddle
 * a bucket edge and produce two jobs. The guarantee that matters —
 * no *concurrent* duplicate — does not rest on this, it rests on the
 * claim in P1.1.
 */
const CATALOG_SYNC_DEDUPE_MS = 5 * 60 * 1000;

/**
 * Keys for the operations migrated in this phase.
 *
 * Key construction is where the "same logical work" judgement lives, so
 * it is centralised rather than left to call sites. Each key answers one
 * question: what makes two invocations the same?
 */
export function catalogSyncKey(tenantId: Id<"tenants">, at: number = Date.now()): string {
  // Same tenant, same five-minute window. See CATALOG_SYNC_DEDUPE_MS.
  return idempotencyKey("catalog_sync", [
    tenantId,
    Math.floor(at / CATALOG_SYNC_DEDUPE_MS),
  ]);
}

/**
 * One product's re-ingestion.
 *
 * Keyed on the tenant, the product, and a caller-supplied discriminator
 * — today the Shopify `updated_at`, which changes when and only when the
 * product does. Two deliveries of one webhook carry the same value and
 * collapse to one job; a later genuine edit carries a new one and gets
 * its own.
 *
 * P1.4 will replace the discriminator with the Shopify event id, which
 * is a stronger answer to the same question: it makes two deliveries of
 * one event identical even if the product changed again in between.
 */
export function productSyncKey(
  tenantId: Id<"tenants">,
  shopifyProductId: string,
  discriminator: string,
): string {
  return idempotencyKey("product_embedding", [
    tenantId,
    shopifyProductId,
    discriminator,
  ]);
}

/**
 * Create-or-get, then schedule if and only if this call created it.
 *
 * Returns `created: false` for work that already exists in ANY state:
 *
 *   queued / running / retrying  — an execution is already accounted for
 *   succeeded / failed / cancelled — this logical work is over
 *
 * Neither schedules. The first because something else owns it; the
 * second because re-running finished work must be an explicit new job
 * with a new key, never a side effect of asking for the old one.
 *
 * That last case is what makes a redelivered webhook a no-op rather than
 * a re-embed.
 */
export const enqueue = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    type: v.string(),
    idempotencyKey: v.string(),
    /** Worker arguments. Passed to the scheduler, never stored on the row. */
    shopifyProductId: v.optional(v.string()),
    delayMs: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EnqueueResult> => {
    if (!isJobType(args.type)) throw new Error(`Unknown job type: ${args.type}`);

    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error("Unknown tenant");

    // Read-then-insert in this transaction. Two concurrent enqueues with
    // the same key both read this index; Convex's serializable isolation
    // means the second is evaluated against the first's write and finds
    // the row. Exactly one gets `created: true`, so exactly one
    // schedules — which is the invariant this phase exists to establish.
    const existing = await ctx.db
      .query("jobs")
      .withIndex("by_tenant_and_idempotency", (q) =>
        q.eq("tenantId", args.tenantId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();

    if (existing) {
      return { jobId: existing._id, created: false, status: existing.status };
    }

    const now = Date.now();
    const delay = Math.max(0, args.delayMs ?? 0);
    const jobId = await ctx.db.insert("jobs", {
      tenantId: args.tenantId,
      type: args.type,
      status: "queued",
      idempotencyKey: args.idempotencyKey,
      attempt: 0,
      maxAttempts: args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      scheduledAt: now + delay,
      createdAt: now,
      updatedAt: now,
    });

    await scheduleWorker(ctx, args.type, delay, {
      tenantId: args.tenantId,
      jobId,
      shopifyProductId: args.shopifyProductId,
    });

    return { jobId, created: true, status: "queued" };
  },
});

/**
 * Dispatch a job type to the action that performs it.
 *
 * Explicit branches rather than a lookup table: the argument shapes
 * differ per worker, and a table would need a cast that hides exactly
 * the mistake that matters — scheduling a worker with the wrong
 * arguments. The closed `JOB_TYPES` set keeps this bounded, and a new
 * type that reaches here without a branch throws rather than silently
 * creating a job nothing will run.
 *
 * `jobId` is threaded through so a worker can claim its own job. Workers
 * do not claim yet — that is P1.3, and until then the id is carried but
 * unused, which is deliberate: adding it later would mean changing every
 * scheduled signature at the point of highest risk.
 */
async function scheduleWorker(
  ctx: { scheduler: { runAfter: (ms: number, fn: never, args: never) => Promise<unknown> } },
  type: JobType,
  delayMs: number,
  args: { tenantId: Id<"tenants">; jobId: Id<"jobs">; shopifyProductId?: string },
): Promise<void> {
  const scheduler = ctx.scheduler as unknown as {
    runAfter: (
      ms: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fnArgs: any,
    ) => Promise<unknown>;
  };

  switch (type) {
    case "catalog_sync":
      await scheduler.runAfter(delayMs, internal.ingest.syncCatalog, {
        tenantId: args.tenantId,
      });
      return;

    case "product_embedding":
      if (!args.shopifyProductId) {
        throw new Error("product_embedding requires a shopifyProductId");
      }
      await scheduler.runAfter(delayMs, internal.ingest.syncSingleProduct, {
        tenantId: args.tenantId,
        shopifyProductId: args.shopifyProductId,
      });
      return;

    // Not scheduled through this seam yet. Listed so that adding one is
    // a deliberate edit here rather than a silent no-op: a job row with
    // no scheduled execution is exactly the orphan this module exists to
    // prevent.
    case "product_enrichment":
    case "brand_brain_build":
    case "look_vision_analysis":
    case "look_graph_rebuild":
    case "analytics_rollup":
    case "data_purge":
      throw new Error(
        `Job type "${type}" is not schedulable through enqueue yet — see PRODUCTION_IDEMPOTENCY.md`,
      );
  }
}

/**
 * Enqueue a full catalog sync for a tenant.
 *
 * The three callers — the resync cron, the OAuth install, and the
 * merchant's Resync button — all route here, which is what closes audit
 * finding P2-1: the merchant path had no concurrency guard at all, so
 * four permitted clicks meant four concurrent full syncs, four times the
 * Shopify reads and four times the embedding spend.
 */
export const enqueueCatalogSync = internalMutation({
  args: { tenantId: v.id("tenants"), delayMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<EnqueueResult> =>
    await ctx.runMutation(internal.scheduling.enqueue, {
      tenantId: args.tenantId,
      type: "catalog_sync",
      idempotencyKey: catalogSyncKey(args.tenantId),
      delayMs: args.delayMs,
    }),
});

/** Enqueue re-ingestion of one product, from a Shopify webhook. */
export const enqueueProductSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    shopifyProductId: v.string(),
    /** What makes this distinct from a redelivery. See productSyncKey. */
    discriminator: v.string(),
  },
  handler: async (ctx, args): Promise<EnqueueResult> =>
    await ctx.runMutation(internal.scheduling.enqueue, {
      tenantId: args.tenantId,
      type: "product_embedding",
      idempotencyKey: productSyncKey(
        args.tenantId,
        args.shopifyProductId,
        args.discriminator,
      ),
      shopifyProductId: args.shopifyProductId,
    }),
});
