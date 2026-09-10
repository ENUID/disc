import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { manualRetryKey, type AttemptRecord } from "./lib/jobs";
import { ProviderError } from "./lib/providers";
import { runAsJob } from "./jobrunner";

/**
 * Retry, against the real runtime (P1.3).
 *
 * The pure tests in `lib/retry.test.ts` exhaust the policy. These prove
 * the policy is actually wired to the state machine: that a retry reuses
 * one job rather than creating a second, that an exhausted job stops,
 * that a crashed job cannot loop forever, and that a merchant whose sync
 * failed has a way out.
 *
 * Most failures here are driven through `reportJobFailure` with an
 * explicit class rather than by making a real provider fall over. That is
 * deliberate: the classification of a real error is what
 * `lib/retry.test.ts` tests, and mixing the two would leave neither
 * proven. The executor tests at the end close the loop by driving a real
 * worker whose failure is reachable without a network.
 */

const modules = import.meta.glob("./**/*.ts");

const WEBHOOK_SECRET = "test-shopify-api-secret";
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = WEBHOOK_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = previousSecret;
});

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  slug = "acme",
  overrides: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      accessTokenCipher: "cipher",
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }),
  );
}

async function jobRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("jobs").collect());
}

async function scheduledCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).length,
  );
}

/** Enqueue a catalog sync and claim it, i.e. put a job mid-attempt. */
async function runningJob(t: ReturnType<typeof convexTest>, tenantId: any) {
  const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
  await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
  return jobId;
}

// =====================================================================

describe("one job, many attempts", () => {
  test("a retryable failure keeps the same job and schedules the next attempt", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);

    const before = (await jobRows(t))[0];
    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId,
      jobId,
      errorClass: "shopify_throttled",
      message: "Throttled",
    });

    expect(result.outcome).toBe("retrying");
    const after = (await jobRows(t))[0];
    expect(after.status).toBe("retrying");
    expect(after.errorClass).toBe("shopify_throttled");
    expect(after.retryable).toBe(true);
    expect(after.nextAttemptAt).toBeGreaterThan(Date.now() - 1);

    // 10. The identity of the logical work does not change across a
    // retry. A new key would make the attempt count meaningless and let
    // a duplicate trigger slip past deduplication as "new" work.
    expect(after._id).toBe(before._id);
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("a non-retryable failure fails at once, with attempts to spare", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);

    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId,
      jobId,
      errorClass: "shopify_unauthorized",
      message: "401",
    });

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.reason).toBe("terminal");

    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.attempt).toBe(1);
    expect(job.maxAttempts).toBe(3);
    // Nothing further scheduled: only the original execution.
    expect(await scheduledCount(t)).toBe(1);
  });

  test("14. attempts are bounded — a failing job does not loop forever", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    const outcomes: string[] = [];
    // Drive the whole ceiling: claim, fail retryably, repeat.
    for (let i = 0; i < 5; i++) {
      const claim = await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      if (!claim.claimed) break;
      const r = await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId,
        jobId,
        errorClass: "provider_unavailable",
        message: "503",
      });
      outcomes.push(r.outcome);
    }

    // Three claims, two retries, then it stops. Not four, not forever.
    expect(outcomes).toEqual(["retrying", "retrying", "failed"]);

    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.attempt).toBe(3);
    expect(await jobRows(t)).toHaveLength(1);

    // A further attempt cannot be claimed at all.
    const after = await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    expect(after.claimed).toBe(false);
  });

  test("the row explains why the job ran three times", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    const classes = ["shopify_throttled", "network", "provider_unavailable"];
    for (const errorClass of classes) {
      await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass, message: `${errorClass} happened`,
      });
    }

    // The observability requirement, as data rather than as log lines:
    // one entry per failed attempt, in order, each with its own class.
    const job = (await jobRows(t))[0];
    const history: AttemptRecord[] = job.attempts ?? [];
    expect(history).toHaveLength(3);
    expect(history.map((a) => a.errorClass)).toEqual(classes);
    expect(history.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(history.map((a) => a.retryable)).toEqual([true, true, false]);
  });

  test("attempt history cannot grow a document without bound", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    // A caller-supplied ceiling far above the history cap.
    const { jobId } = await t.mutation(internal.scheduling.enqueue, {
      tenantId,
      type: "catalog_sync",
      idempotencyKey: "catalog_sync|bounded",
      maxAttempts: 50,
    });

    for (let i = 0; i < 25; i++) {
      await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass: "network", message: `attempt ${i}`,
      });
    }

    const job = (await jobRows(t))[0];
    expect(job.attempts!.length).toBeLessThanOrEqual(10);
    // The most recent are kept: what happened last is what explains
    // where the job ended up.
    expect(job.attempts!.at(-1)!.attempt).toBe(25);
  });
});

describe("no double execution", () => {
  test("11. two concurrent failure reports produce one retry", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);

    const [a, b] = await Promise.all([
      t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass: "network", message: "one",
      }),
      t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass: "network", message: "two",
      }),
    ]);

    // The second is ignored because the job is no longer running. Without
    // that guard it would consume a second transition and could push the
    // job past its ceiling on a single attempt.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["ignored", "retrying"]);

    // One retry scheduled, on top of the original execution.
    expect(await scheduledCount(t)).toBe(2);
    expect((await jobRows(t))[0].attempt).toBe(1);
  });

  test("12. a retrying job cannot be claimed twice", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "network", message: "blip",
    });

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.mutation(internal.jobs.claimJob, { tenantId, jobId }),
      ),
    );

    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    // One attempt consumed, not four.
    expect((await jobRows(t))[0].attempt).toBe(2);
  });

  test("a failure report against a job that is not running is ignored", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    // Never claimed, so nothing can have failed.
    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "network", message: "impossible",
    });
    expect(result.outcome).toBe("ignored");
    expect((await jobRows(t))[0].status).toBe("queued");
  });

  test("a retry that cannot be scheduled fails the job rather than wedging it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueue, {
      tenantId,
      type: "product_embedding",
      idempotencyKey: "product_embedding|orphan",
      shopifyProductId: "gid://1",
    });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    // Strip the worker arguments, so the retry has nothing to schedule
    // with — the shape a row written before `payload` existed would have.
    await t.run(async (ctx) => ctx.db.patch(jobId, { payload: undefined }));

    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "network", message: "blip",
    });

    // Terminal, with a state that says why. If the mutation had aborted
    // instead, the row would roll back to `running`, the stale sweeper
    // would hit the same error on every pass, and the job would be
    // wedged forever with nothing recording the reason.
    expect(result.outcome).toBe("failed");
    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.errorClass).toBe("invalid_configuration");
    expect(job.lastError).toMatch(/Cannot schedule retry/);
  });

  test("an unrecognised error class is treated as terminal", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);

    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "something_new", message: "?",
    });

    // Fails closed. A class nobody declared is not one anybody showed is
    // safe to repeat.
    expect(result.outcome).toBe("failed");
    expect((await jobRows(t))[0].errorClass).toBe("unknown");
  });
});

describe("15. crash recovery", () => {
  /** Backdate a running job so the sweeper sees it as stale. */
  async function makeStale(t: ReturnType<typeof convexTest>, jobId: any) {
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { startedAt: Date.now() - 60 * 60 * 1000 });
    });
  }

  test("a job whose execution died is recovered, not re-run blindly", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);
    await makeStale(t, jobId);

    await t.action(internal.crons.recoverStuckJobs, {});

    const job = (await jobRows(t))[0];
    // Back into the state machine, with a reason that names what
    // happened rather than "unknown".
    expect(job.status).toBe("retrying");
    expect(job.errorClass).toBe("stalled");
    expect(job.attempt).toBe(1);
    expect(await scheduledCount(t)).toBe(2);
  });

  test("a running job that is merely young is left alone", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await runningJob(t, tenantId);

    await t.action(internal.crons.recoverStuckJobs, {});

    // Recovering a live execution would give two concurrent runs of the
    // same work — worse than recovering a dead one late.
    expect((await jobRows(t))[0].status).toBe("running");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("a crash loop terminates because the stale attempt is consumed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    // Claim, die, get recovered — three times over.
    for (let i = 0; i < 4; i++) {
      const claim = await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      if (!claim.claimed) break;
      await makeStale(t, jobId);
      await t.action(internal.crons.recoverStuckJobs, {});
    }

    // THE point of incrementing `attempt` on claim rather than on
    // failure: a process that disappears never reaches a failure
    // counter, so counting there would resurrect this job forever.
    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.attempt).toBe(3);
  });

  test("the sweeper never touches another tenant's jobs by accident", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");
    const staleJob = await runningJob(t, acme);
    await runningJob(t, other);
    await makeStale(t, staleJob);

    await t.action(internal.crons.recoverStuckJobs, {});

    const rows = await jobRows(t);
    const recovered = rows.filter((r) => r.status === "retrying");
    const untouched = rows.filter((r) => r.status === "running");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tenantId).toBe(acme);
    expect(untouched[0].tenantId).toBe(other);
  });
});

describe("7. manual retry", () => {
  /** Drive a job all the way to a terminal failure. */
  async function failedJob(t: ReturnType<typeof convexTest>, tenantId: any) {
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "unknown", message: "gave up",
    });
    return jobId;
  }

  test("an ordinary duplicate still deduplicates against a failed job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await failedJob(t, tenantId);

    // The cron sweep. Not a new decision by anyone, so it must not
    // re-drive work the retry policy already gave up on.
    const again = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    expect(again.created).toBe(false);
    expect(again.status).toBe("failed");
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("an explicit retry creates a new execution opportunity", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const original = await failedJob(t, tenantId);

    const retried = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId,
      explicit: true,
    });

    expect(retried.created).toBe(true);
    expect(retried.recovered).toBe(true);
    expect(retried.jobId).not.toBe(original);

    const rows = await jobRows(t);
    expect(rows).toHaveLength(2);

    // History preserved: the failed row is untouched, including its key.
    const old = rows.find((r) => r._id === original)!;
    expect(old.status).toBe("failed");
    expect(old.attempt).toBe(1);
    expect(old.lastError).toBe("gave up");

    // And the chain is followable.
    const fresh = rows.find((r) => r._id === retried.jobId)!;
    expect(fresh.supersedes).toBe(original);
    expect(fresh.status).toBe("queued");
    expect(fresh.attempt).toBe(0);
    expect(fresh.idempotencyKey).toBe(manualRetryKey(old.idempotencyKey));
  });

  test("double-clicking Retry starts one job, not two", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await failedJob(t, tenantId);

    const clicks = await Promise.all(
      Array.from({ length: 3 }, () =>
        t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId, explicit: true }),
      ),
    );

    // The derived key is deduplicated exactly like the original one.
    expect(clicks.filter((c) => c.created)).toHaveLength(1);
    expect(await jobRows(t)).toHaveLength(2); // the failed one, and one retry
  });

  test("13. a succeeded job is never revived by a retry", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId });

    const direct = await t.mutation(internal.scheduling.retryFailedJob, { tenantId, jobId });
    expect(direct.retried).toBe(false);
    expect(direct.retried === false && direct.reason).toBe("not_failed:succeeded");

    // And through the merchant's own path: an explicit retry of work
    // that succeeded is a no-op, not a second sync.
    const explicit = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId,
      explicit: true,
    });
    expect(explicit.created).toBe(false);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("a live job is not re-driven by an explicit retry", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const jobId = await runningJob(t, tenantId);

    // "Explicit" changes the failed case and nothing else. A running job
    // already has an attempt in flight, and starting a second would be
    // exactly the double execution this phase exists to prevent.
    const explicit = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId,
      explicit: true,
    });
    expect(explicit.created).toBe(false);
    expect(explicit.status).toBe("running");

    const refused = await t.mutation(internal.scheduling.retryFailedJob, { tenantId, jobId });
    expect(refused.retried).toBe(false);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("a cancelled job is not restarted by a button labelled Retry", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.cancelJob, { tenantId, jobId, reason: "uninstalled" });

    const result = await t.mutation(internal.scheduling.retryFailedJob, { tenantId, jobId });
    expect(result.retried).toBe(false);
    expect(result.retried === false && result.reason).toBe("not_failed:cancelled");
  });

  test("a manual retry can itself be retried, and the chain stays followable", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const first = await failedJob(t, tenantId);

    const second = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId, explicit: true,
    });
    // Fail the retry too.
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: second.jobId });
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId: second.jobId, errorClass: "unknown", message: "again",
    });

    const third = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId, explicit: true,
    });
    expect(third.created).toBe(true);

    const rows = await jobRows(t);
    expect(rows).toHaveLength(3);
    const chain = rows.find((r) => r._id === third.jobId)!;
    expect(chain.supersedes).toBe(second.jobId);
    expect(rows.find((r) => r._id === second.jobId)!.supersedes).toBe(first);
  });

  test("the retry chain is bounded rather than growing forever", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await failedJob(t, tenantId);

    // Retry, fail, retry, fail... until the bound refuses.
    let refusals = 0;
    for (let i = 0; i < 15; i++) {
      const retried = await t.mutation(internal.scheduling.enqueueCatalogSync, {
        tenantId, explicit: true,
      });
      if (!retried.created) {
        refusals++;
        continue;
      }
      await t.mutation(internal.jobs.claimJob, { tenantId, jobId: retried.jobId });
      await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId: retried.jobId, errorClass: "unknown", message: "again",
      });
    }

    // It stops. Each link costs a key suffix and an indexed read, and a
    // merchant on their eleventh consecutive retry needs the underlying
    // failure fixed, not an eleventh attempt.
    expect(refusals).toBeGreaterThan(0);
    const rows = await jobRows(t);
    expect(rows.length).toBeLessThanOrEqual(11);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });
});

describe("16. tenant isolation", () => {
  test("a failure cannot be reported across tenants", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");
    const jobId = await runningJob(t, acme);

    const result = await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId: other,
      jobId,
      errorClass: "network",
      message: "not yours",
    });

    // Reported as not-found rather than denied: a caller holding another
    // tenant's id should learn nothing about whether it exists.
    expect(result.outcome).toBe("ignored");
    expect(result.outcome === "ignored" && result.reason).toBe("not_found");
    expect((await jobRows(t))[0].status).toBe("running");
  });

  test("a job cannot be manually retried across tenants", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId: acme,
    });
    await t.mutation(internal.jobs.claimJob, { tenantId: acme, jobId });
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId: acme, jobId, errorClass: "unknown", message: "x",
    });

    const result = await t.mutation(internal.scheduling.retryFailedJob, {
      tenantId: other,
      jobId,
    });
    expect(result.retried).toBe(false);
    expect(result.retried === false && result.reason).toBe("not_found");
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("two tenants failing the same logical work stay separate", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");

    for (const tenantId of [acme, other]) {
      const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
      await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass: "unknown", message: "x",
      });
    }

    // One tenant's explicit retry must not adopt the other's job.
    const retried = await t.mutation(internal.scheduling.enqueueCatalogSync, {
      tenantId: acme,
      explicit: true,
    });
    expect(retried.created).toBe(true);

    const rows = await jobRows(t);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.tenantId === acme)).toHaveLength(2);
    expect(rows.filter((r) => r.tenantId === other)).toHaveLength(1);
  });
});

describe("the executor, driving a real worker", () => {
  test("a worker's terminal failure reaches the job row", async () => {
    const t = convexTest(schema, modules);
    // No credentials: `syncCatalogWork` raises TerminalJobError, which is
    // a real failure through the real worker with no network involved.
    const tenantId = await seedTenant(t, "acme", { accessTokenCipher: "" });
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    await t.action(internal.ingest.syncCatalog, { tenantId, jobId });

    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.errorClass).toBe("invalid_configuration");
    expect(job.attempt).toBe(1);
    // Terminal: no second attempt scheduled, however many remain.
    expect(await scheduledCount(t)).toBe(1);
  });

  test("an execution arriving while another holds the job does nothing at all", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "acme", { accessTokenCipher: "" });
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    // Another execution already holds the job — the state the stale-job
    // sweeper and a duplicate schedule can both produce.
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });

    await t.action(internal.ingest.syncCatalog, { tenantId, jobId });

    // The job is untouched: still running, still on attempt 1, with no
    // recorded failure. If the executor had ignored the refusal and run
    // the work anyway, this tenant's credential failure would have been
    // reported against a job someone else is executing, and the row
    // would read `failed` here.
    //
    // This assertion is the reason the test is shaped this way rather
    // than as two concurrent executions: with two, BOTH orderings leave
    // `attempt` at 1, so a missing claim guard passes unnoticed.
    const job = (await jobRows(t))[0];
    expect(job.status).toBe("running");
    expect(job.attempt).toBe(1);
    expect(job.attempts).toBeUndefined();
  });

  /**
   * `runAsJob` against a work function that fails on demand.
   *
   * The tests above drive `reportJobFailure` with a class, which proves
   * the decision. This drives a real thrown error all the way through
   * classification into the row, which is the seam between the two
   * halves and the one place a mistake would leave the policy correct
   * and disconnected.
   */
  const fakeCtx = (t: ReturnType<typeof convexTest>) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runMutation: (fn: any, args: any) => t.mutation(fn, args),
  });

  test("a real retryable provider error reaches the job as a retry", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    const outcome = await runAsJob(fakeCtx(t), { tenantId, jobId }, async () => {
      throw new ProviderError("Model request failed (429)", true, 429);
    });

    expect(outcome.ran).toBe(false);
    const job = (await jobRows(t))[0];
    expect(job.status).toBe("retrying");
    expect(job.errorClass).toBe("provider_rate_limited");
    expect(job.attempt).toBe(1);
    // A second execution is scheduled, on top of the original.
    expect(await scheduledCount(t)).toBe(2);
  });

  test("a real terminal provider error reaches the job as a failure", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    await runAsJob(fakeCtx(t), { tenantId, jobId }, async () => {
      throw new ProviderError("Model request failed (400)", false, 400);
    });

    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.errorClass).toBe("invalid_input");
    // Nothing rescheduled: only the original execution exists.
    expect(await scheduledCount(t)).toBe(1);
  });

  test("work that succeeds closes the job and schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    const outcome = await runAsJob(fakeCtx(t), { tenantId, jobId }, async () => "done");

    expect(outcome).toEqual({ ran: true, result: "done" });
    expect((await jobRows(t))[0].status).toBe("succeeded");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("an unclassified error fails the job rather than retrying it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    await runAsJob(fakeCtx(t), { tenantId, jobId }, async () => {
      throw new Error("something nobody has classified");
    });

    // The default that keeps a new bug from becoming a paid retry loop.
    const job = (await jobRows(t))[0];
    expect(job.status).toBe("failed");
    expect(job.errorClass).toBe("unknown");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("a worker invoked without a job behaves exactly as it used to", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "acme", { accessTokenCipher: "" });

    // No jobId: no claim, no retry, nothing recorded. The error
    // propagates to the caller, which is what a direct invocation has
    // always done.
    await expect(t.action(internal.ingest.syncCatalog, { tenantId })).rejects.toThrow();
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("25. a provider outage does not lose the job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    // Two attempts lost to an outage.
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
      await t.mutation(internal.scheduling.reportJobFailure, {
        tenantId, jobId, errorClass: "provider_unavailable", message: "503",
      });
    }

    // The work is still there, still identified, still claimable.
    const midway = (await jobRows(t))[0];
    expect(midway.status).toBe("retrying");
    expect(midway.attempt).toBe(2);

    // And when the provider comes back, the same job finishes.
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId });

    const done = (await jobRows(t))[0];
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(3);
    expect(done.idempotencyKey).toBe(midway.idempotencyKey);
    expect(await jobRows(t)).toHaveLength(1);
  });
});

describe("17. the merchant's recovery path, end to end", () => {
  test("POST /merchant/resync recovers a failed sync", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const token = await t.mutation(internal.auth.issueSession, { tenantId });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    // First click: an ordinary sync, which then fails.
    const first = await t.fetch("/merchant/resync", { method: "POST", ...auth });
    expect(await first.json()).toMatchObject({ deduplicated: false, recovered: false });

    const jobId = (await jobRows(t))[0]._id;
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "unknown", message: "Shopify said no",
    });

    // THE REGRESSION THIS CLOSES. Before P1.3 this second click returned
    // `deduplicated: true` and did nothing at all, because the failed
    // job held the key until the five-minute bucket rolled over — the
    // button that exists to fix a broken sync was a no-op for as long as
    // a merchant was likely to be looking at it.
    const second = await t.fetch("/merchant/resync", { method: "POST", ...auth });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "queued",
      deduplicated: false,
      recovered: true,
    });

    const rows = await jobRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
  });

  test("POST /merchant/resync still collapses ordinary repeat clicks", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const token = await t.mutation(internal.auth.issueSession, { tenantId });

    // P1.2's guarantee, unchanged: `explicit` alters the failed case only.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.fetch("/merchant/resync", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(bodies.filter((b) => b.deduplicated === false)).toHaveLength(1);
    expect(bodies.every((b) => b.recovered === false)).toBe(true);
    expect(await jobRows(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("19. the resync cron does not re-drive a failed sync", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const { jobId } = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId });
    await t.mutation(internal.scheduling.reportJobFailure, {
      tenantId, jobId, errorClass: "unknown", message: "x",
    });

    // The sweep repeating itself is not a new decision by anyone. Only a
    // person pressing Retry is.
    for (let i = 0; i < 3; i++) {
      const sweep = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
      expect(sweep.created).toBe(false);
      expect(sweep.recovered).toBeUndefined();
    }
    expect(await jobRows(t)).toHaveLength(1);
  });
});
