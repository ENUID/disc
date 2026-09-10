# Durable job state (P1.1)

The execution substrate the retry, webhook-dedup and Stripe-ledger
phases will be built on. This document is the contract those phases
should hold this primitive to.

**Scope:** state, identity and coordination only. No retry policy, no
backoff, no dead-letter, no sweeper, no queue. Those come next and are
deliberately absent — building retry before durable state means building
it twice.

---

## What was wrong

Every background operation was `ctx.scheduler.runAfter(...)`
fire-and-forget. There was no job table
(`grep -n "jobs\|jobId\|idempotency" convex/schema.ts` → nothing), and
so:

- no attempt count, so nothing could implement a ceiling
- no terminal failure state, so nothing could dead-letter
- no way to answer "is tenant X's enrichment stuck?" except by inferring
  from `catalogStatus` and profile coverage
- no idempotency key, so a duplicated trigger duplicated the work
- **a job that failed *after* its writes was indistinguishable from one
  that never ran** — the ambiguity that makes recovery guesswork

Progress was inferred from side effects (`cacheKey` staleness). That
works until you need to know *why* something stopped.

---

## The state machine

```
                 ┌─────────┐
                 │ queued  │
                 └────┬────┘
          claim       │        cancel
        ┌─────────────┼─────────────┐
        ▼             │             ▼
   ┌─────────┐        │       ┌───────────┐
   │ running │◀───────┼──────▶│ cancelled │
   └────┬────┘   claim│       └───────────┘
        │             │             ▲
   ┌────┼────┬────────┴───┐         │
   ▼    ▼    ▼            │         │
┌────┐ ┌────┐ ┌──────────┐│         │
│succ│ │fail│ │ retrying ├┘─────────┘
└────┘ └────┘ └────┬─────┘   cancel
                   │ fail
                   ▼
                ┌──────┐
                │failed│
                └──────┘
```

The full matrix — nine permitted transitions out of thirty-six pairs:

| from | permitted to |
| --- | --- |
| `queued` | `running`, `cancelled` |
| `running` | `succeeded`, `retrying`, `failed`, `cancelled` |
| `retrying` | `running`, `failed`, `cancelled` |
| `succeeded` | — |
| `failed` | — |
| `cancelled` | — |

**One deliberate departure from the brief.** The transition table in the
instruction listed `running → cancelled` only, while the lifecycle
diagram above it said `queued/running/retrying → cancelled`. I
implemented the diagram: cancelling a job that has not started yet is
the ordinary case — an uninstall, a tenant purge, a superseded sync —
and requiring it to be claimed first would mean doing the work in order
to abandon it.

---

## Invariants, and where each is enforced

| Invariant | Enforced by |
| --- | --- |
| A job has one durable identity | `jobs` document id |
| State survives action failure | The row, not a variable. Nothing about a job lives in process memory. |
| Running work is recognisable after a restart | `stuckJobs` — `running` rows whose `startedAt` predates any plausible execution |
| Logical work is addressable by key | `by_tenant_and_idempotency`, and `getJobByKey` |
| A completed job cannot become pending again | Terminal states have an **empty** transition set — there is no path back into the machine |
| A failed job records why | `failJob` requires `error`; `lastError` is written on the same transition |
| Progress is observable | `progress`, bounded, written only while `running` |
| Tenant ownership is mandatory | `tenantId` on the row; every operation takes it and compares |

---

## Concurrency

`claimJob` is the primitive everything else rests on. Only `queued` and
`retrying` are claimable; `running` is refused, which **is** the
double-execution guard.

The read of `status` and the write of `running` happen inside **one
mutation**. That matters more than it looks: splitting it into a query
that checks and a mutation that writes would reintroduce the race
silently, because the check would be against a snapshot the write no
longer holds.

`attempt` is incremented **on claim, not on failure**. A job that dies
without reporting anything still consumed an attempt — counting on
failure would let a crash loop retry forever, because a process that
disappears never reaches the counter.

A refusal is a normal outcome, not an error. The second of two
concurrent invocations refusing is the system working. `already_running`
and `already_finished` are distinguished because the first may be worth
observing and the second never is.

### What the race test proves, and what it does not

`jobs.itest.ts` issues two — and separately eight — concurrent
`claimJob` calls and asserts exactly one winner, exactly one transition,
and `attempt === 1`.

**It proves the guard is correct:** once a job is `running`, every
further claim is refused, and the winner is unambiguous.

**It does not prove Convex's isolation.** I probed whether `convex-test`
interleaves two mutations or serializes them end to end, and could not
distinguish the two from outside — one winner is the observed result
either way. So exclusivity under *real* concurrency rests on Convex's
documented serializable isolation of mutations, which is a platform
guarantee this code depends on rather than one this test verifies.

That distinction is worth keeping honest, because the fix if it were
ever untrue is not in this module — it would be a compare-and-set
against a version field, which is only worth adding if the platform
guarantee turns out not to hold.

---

## Idempotency

```
jobId           this execution record
idempotencyKey  this logical piece of work
```

They are deliberately different things. Two deliveries of one Shopify
webhook are two invocations of **one** logical job and must resolve to
one row, or a catalog is re-embedded twice and billed twice. That is the
property the webhook phase will depend on.

`createJob` returns `{ job, created }`. `created` is the signal a caller
acts on: schedule execution when true, do nothing when false because
someone already has. A duplicate is a normal event, so it returns the
existing row rather than throwing.

**A terminal existing job is returned as-is, never revived.** Re-running
finished work has to be an explicit new job with a new key, never a side
effect of asking for the old one.

Keys are built by `idempotencyKey(type, parts)`, which escapes `%` then
`|` before joining. The first implementation joined on `|` without
escaping, so `["a", "b|c"]` and `["a|b", "c"]` produced the same key —
two unrelated pieces of work deduplicating into one, which for webhooks
means one silently suppressing another. The test caught it; the escape
is injective and the test now also pins the `%7C` and `%25` cases.

Uniqueness rests on a read-then-insert inside one mutation and the same
isolation guarantee as the claim. Convex has no unique constraint.

---

## Why the scheduler and the job record are separate

```
scheduler  ──▶  job execution  ◀──▶  durable job record
```

**not**

```
query job table → find pending jobs → execute everything
```

The second design is a hand-built queue. A sweeper polling for `queued`
rows would race the scheduler for the same work, and would need its own
locking, its own visibility timeout and its own poison-message handling
— rebuilding, worse, a component Convex already provides and which this
repo already moved to deliberately when it replaced the prototype's
in-process asyncio loop.

So: **nothing polls this table to decide what to run.** `stuckJobs`
reports; it does not act. Deciding what to do about a wedged job is the
retry phase's call.

---

## What is a job, and what is not

```
user-facing deterministic computation   →  execute inline
expensive / long-running / retryable /
externally triggered work               →  durable job
```

`JOB_TYPES` is a closed set: `catalog_sync`, `product_enrichment`,
`product_embedding`, `brand_brain_build`, `look_vision_analysis`,
`look_graph_rebuild`, `analytics_rollup`, `data_purge`.

Search, outfit building, intent parsing and explanation are **not** job
types, and a test asserts they are rejected. Putting a state machine
between a shopper and an answer they asked for half a second ago would
be the wrong trade, and the existing architecture already draws this
line correctly.

---

## Tests

**`convex/lib/jobs.test.ts`** — 17 tests, no database.

The first asserts the **entire 6×6 matrix**, not the happy paths: every
one of the thirty-six pairs is checked against an expected set written
out independently of the implementation. Also: no state transitions to
itself; terminal states have no outgoing edges at all; the claimable set
and the "has an edge to `running`" set must agree; terminal and
claimable are disjoint; progress bounding drops nesting; key escaping is
injective.

**`convex/jobs.itest.ts`** — 23 tests, real runtime.

Lifecycle; illegal transitions refused at the database (a succeeded job
resists claim, fail, retry *and* cancel); idempotency including the
finished-job and cross-tenant-key cases; the concurrent double-claim and
an eight-way version; concurrent creates yielding one row; tenant
isolation across every operation, reported as not-found rather than
denied; and survival — a job interrupted mid-flight is still
discoverable, still shows its progress, and is findable as stuck.

---

## Operational consequence

Nothing is wired to this yet, by design — P1.1 adds the primitive and
changes no existing behaviour. `purgeTenant` deletes job rows, and the
schema-reading guard in `privacy.itest.ts` was extended to cover the new
table (it would have failed the build otherwise, which is what it is
for).

The next phases consume it:

- **P1.2 idempotency** — callers switch from `scheduler.runAfter` to
  `createJob` + schedule-if-created.
- **P1.3 retry** — reads `attempt`/`maxAttempts`, writes `nextAttemptAt`,
  moves jobs `running → retrying` and decides when to re-schedule.
- **P1.4 webhooks** — `idempotencyKey` from the Shopify event id makes
  duplicate delivery a no-op.

## Rollback

Revert the commit. The table is additive, nothing reads or writes it in
any existing path, and no behaviour outside `convex/jobs.ts` changed.
The only edits outside the new files are the `jobs` block in
`schema.ts`, the purge loop in `tenants.ts`, and the guard list in
`privacy.itest.ts`.
