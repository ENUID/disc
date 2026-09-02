import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { idempotencyKey } from "./lib/jobs";

/**
 * Durable job state against the real runtime.
 *
 * The transition matrix is exhausted in `lib/jobs.test.ts` without a
 * database. What is tested here is what only the database can prove:
 * that the state survives, that a claim is exclusive, that idempotency
 * resolves to one row, and that none of it crosses a tenant boundary.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(t: ReturnType<typeof convexTest>, publicKey = "disc_acme") {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${publicKey}.myshopify.com`,
      publicKey,
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function newJob(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  key = "catalog_sync|acme|v1",
) {
  const result = await t.mutation(internal.jobs.createJob, {
    tenantId,
    type: "catalog_sync",
    idempotencyKey: key,
  });
  return result;
}

// =====================================================================

describe("lifecycle", () => {
  test("a new job is queued, unstarted, and has consumed no attempt", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const { job, created } = await newJob(t, tenantId);
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.attempt).toBe(0);
    expect(job.startedAt).toBeUndefined();
    expect(job.completedAt).toBeUndefined();
    expect(job.maxAttempts).toBeGreaterThan(1);
  });

  test("claiming moves it to running and consumes attempt 1", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);

    const claim = await t.mutation(internal.jobs.claimJob, {
      tenantId,
      jobId: job._id,
    });

    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");
    expect(claim.job.status).toBe("running");
    // Incremented on claim, not on failure: a job that died without
    // reporting anything still consumed an attempt.
    expect(claim.job.attempt).toBe(1);
    expect(claim.job.startedAt).toBeGreaterThan(0);
  });

  test("succeeding records completion", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    const done = await t.mutation(internal.jobs.succeedJob, {
      tenantId,
      jobId: job._id,
      progress: { products: 412 },
    });

    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error("unreachable");
    expect(done.job.status).toBe("succeeded");
    expect(done.job.completedAt).toBeGreaterThan(0);
    expect(done.job.progress).toEqual({ products: 412 });
  });

  test("failing records why", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    const failed = await t.mutation(internal.jobs.failJob, {
      tenantId,
      jobId: job._id,
      error: "Shopify returned 401 — the access token was revoked",
    });

    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error("unreachable");
    expect(failed.job.status).toBe("failed");
    expect(failed.job.completedAt).toBeGreaterThan(0);
    // A failed job with no recorded reason is indistinguishable from one
    // that was never run — the exact ambiguity the audit found.
    expect(failed.job.lastError).toContain("401");
  });

  test("a retrying job keeps its identity and attempt count", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    const retrying = await t.mutation(internal.jobs.retryJob, {
      tenantId,
      jobId: job._id,
      error: "provider 429",
    });
    expect(retrying.ok).toBe(true);
    if (!retrying.ok) throw new Error("unreachable");
    expect(retrying.job.status).toBe("retrying");
    expect(retrying.job.attempt).toBe(1);

    // Re-claimable, as the SAME job — that is what makes a retry a
    // second attempt rather than a new piece of work.
    const second = await t.mutation(internal.jobs.claimJob, {
      tenantId,
      jobId: job._id,
    });
    expect(second.claimed).toBe(true);
    if (!second.claimed) throw new Error("unreachable");
    expect(second.job._id).toBe(job._id);
    expect(second.job.idempotencyKey).toBe(job.idempotencyKey);
    expect(second.job.attempt).toBe(2);
  });

  test("progress is durable and bounded", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    await t.mutation(internal.jobs.updateProgress, {
      tenantId,
      jobId: job._id,
      progress: { page: 3, of: 40, nested: { dropped: true } },
    });

    const read = await t.query(internal.jobs.getJob, { tenantId, jobId: job._id });
    expect(read?.progress).toEqual({ page: 3, of: 40 });
    expect(read?.status).toBe("running");
  });

  test("progress on a finished job is refused", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId: job._id });

    const accepted = await t.mutation(internal.jobs.updateProgress, {
      tenantId,
      jobId: job._id,
      progress: { page: 99 },
    });
    // The only remaining way to write to a terminal row, closed.
    expect(accepted).toBe(false);
  });
});

describe("illegal transitions are refused at the database", () => {
  test("a succeeded job cannot be revived", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId: job._id });

    // Every route back into the machine.
    const reclaim = await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });
    expect(reclaim.claimed).toBe(false);
    if (reclaim.claimed) throw new Error("unreachable");
    expect(reclaim.reason).toBe("already_finished");

    const refail = await t.mutation(internal.jobs.failJob, {
      tenantId, jobId: job._id, error: "nope",
    });
    expect(refail.ok).toBe(false);

    const reretry = await t.mutation(internal.jobs.retryJob, {
      tenantId, jobId: job._id, error: "nope",
    });
    expect(reretry.ok).toBe(false);

    const recancel = await t.mutation(internal.jobs.cancelJob, {
      tenantId, jobId: job._id,
    });
    expect(recancel.ok).toBe(false);

    // Unchanged throughout.
    const read = await t.query(internal.jobs.getJob, { tenantId, jobId: job._id });
    expect(read?.status).toBe("succeeded");
  });

  test("a queued job cannot succeed without being claimed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);

    const done = await t.mutation(internal.jobs.succeedJob, {
      tenantId, jobId: job._id,
    });
    expect(done.ok).toBe(false);
    if (done.ok) throw new Error("unreachable");
    expect(done.reason).toContain("illegal_transition");
  });

  test("a queued job can be cancelled without ever running", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);

    const cancelled = await t.mutation(internal.jobs.cancelJob, {
      tenantId, jobId: job._id, reason: "tenant uninstalled",
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("unreachable");
    expect(cancelled.job.status).toBe("cancelled");
    expect(cancelled.job.attempt).toBe(0);
  });
});

describe("idempotency", () => {
  test("the same logical work resolves to one job row", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const key = idempotencyKey("product_enrichment", [tenantId, "prod_9", "hash_abc"]);

    const first = await t.mutation(internal.jobs.createJob, {
      tenantId, type: "product_enrichment", idempotencyKey: key,
    });
    const second = await t.mutation(internal.jobs.createJob, {
      tenantId, type: "product_enrichment", idempotencyKey: key,
    });

    expect(first.created).toBe(true);
    // `created: false` is the signal a caller acts on — it is the whole
    // of duplicate suppression, and the reason a duplicate delivery does
    // not become a second re-embed.
    expect(second.created).toBe(false);
    expect(second.job._id).toBe(first.job._id);

    const all = await t.run(async (ctx) => ctx.db.query("jobs").collect());
    expect(all).toHaveLength(1);
  });

  test("a finished job is returned, not revived", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const key = "catalog_sync|acme|v1";

    const { job } = await newJob(t, tenantId, key);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId: job._id });

    const again = await t.mutation(internal.jobs.createJob, {
      tenantId, type: "catalog_sync", idempotencyKey: key,
    });
    expect(again.created).toBe(false);
    // Re-running finished work must be an explicit new job with a new
    // key, never a side effect of asking for the old one.
    expect(again.job.status).toBe("succeeded");
  });

  test("the same key under different tenants is different work", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const other = await seedTenant(t, "disc_other");
    const key = "catalog_sync|shared|v1";

    const a = await t.mutation(internal.jobs.createJob, {
      tenantId: acme, type: "catalog_sync", idempotencyKey: key,
    });
    const b = await t.mutation(internal.jobs.createJob, {
      tenantId: other, type: "catalog_sync", idempotencyKey: key,
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.job._id).not.toBe(b.job._id);
  });

  test("an unknown job type is refused rather than silently accepted", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await expect(
      t.mutation(internal.jobs.createJob, {
        tenantId, type: "catalogSync", idempotencyKey: "typo",
      }),
    ).rejects.toThrow(/Unknown job type/);
  });
});

describe("exclusivity", () => {
  test("THE RACE: two concurrent claims, exactly one winner", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);

    // Both invocations are issued before either is awaited. Convex
    // mutations are serializable transactions, so the read of `status`
    // and the write of `running` cannot interleave: one commits, the
    // other is evaluated against that commit, sees `running`, refuses.
    const [first, second] = await Promise.all([
      t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id }),
      t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id }),
    ]);

    const winners = [first, second].filter((r) => r.claimed);
    const losers = [first, second].filter((r) => !r.claimed);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].claimed).toBe(false);
    if (losers[0].claimed) throw new Error("unreachable");
    expect(losers[0].reason).toBe("already_running");

    // Exactly ONE transition occurred. If both had claimed, attempt
    // would be 2 and the same work would be running twice.
    const read = await t.query(internal.jobs.getJob, { tenantId, jobId: job._id });
    expect(read?.status).toBe("running");
    expect(read?.attempt).toBe(1);
  });

  test("many concurrent claims still yield exactly one winner", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id }),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const read = await t.query(internal.jobs.getJob, { tenantId, jobId: job._id });
    expect(read?.attempt).toBe(1);
  });

  test("concurrent creates with one key yield one job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const key = "catalog_sync|racing|v1";

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.mutation(internal.jobs.createJob, {
          tenantId, type: "catalog_sync", idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const all = await t.run(async (ctx) => ctx.db.query("jobs").collect());
    expect(all).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  test("one tenant cannot read, claim or finish another's job", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const other = await seedTenant(t, "disc_other");
    const { job } = await newJob(t, acme);

    // Reported as not-found rather than denied: a caller holding another
    // tenant's id should learn nothing about whether it exists.
    expect(
      await t.query(internal.jobs.getJob, { tenantId: other, jobId: job._id }),
    ).toBeNull();

    const claim = await t.mutation(internal.jobs.claimJob, {
      tenantId: other, jobId: job._id,
    });
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("not_found");

    for (const attempt of [
      t.mutation(internal.jobs.succeedJob, { tenantId: other, jobId: job._id }),
      t.mutation(internal.jobs.failJob, { tenantId: other, jobId: job._id, error: "x" }),
      t.mutation(internal.jobs.cancelJob, { tenantId: other, jobId: job._id }),
    ]) {
      expect((await attempt).ok).toBe(false);
    }

    // Untouched by any of it.
    const read = await t.query(internal.jobs.getJob, { tenantId: acme, jobId: job._id });
    expect(read?.status).toBe("queued");
  });

  test("listJobs never returns another tenant's work", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const other = await seedTenant(t, "disc_other");
    await newJob(t, acme, "catalog_sync|acme|v1");
    await newJob(t, other, "catalog_sync|other|v1");

    const acmeJobs = await t.query(internal.jobs.listJobs, { tenantId: acme });
    expect(acmeJobs).toHaveLength(1);
    expect(acmeJobs[0].tenantId).toBe(acme);
  });

  test("a job cannot be created for a tenant that does not exist", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    // Delete the tenant, keep the id.
    await t.run(async (ctx) => ctx.db.delete(tenantId));

    await expect(
      t.mutation(internal.jobs.createJob, {
        tenantId, type: "catalog_sync", idempotencyKey: "orphan",
      }),
    ).rejects.toThrow(/Unknown tenant/);
  });
});

describe("survival", () => {
  test("a job interrupted mid-flight is still discoverable afterwards", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });
    await t.mutation(internal.jobs.updateProgress, {
      tenantId, jobId: job._id, progress: { page: 7 },
    });

    // Simulate the action dying here: nothing reports success or
    // failure. Previously this state lived in a variable that died with
    // it, so the work was neither running nor recoverable.
    const survivor = await t.query(internal.jobs.getJob, { tenantId, jobId: job._id });
    expect(survivor?.status).toBe("running");
    expect(survivor?.attempt).toBe(1);
    expect(survivor?.progress).toEqual({ page: 7 });

    // And it is findable as stuck, which is the question the audit could
    // not answer: "is this tenant's work wedged?"
    const stuck = await t.query(internal.jobs.stuckJobs, {
      runningSince: Date.now() + 1000,
    });
    expect(stuck.map((j: { _id: Id<"jobs"> }) => j._id)).toContain(job._id);
  });

  test("a healthy in-flight job is not reported as stuck", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { job } = await newJob(t, tenantId);
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    // Anything started after the cutoff is simply still working.
    const stuck = await t.query(internal.jobs.stuckJobs, {
      runningSince: Date.now() - 60_000,
    });
    expect(stuck.map((j: { _id: Id<"jobs"> }) => j._id)).not.toContain(job._id);
  });

  test("work is addressable by its key after an interruption", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const key = idempotencyKey("catalog_sync", [tenantId, "v1"]);
    const { job } = await t.mutation(internal.jobs.createJob, {
      tenantId, type: "catalog_sync", idempotencyKey: key,
    });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: job._id });

    // A caller that lost the jobId — a webhook redelivered after a
    // restart — recovers the same record from the logical key alone.
    const found = await t.query(internal.jobs.getJobByKey, {
      tenantId, idempotencyKey: key,
    });
    expect(found?._id).toBe(job._id);
    expect(found?.status).toBe("running");
  });
});
