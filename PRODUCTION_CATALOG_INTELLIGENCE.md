# P2.2 — the catalog intelligence lifecycle

**Status: implemented.** What follows is the failure, the invariant, the
test that proves it, and how to roll it back — the same shape as the P1
documents.

The lifecycle this phase makes truthful:

```
Shopify catalog
  -> durable catalog sync
  -> durable enrichment sweep      <- was broken
  -> product intelligence
  -> Brand Brain build             <- was unconditional, and overwrote merchants
  -> merchant correction
  -> stable knowledge state
```

---

## 0. What was actually wrong

Three defects, all confirmed by measurement before anything was changed.
The first two share a root cause; the third is independent and is the
serious one.

### A. Enrichment stopped after one batch

`staleProductIds` read the FRONT of the product index on every call —
`take(limit * 4)`, no cursor, no memory of where it had been. `enrichBatch`
then decided whether to continue by calling it again with `limit: 1`,
which reads the first four products. Once those four had profiles, that
probe returned nothing and the drain loop concluded the catalog was done.

Simulated drain over a fresh 500-product catalog, before the fix:

```
pass 1: enriched 25 (total 25), remaining probe = 0
drainEnrichment STOPS after pass 1
FINAL: 25/500 enriched, coverage 0.05
```

The cascade is what made this severe rather than merely slow.
`canDeriveBrand` refuses below `MIN_COVERAGE_FOR_BRAND` (0.3), so **no
catalog above roughly 83 products ever got a Brand Brain at all**;
`brandBrainStatus` sat at `pending` forever, the "Learning your brand"
onboarding stage never completed, and 95% of the catalog scored every
compatibility dimension neutral in ranking.

### B. An edited product was never rediscovered

Same root cause. A merchant editing product 300 of 500 changed its
content, so its stored cache key no longer matched — but nothing ever
scanned past the front of the index, so the stale profile stayed. Two
webhook paths made it worse: `syncSingleProduct` re-embedded the product
and did not schedule enrichment at all, so Disc searched on the new text
while reasoning from the old attributes.

### C. A merchant's Brand Brain correction was silently discarded

`applyMerchantCorrection` wrote `source: "merchant_corrected"`, and its
comment said a later automatic rebuild "knows not to silently undo what a
human said". **Nothing read `source`.** `buildBrandBrain` called
`saveBrain` with `source: "derived"` unconditionally, which demoted the
corrected version and inserted a derived one. Measured: a correction
survived about six hours.

`PRODUCTION_ARCHITECTURE_AUDIT.md` recorded this under P2-7 as "Not a
correctness bug". That assessment was wrong and has been amended. It is
the direct violation of the repository's own stated invariant that
merchant confirmation is authoritative.

### And two more, found while fixing the above

Both were introduced by the first draft of this phase and caught by its
own tests, which is worth recording because both are the same shape as
the bug being fixed — a chain that deduplicates into its own past.

- **A completed sweep could not start the next one.** Completion resets
  the cursor and the enriched count, so the first window of sweep N+1
  derived exactly the key the first window of sweep N used, deduplicated
  into that finished job, and scheduled nothing. A catalog would have
  enriched once after install and never again.
- **A time-bucketed Brand Brain key suppressed real rebuilds.** Keyed on
  a five-minute bucket (copied from `catalogSyncKey`), two genuine
  knowledge changes inside one window collapsed into one job and the
  second deduplicated into a finished build — leaving the brain stale
  with nothing scheduled to fix it.

---

## 1. Enrichment discovery: a resumable cursor

`scanForEnrichment` replaces `staleProductIds`. It pages the product
index with **Convex's own pagination cursor** — the same mechanism
`catalog.countPage` already uses, rather than a second pagination scheme
— and the cursor is persisted on the tenant as `enrichmentCursor`.

```
SCAN_PAGE    = 200   products read per scan   (a read bound)
ENRICH_BATCH =  25   products enriched per run (a work bound)
```

They differ because scanning is cheap and enriching is one or two model
calls per product. A page larger than the batch means a fully-enriched
catalog sweeps in `products / 200` runs instead of `products / 25` — 25
runs rather than 200 on a 5,000-product catalog, for the same result.

**A page is never advanced past unexamined products.** The whole page is
examined, then the batch bound is applied. If the page held more stale
products than one run may enrich, the cursor stays where it is and the
next run works the same page.

**Holding a page requires progress.** `heldPage = remainingInPage > 0 &&
enriched > 0`. Without the second clause, a page of permanently-failing
products is an infinite loop. With it, a product that keeps failing is
left stale and picked up by the next sweep — forward progress beats
retrying the same failure forever, and the job's retry policy is the
mechanism for genuine transient failure.

**Sweep completion resets to the beginning** and increments
`enrichmentSweep`.

## 2. `remaining` is counted, never inferred

`scanForEnrichment` returns `remainingInPage` — stale products it saw in
this page that the batch bound left behind. It is a count of what was
examined, not the result of a second probe somewhere else in the index.

The loop condition is `pageIsLast`, a fact about the scan. The window
action returns `{ ran, enriched, sweepComplete }` rather than leaving
callers to infer state from the cursor, because **a null cursor means
both "no sweep running" and "a sweep holding the first page"** and
nothing should have to guess which.

That ambiguity is also why the reconciliation query does not use the
cursor: `needingIntelligenceWork` reads `productCount > enrichedCount`
off the P1.6 counters, which is O(1) per tenant and has no such
ambiguity.

## 3. Enrichment is a durable job

`product_enrichment` and `brand_brain_build` are now wired into
`scheduleWorker`; they were declared in `JOB_TYPES` and threw. Both go
through `enqueue`, so both get the full P1 machinery: claimed before
running, classified on failure, bounded retry with backoff, and recovery
by the stale-job sweeper.

Before this, the chain was `ctx.scheduler.runAfter` with no job row. An
action that died mid-catalog left no record, nothing retried it, and two
catalog syncs finishing together started two concurrent drains over the
same products. That is what closes audit finding **P1-2**.

**Idempotency key** — `enrichmentKey(tenantId, sweep, cursor, enriched)`.
Three discriminators, each covering a gap the others leave:

| part | advances when | covers |
| --- | --- | --- |
| `sweep` | a sweep completes | one pass vs. the next — without it, sweep 2 deduplicates into sweep 1's first job |
| `cursor` | a window moves to the next page | ordinary forward progress |
| `enriched` | a window holds a page | the case the cursor cannot, since a held page repeats it |

The cursor advance and the next window's enqueue happen in ONE mutation,
so a sweep can never be left with an advanced cursor and nothing coming
— which is indistinguishable from a finished sweep.

## 4. Merchant correction outranks derived inference

The hard invariant. Implemented as the smallest change that keeps the
versioned, immutable architecture:

- `brandBrains.correctedFields` records WHICH fields a merchant set, not
  merely that they set something. Corrections accumulate.
- `saveBrain` reads the current version. If it is `merchant_corrected`,
  those fields are carried forward verbatim, the new version stays
  `merchant_corrected`, and confidence stays 1.
- Everything the merchant did not touch is still re-derived.

**Rebuilds are not stopped.** Freezing a brand's knowledge at the moment
it was first corrected is a different way of being wrong. Only an
explicit merchant action changes what is marked corrected.

## 5. Brand Brain rebuilds on change, not on a timer

`brandInputFingerprint(stats, promptVersion, model)` in
`lib/brand-stats.ts`, hashed with `sha256Hex` and stored as
`tenants.brandInputHash`.

**What participates in the hash, and why:**

| input | why |
| --- | --- |
| the whole `BrandStats` object | every derived field — style vector, palette, formality band, product world — is computed from it, and the model prompt is built from it |
| `promptVersion` | a changed prompt is a changed answer from identical statistics |
| model name | so is a changed model |

**What deliberately does not:** timestamps, document ids,
`lastEnrichedAt`, `updatedAt`, job ids — anything about *when* the
statistics were computed. Any of those would make every fingerprint
unique and turn this gate back into the unconditional rebuild it
replaces, silently, while everything else still looked correct.

This works because `computeBrandStats` is deterministic for determinate
reasons: `tally` breaks ties alphabetically, `sampleEvenly` walks a fixed
stride, and the object is built in a fixed key order. `brand-stats.test.ts`
pins that property.

The fingerprint is checked **before** `setBrandStatus("building")` and
before the model call, so an unchanged catalog costs one bounded read and
writes nothing at all.

### Trigger paths

```
catalog sync completes        -> enqueueEnrichment
webhook product change        -> enqueueEnrichment      (new in P2.2)
enrichment window completes   -> enqueueEnrichment      (the chain)
sweep completes, having
  enriched something, or with
  no brain yet                -> enqueueBrandBuild
hourly reconciliation         -> either, with explicit: true
```

The old path — six-hourly resync → unconditional drain → unconditional
build → unconditional `saveBrain` insert — is gone. `crons.drainEnrichment`
is replaced by `crons.reconcileIntelligence`, which exists only for what
the chain cannot recover from: a window whose retries ran out, leaving a
`failed` job the chain deduplicates into. `explicit: true` breaks that
deadlock through `retryFailedJob`, exactly as a merchant pressing Resync
does.

## 6. Bounded Brand Brain input loading

`catalogForBrand` did `take(2000)` and then one indexed profile lookup per
product — 2,000 sequential reads inside a single query, every six hours,
per tenant.

Convex has no multi-get, so the per-row join cannot become one batched
read. What it can be is **bounded**, which is the actual hazard: a query
whose read volume scales with catalog size is the shape of problem P1.6
removed from `catalogHealth`. `catalogPageForBrand` reads at most
`BRAND_SAMPLE_PAGE` (200) products and the same number of profiles, and
`loadBrandSample` walks pages up to `BRAND_SAMPLE_LIMIT` (2,000).

The sample bound was **not** raised to compensate; a test asserts it is
still 2,000. Ordering is preserved across pages, which is what keeps the
statistics — and therefore the fingerprint — stable.

---

## 7. Schema additions

Five fields, each required by one of the above.

| field | why |
| --- | --- |
| `tenants.enrichmentCursor` | cursor persistence, so a sweep is resumable |
| `tenants.enrichmentSweep` | job identity — separates one sweep's keys from the next's |
| `tenants.enrichmentSweepEnriched` | whether finishing a sweep is worth a build |
| `tenants.brandInputHash` | the rebuild gate |
| `brandBrains.correctedFields` | which fields merchant authority covers |

All optional, so rows written before this phase read as absent and
behave as "start from the beginning" / "no correction" rather than
failing.

---

## 8. Tests

`convex/intelligence.itest.ts` (26) and additions to
`convex/lib/brand-stats.test.ts` (3).

The integration tests run with no `ANTHROPIC_API_KEY`, which is not a
limitation: `reasoningProvider` returns `NullReasoningProvider` without
one and it answers `{}` rather than throwing, so the entire real pipeline
executes — cursor scan, staleness comparison, `enrichOne`, the
deterministic `ruleDerivedProfile` fallback, `saveProfile`, counter
deltas, window completion, and the chain. Only the model's opinion is
absent, and no property asserted here depends on it.

The chain is driven **through the scheduler** (`finishAllScheduledFunctions`
with faked timers), not by calling the window action in a loop. A test
that pumped it by hand would prove the window works while saying nothing
about whether one window actually reaches the next — which is exactly
where two of the bugs above lived. `Date` is deliberately left unfaked so
`updatedAt` remains real evidence that a document was written.

Coverage: 25/500 product catalogs enrich completely; a bounded scan
regardless of catalog size; truthful `remaining` at 0/10/25/120 products;
edits at the beginning, middle and end of a 300-product catalog are
rediscovered; duplicate enqueues collapse; every window of a sweep is its
own succeeded job with a distinct key; a second execution of one job is
refused; re-enrichment does not drift the counters; a build happens once
on change; unchanged inputs write nothing; a merchant correction survives
repeated automatic rebuilds while derived fields still move; sample pages
stay bounded; and tenant isolation for both enrichment and brand
derivation.

### Negative verification

Each mechanism was broken, the suite run, and the break reverted.

| break | tests failed |
| --- | --- |
| cursor never advances | 4 |
| `remaining` faked back to the old inference | 9 |
| `saveBrain` ignores `merchant_corrected` | 2 |
| fingerprint computed then ignored | 2 |
| unbounded per-product profile reads | 2 |
| chain bypasses `enqueue` for the raw scheduler | 2 |

The last one initially failed only one test. That was too thin for the
claim, so `every window of a sweep is its own durable job` was added and
the break re-run.

---

## 9. Known limitations

- **A deletion-only catalog change does not trigger a rebuild.** The
  sweep-completion gate fires on `sweepEnriched > 0`, and deleting
  products enriches nothing. The brain's product world stays slightly
  stale until the next sweep that enriches something. Accepted for now:
  it is a small, slow-moving staleness, and much better than the
  unconditional rebuild it replaces. The reconciliation cron is the
  intended home for a fix.
- **One job row per enrichment window.** A 5,000-product initial
  enrichment creates about 200. Nothing purges the `jobs` table, which is
  pre-existing (`catalog_sync` adds ~1,460 rows per tenant per year).
- **`remaining` is per-page, not catalog-wide.** Answering "how many
  stale products are left in total" needs a full scan, which is the
  request-path scan this codebase keeps out of hot paths. `pageIsLast`
  is the loop condition instead.
- **Two defects were found by reviewing this phase's own diff**, not by
  its tests, and both are now covered: `loadBrandSample` could overshoot
  the 2,000-product bound on its last page, and because `profiles` is
  sparse a trim-afterwards would have kept profiles for products outside
  the sample and inflated `coverage`; and refusing to characterise a thin
  catalog wrote `brandBrainStatus: "pending"` unconditionally, which the
  hourly reconciliation would have turned into a write per tenant per
  hour.
- **The 5,000-product case is asserted structurally, not end to end.**
  Seeding 5,000 products through the in-memory harness is slow, so the
  bounded-scan property is asserted at 2,000 and full enrichment at 500.

---

## 10. Rollback

Revert the commit. The four tenant fields and the one `brandBrains` field are
all optional and are simply ignored by the previous code, so no migration
is needed in either direction — but note that reverting restores all
three defects above, including the one that discards merchant
corrections.
