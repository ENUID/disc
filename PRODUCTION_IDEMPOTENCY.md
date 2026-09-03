# Idempotent scheduling (P1.2)

Duplicate triggers must not produce duplicate work. This phase makes that
true for the paths where a duplicate costs money, and deliberately leaves
the other scheduler call sites alone.

**Scope:** first attempts only. No retry, no backoff, no dead-letter, no
Shopify event ledger. P1.3 and P1.4 own those, and the ledger is
explicitly not in this commit — it is a different invariant (an *event*
seen once) resting on this one (a *job* existing once).

---

## The failure mode

Three triggers could each start a full catalog sync, and nothing stopped
two of them from running at the same time:

| Trigger | Path | What a duplicate cost |
| --- | --- | --- |
| Merchant presses Resync | `POST /merchant/resync` | Rate limit permits 4/hour, no concurrency guard at all — four clicks meant four concurrent full catalog reads and four times the embedding spend (audit P2-1) |
| Reinstall | `GET /auth/callback` | Two first ingestions racing |
| Resync cron | `resyncStaleCatalogs`, 6-hourly | `dueForResync` excludes tenants mid-sync, but a merchant clicking in the same window raced the sweep |

And one product path:

| Trigger | Path | What a duplicate cost |
| --- | --- | --- |
| `products/create` / `products/update` webhook | `POST /webhooks/shopify/products/*` | Shopify does not guarantee once-only delivery. A redelivery re-embedded the product and billed for it again |

### Root cause

Every one of these was `ctx.scheduler.runAfter(...)`, which is a
*request to run something*, not a claim on a piece of work. Nothing
anywhere asked "is this already happening?", because before P1.1 there
was no durable record that could answer.

The Shopify case is the sharpest: Shopify's own documentation says
delivery is at-least-once, so redelivery is not an edge case, it is the
documented contract, and the code treated each delivery as new work.

---

## The invariant introduced

> For one tenant, one logical operation and one logical input, at most
> one job exists, and **exactly one execution is scheduled for it**.

Two halves, and the second is the one that is easy to lose. A caller can
correctly deduplicate the row and still schedule twice — every other
assertion in the suite would pass. So the tests count
`_scheduled_functions`, not just `jobs`.

### Why the dedupe and the schedule are one mutation

The requirement was that the dedupe decision happen *before* scheduling.
`convex/scheduling.ts` satisfies it in the strongest available sense: not
earlier in program order, but in the same transaction.

```
createJob (mutation, commits)
   ... caller dies here ...
scheduler.runAfter (never happens)
```

Split across two calls, that interleaving leaves a `queued` job nothing
will ever run — a row that looks like pending work, is an orphan, and
which the *next* enqueue then deduplicates against. The work stops
silently and forever.

Convex schedules from inside a mutation transactionally: if the mutation
commits, the function is scheduled; if it aborts, neither the row nor the
schedule exists. Doing both in `enqueue` is what makes "created implies
scheduled" true rather than probable.

Three tests pin the abort direction — an unknown job type, an
unschedulable type, and a `product_embedding` missing its product id all
throw *after* the insert in program order and leave zero rows and zero
scheduled executions.

---

## Call-site classification

Every `ctx.scheduler.run*` in the repository, classified before anything
was changed. The categories are the ones the instruction specified.

Line numbers are post-change, so each is findable in the tree as it
stands.

| # | Call site | Class | Migrated |
| --- | --- | --- | --- |
| 1 | `http.ts:411` OAuth install → `syncCatalog` | **A** durable business work | yes |
| 2 | `http.ts:482` `products/create` → `syncSingleProduct` | **A** | yes |
| 3 | `http.ts:499` `products/update` → `syncSingleProduct` | **A** | yes |
| 4 | `http.ts:604` `/merchant/resync` → `syncCatalog` | **A** | yes |
| 5 | `crons.ts:65` resync sweep fanout → `syncCatalog` | **A** | yes |
| 6 | `ingest.ts:127` `syncCatalog` → `drainEnrichment` | **B** orchestration continuation | no |
| 7 | `crons.ts:93` `drainEnrichment` → itself | **B** | no |
| 8 | `crons.ts:101` `drainEnrichment` → `buildBrandBrain` | **B** | no |

No class C (maintenance/cleanup) or D (retry/recovery) call sites exist
yet. `purgeExpired` is a cron entry point, not a scheduled continuation,
and nothing retries anything — which is audit finding P1-1 and the whole
reason P1.3 exists.

### Why the class B sites were left alone

They are **continuations of work already inside a job's boundary**, not
new pieces of work someone requested. `drainEnrichment` re-scheduling
itself is a bounded batch loop making progress through one backlog; it
already has the guard that matters (`result.enriched > 0`, so a batch
that enriched nothing stops instead of spinning). Giving it an
idempotency key would mean inventing one per iteration, which is a
counter with extra steps.

More importantly, wrapping a continuation in a job row would mean two
rows for one piece of work — the sync job and the drain job — with no
relationship between them, which makes "is this tenant's enrichment
stuck?" *harder* to answer, not easier. When P1.3 gives jobs a lifecycle
that spans their continuations, that is the point to revisit this.

**A finding came out of this classification rather than the audit**:
call site 8 rebuilds the Brand Brain unconditionally on every sweep, and
`saveBrain` inserts a new version without comparing it to the one it
replaces — four paid model calls and four rows per tenant per day
regardless of whether anything changed. Recorded as **P2-7** in
`PRODUCTION_ARCHITECTURE_AUDIT.md`. Not fixed here: it is a change to the
brand path, not to scheduling.

---

## Keys — what makes two invocations the same

Key construction is where the judgement lives, so it is centralised in
`convex/scheduling.ts` rather than left to call sites.

### `catalog_sync` — tenant + 5-minute bucket

A full sync has no natural version to key on. The logical input is just
the tenant, and the same tenant is legitimately synced again six hours
later, so the key carries a coarse time bucket.

Five minutes collapses four permitted Resync clicks into one job and
leaves the six-hourly cron unaffected. The cost is that a genuinely
wanted resync inside the window is suppressed — acceptable because the
work is idempotent in effect: the catalog is re-read from the same source
and lands in the same place, so suppressing it loses a duplicate read and
nothing else.

The bucket boundary is a heuristic — two triggers a second apart can
straddle an edge and produce two jobs. **The guarantee that matters does
not rest on it.** No *concurrent* duplicate is prevented by the claim in
P1.1, not by the bucket.

### `product_embedding` — tenant + product + `updated_at`

Shopify's `updated_at` changes when and only when the product does. Two
deliveries of one edit carry the same value and collapse; a later genuine
edit carries a new one and gets its own job.

`productDiscriminator` falls back to `nots-${Date.now()}` when the field
is missing rather than to the product id, and the asymmetry is
deliberate: keying on the id alone would make every edit of a product
look like the same work and permanently suppress real updates. **Losing
dedupe is recoverable; losing an update is not.** A dedupe that swallows
a real change is a worse bug than the duplicate it prevents, and there is
a test for exactly that direction.

P1.4 replaces the discriminator with the Shopify event id, which answers
the same question more strongly: two deliveries of one event stay
identical even if the product changed again in between.

### Cross-tenant safety

Every key starts with the tenant id, and the index is
`by_tenant_and_idempotency` — so tenant scope is enforced by the lookup
itself, not only by the key's content. `enqueue` also rejects an unknown
tenant before inserting anything.

`idempotencyKey()` escapes `%` then `|` before joining parts (P1.1), so
`["a", "b|c"]` and `["a|b", "c"]` cannot collide. That mattered more than
it looked: for webhooks, a collision means one product's update silently
suppressing another's.

---

## Exact code paths changed

**New — `convex/scheduling.ts`**
- `enqueue` — create-or-get then schedule-if-created, one mutation
- `scheduleWorker` — explicit `switch` on job type; a type with no branch
  **throws** rather than creating a row nothing will run
- `catalogSyncKey`, `productSyncKey`
- `enqueueCatalogSync`, `enqueueProductSync`

**Changed**

| File | Line | Before | After |
| --- | --- | --- | --- |
| `convex/http.ts` | 411 | `scheduler.runAfter(0, ingest.syncCatalog)` | `runMutation(scheduling.enqueueCatalogSync)` |
| `convex/http.ts` | 438 | — | new `productDiscriminator()` helper |
| `convex/http.ts` | 482 | `scheduler.runAfter(0, ingest.syncSingleProduct)` | `runMutation(scheduling.enqueueProductSync)` |
| `convex/http.ts` | 499 | same | same |
| `convex/http.ts` | 604 | `scheduler.runAfter(0, ingest.syncCatalog)`, `{ status: "queued" }` | `enqueueCatalogSync`, `{ status: "queued", deduplicated }` |
| `convex/crons.ts` | 65 | `scheduler.runAfter(0, ingest.syncCatalog)` | `runMutation(scheduling.enqueueCatalogSync)` |

Nothing else changed. No worker was modified, no schema field added, no
existing test altered.

### The one API change

`POST /merchant/resync` gains a `deduplicated` boolean. Additive — the
existing `status: "queued"` is unchanged, so no client breaks — and it
exists because the alternative is lying: a merchant who clicks twice
should not be told two syncs started (spec §18, don't fake progress).

---

## Tests

`convex/scheduling.itest.ts` — 26 tests.

**The core invariant.** Same key → same job. Two racing callers → one
`created: true`, one row, **one scheduled execution**. Eight racing
callers → the same.

**Suppression across every job state.** A duplicate is refused against a
`running` job, a `retrying` job, a `succeeded` job and a `failed` job,
and in each case the scheduled count stays at 1. The `retrying` case
matters for the phase after this one: the retry policy owns
re-scheduling, and an enqueue must not race it. The `failed` case is the
one that could be argued either way — re-driving a failed job is the
retry policy's decision, never a side effect of someone asking for the
work again.

**What counts as different work.** A later edit is not suppressed by an
earlier one. A redelivery is. Different products are different jobs. The
same logical key under two tenants is two jobs owned by two tenants. A
catalog sync in a later time bucket is new work.

**The migrated call sites, through the real HTTP routes.** `t.fetch`
drives the actual `httpAction`s:

- four `POST /merchant/resync` clicks → one job, one scheduled execution,
  and exactly one response with `deduplicated: false`
- two tenants resyncing → two jobs, two distinct owners
- an unauthenticated resync → 401, zero jobs, zero scheduled
- a redelivered `products/update` → one job
- a genuinely later `products/update` → two jobs
- a forged webhook → 401, nothing scheduled

These exist because of a gap I found in my own first pass: the tests
below them call `enqueueCatalogSync` directly, which proves the primitive
but **not the migration** — reverting a route to `scheduler.runAfter`
would have left them all green.

Verified by doing it. Reverting `/merchant/resync` and
`products/update` to `scheduler.runAfter` fails **4 tests**; restoring
returns 26/26. The webhook tests sign with an independent HMAC
implementation rather than importing `lib/crypto`, so a passing signature
is evidence rather than the verifier agreeing with itself.

**Guards.** An unschedulable job type, an unknown job type, a
`product_embedding` with no product id, and an unknown tenant each throw
and leave zero rows and zero scheduled executions.

### What this proves, and what it does not

The concurrent tests prove the **guard is correct**: given the read and
the insert in one mutation, exactly one caller creates and exactly one
schedules.

They do **not** prove Convex's isolation. As recorded in
`PRODUCTION_JOB_STATE.md`, I could not distinguish from outside whether
`convex-test` interleaves two mutations or serializes them end to end —
one winner is the observed result either way. Uniqueness under *real*
concurrency rests on Convex's documented serializable isolation of
mutations, a platform guarantee this code depends on rather than one
these tests verify. Convex has no unique constraint, so there is no
second line of defence; if that guarantee did not hold, the fix would be
a compare-and-set against a version field.

---

## Operational consequence

**Duplicate syncs stop.** The immediate saving is on `/merchant/resync`,
where a merchant clicking through a stalled-looking install could
previously trigger four concurrent catalog reads and four times the
embedding spend.

**A suppressed request now looks different.** `/merchant/resync` returns
`deduplicated: true` instead of silently starting a second sync. The
dashboard does not surface it yet.

**One behaviour genuinely regressed, and it is the honest cost of this
phase.** A merchant whose catalog sync *failed* previously got a fresh
sync from the next Resync click. Now the failed job holds its
idempotency key until the 5-minute bucket rolls over, so that click
returns `deduplicated: true` and does nothing.

This is deliberate — re-driving a failed job has to be the retry policy's
decision, not a side effect of someone asking again, or the same crash
loops on every click. But until P1.3 exists there **is** no retry policy,
so for up to five minutes a failed sync is simply not retryable by hand.
The bucket width bounds the damage, and P1.3 closes it properly by
re-driving the failure itself. Anyone considering widening
`CATALOG_SYNC_DEDUPE_MS` before then should know this is what they would
be widening.

**Job rows now accumulate on the shipping path.** Bounded by triggers,
not by catalog size: catalog syncs are capped by the 5-minute bucket and
the 4/hour rate limit; product jobs are one per product edit. A tenant
editing 200 products a day creates 200 rows a day. Nothing prunes them
yet — `purgeTenant` deletes them on uninstall, and a retention sweep
belongs with the retry phase that decides when a job is finally over.

**Nothing about timing changed.** Every migrated call site still
schedules with `delayMs: 0`. No new delay, no queue, no worker pool, no
change to the order anything runs in.

**Workers are unchanged.** `syncCatalog` and `syncSingleProduct` receive
the same arguments they did before and do not know a job row exists.
`jobId` is threaded through `scheduleWorker` and deliberately unused —
claiming is P1.3, and adding the parameter later would mean changing
every scheduled signature at the point of highest risk.

---

## Rollback

Revert the commit. `convex/scheduling.ts` is new and nothing else imports
it; the six changed lines return to `scheduler.runAfter` and behaviour is
exactly what it was, including the duplicate syncs.

The `jobs` table (P1.1) is untouched by this revert and stays. Job rows
written before a rollback become inert — nothing reads them, and
`purgeTenant` still cleans them up.

The one thing that does not revert cleanly is the `deduplicated` field in
the `/merchant/resync` response. It is additive, so removing it breaks
nothing, but a client that started reading it would see it disappear.
Nothing reads it today.
