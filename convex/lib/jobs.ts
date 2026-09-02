/**
 * Durable job state — the transition rules.
 *
 * Pure and separate from `convex/jobs.ts` so the state machine can be
 * exhausted by tests without a database. The failure this module exists
 * to prevent is silent: a job that is "running" according to a variable
 * that died with the action, and is therefore neither running nor
 * recoverable.
 *
 * WHAT THIS IS NOT: a queue. Convex's scheduler decides *when* work
 * runs; a row here records *what state that work is in*. Nothing polls
 * this table looking for things to execute. Making the job table the
 * queue would mean a sweeper racing the scheduler for the same work, and
 * would rebuild — badly — a component Convex already provides.
 *
 *     scheduler  ──▶  job execution  ◀──▶  durable job record
 *
 * Retry policy is deliberately absent. `attempt` and `maxAttempts` are
 * recorded because the retry phase will need them; nothing here reads
 * them to make a decision yet.
 */

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "retrying",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * States a job can never leave.
 *
 * "A completed job cannot accidentally become pending again" is an
 * invariant, and this is where it is enforced: every terminal state has
 * an empty transition set, so there is no path back into the machine.
 */
export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * The transition matrix. Everything not listed is rejected.
 *
 * Cancellation is permitted from all three live states, not just
 * `running`. Cancelling a job that has not started yet is the ordinary
 * case — a merchant uninstalls, a tenant is purged, a superseded sync —
 * and forcing it to be claimed first in order to be cancelled would mean
 * doing the work to abandon it.
 */
const ALLOWED: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set<JobStatus>(["running", "cancelled"]),
  running: new Set<JobStatus>(["succeeded", "retrying", "failed", "cancelled"]),
  retrying: new Set<JobStatus>(["running", "failed", "cancelled"]),
  succeeded: new Set<JobStatus>(),
  failed: new Set<JobStatus>(),
  cancelled: new Set<JobStatus>(),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED[from]?.has(to) ?? false;
}

export function allowedFrom(from: JobStatus): JobStatus[] {
  return [...(ALLOWED[from] ?? [])];
}

/**
 * States a job may be claimed from.
 *
 * `retrying` is claimable because that is what makes a retry a *second
 * attempt of the same job* rather than a new one — the identity, the
 * idempotency key and the attempt count all survive. `queued` is the
 * first attempt.
 *
 * Nothing else is claimable. In particular `running` is not: that is the
 * entire double-execution guard.
 */
export const CLAIMABLE: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "queued",
  "retrying",
]);

export function isClaimable(status: JobStatus): boolean {
  return CLAIMABLE.has(status);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Why a claim was refused.
 *
 * A refusal is a normal outcome, not an error — the second of two
 * concurrent invocations refusing is the system working. Callers need to
 * distinguish "someone else has it" from "this job is over", because the
 * first may be worth observing and the second never is.
 */
export type ClaimRefusal = "already_running" | "already_finished" | "not_found";

export function refusalFor(status: JobStatus): ClaimRefusal {
  if (status === "running") return "already_running";
  return "already_finished";
}

/**
 * The job types Disc runs.
 *
 * A closed set so a typo becomes a compile error rather than a job type
 * nobody is watching. Every entry is work that is expensive,
 * long-running, externally triggered, or all three.
 *
 * DELIBERATELY ABSENT: anything on the shopper's request path. A search
 * or an outfit build is a user-facing deterministic computation and runs
 * inline. Turning those into durable jobs would make a shopper wait on a
 * state machine to answer a question they asked half a second ago.
 */
export const JOB_TYPES = [
  "catalog_sync",
  "product_enrichment",
  "product_embedding",
  "brand_brain_build",
  "look_vision_analysis",
  "look_graph_rebuild",
  "analytics_rollup",
  "data_purge",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

/**
 * Build an idempotency key.
 *
 * THE KEY IS NOT THE JOB ID, and the distinction is the point:
 *
 *   jobId           this execution record
 *   idempotencyKey  this logical piece of work
 *
 * Two deliveries of the same Shopify webhook are two invocations of one
 * logical piece of work. They must resolve to one job row, or the
 * catalog is re-embedded twice and billed twice. That is the property
 * the webhook phase will depend on, and it is why the key is a first
 * class field rather than something derived at the call site.
 *
 * Parts are escaped before joining, so the encoding is injective:
 * `["a", "b|c"]` and `["a|b", "c"]` must not produce the same key, or
 * two unrelated pieces of work deduplicate into one and one webhook
 * silently suppresses another.
 *
 * Escaping `%` first is what makes it injective — without that, a
 * literal "%7C" in an input would decode to the same key as an escaped
 * separator. Convex ids and content hashes contain neither character
 * today; the encoding does not depend on that staying true.
 */
function escapePart(part: string): string {
  return part.replace(/%/g, "%25").replace(/\|/g, "%7C");
}

export function idempotencyKey(type: JobType, parts: Array<string | number>): string {
  return [type, ...parts.map((p) => escapePart(String(p)))].join("|");
}

/** The default attempt ceiling. Recorded now; enforced by the retry phase. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Bound a progress blob.
 *
 * Progress is merchant-invisible operational data, but it lives in a
 * document Convex caps at 1 MiB, and it is written by code that will one
 * day report per-product detail on a 5,000-product catalog. An unbounded
 * blob here is a write that starts failing at exactly the scale where
 * the progress mattered.
 */
export function boundProgress(raw: unknown, maxKeys = 12, maxLength = 200): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.slice(0, maxLength);
  if (typeof raw !== "object") return undefined;

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    // One level deep. Nesting is how a bounded blob becomes unbounded.
    if (value !== null && typeof value === "object") continue;
    if (value === undefined) continue;
    out[key.slice(0, 40)] =
      typeof value === "string" ? value.slice(0, maxLength) : value;
    count++;
  }
  return out;
}

/** Truncate an error for storage. Errors carry request context and reach logs. */
export function boundError(error: unknown, maxLength = 500): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return message.slice(0, maxLength);
}
