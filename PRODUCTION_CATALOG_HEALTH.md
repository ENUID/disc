# Catalog health aggregates (P1.6)

The dashboard stops reading the embedding corpus to produce eight
integers.

**Scope:** `catalogHealth` and the lifecycle writes that feed it. No
product changes, no dashboard redesign. This is the last reliability
phase; what follows is the product architecture in
`PRODUCT_DIRECTION.md`.

---

## The failure mode

`catalogHealth` computed its numbers with three unbounded `.collect()`
calls — every product, every profile, and **every embedding**:

```ts
const embeddings = await ctx.db
  .query("productEmbeddings")
  .withIndex("by_tenant_and_product", (q) => q.eq("tenantId", tenantId))
  .collect();
const embedded = new Set(embeddings.map((e) => e.productId));
```

An embedding row carries 1,536 `float64` values, roughly 12 KB. The
entire output of the function is eight integers.

| Catalog | Embedding bytes read |
| --- | --- |
| 500 (Pilot ceiling) | ~6 MB |
| 1,300 | ~16 MB |
| 5,000 (Growth ceiling) | ~60 MB |

Against a 16 MiB per-query read limit that breaks somewhere around 1,300
products — inside the Growth tier and far inside Enterprise.

**That figure is still the audit's UNKNOWN**, and it is deliberately not
load-bearing here. The fix does not tune against a threshold, it removes
the read: whatever the current limit is, reading 60 MB of vectors to
produce eight integers is wrong at any catalog size, and the arithmetic
above only establishes that the old code had a ceiling — not exactly
where it sat.
**The dashboard would fail for exactly the merchants paying the most**,
and it would present as a generic error with no indication that catalog
size was the cause. `/merchant/dashboard` calls the same function, so the
landing page failed too, not just the Catalog tab.

**The rule this establishes: no query whose output is a number may read a
corpus.**

---

## Metrics and their authoritative sources

Semantics are unchanged. Every number means exactly what it meant before.

| Metric | Definition | Source |
| --- | --- | --- |
| `total` | products in the catalog | `productCount` |
| `indexed` | products with an embedding | `embeddedCount` |
| `enriched` | products with a profile | `enrichedCount` |
| `notEnriched` | `total - enriched`, clamped at 0 | derived |
| `lowConfidence` | enriched, `completeness < 0.5` | `lowConfidenceCount` |
| `rejectedFields` | enriched, with ≥1 rejected field | `rejectedFieldsCount` |
| `unavailable` | `!anyVariantAvailable` | `unavailableCount` |
| `missingImages` | `images.length === 0` | `missingImagesCount` |

`lowConfidence` and `rejectedFields` count only products that **have** a
profile — the old loop `continue`d past unenriched products, and the new
predicates preserve that.

---

## The aggregates

Seven counters on the **tenant row**, not a new table.

**Why no new table:** the tenant document already carries `productCount`,
so the pattern exists; a per-tenant aggregate row would have identical
write contention (one row per tenant either way); and keeping them on the
tenant means `purgeTenant` removes them for free, with no new entry in
the privacy guard and no new way to leave data behind. The instruction
asked for this to be justified rather than assumed — that is the
justification.

All fields are **optional**, so a tenant row written before this phase
reads as zero rather than failing, and is corrected on the next
reconciliation.

### `products.embeddedAt`

One denormalised field, and it is the load-bearing part of the design.

"How many products are indexed" cannot be answered from
`productEmbeddings` without materialising a vector per product — which is
the exact cost being removed. `embeddedAt` puts the answer on the small
row, so **both** the live counter and the reconciliation rebuild can
establish it without ever touching the corpus.

It is also what makes the two agree: the counted transition is on the
*product's marker*, not on the embedding row's existence, so the live
path and the rebuild read the same source and cannot disagree.

---

## Lifecycle updates

Every counter change happens in the **same transaction** as the write
that caused it. `bumpCounts` is a plain function, not a mutation, for
exactly that reason — callers pass their own `ctx`.

| Event | Effect |
| --- | --- |
| product inserted | `productCount +1`, plus `unavailable`/`missingImages` if applicable |
| product updated | deltas only for predicates that changed; `embeddedAt` survives the patch |
| product deleted | undoes everything it contributed, **including its profile's** contributions |
| embedding first written | `embeddedCount +1`, `embeddedAt` set |
| embedding rewritten | **no change** |
| profile inserted | `enrichedCount +1`, plus confidence/rejected |
| profile **replaced** | `enrichedCount` unchanged; confidence and rejected re-evaluated |
| profile removed | undoes its contributions |

### Retry safety

Every event is expressed as a transition between a `before` and an
`after` state, and identical states produce a zero delta. That is what
makes a retried job harmless: it is not "every write increments", it is
"the predicate changed value".

A zero delta writes nothing at all — which also keeps a resync of an
unchanged 5,000-product catalog from performing 5,000 writes to one
document to record nothing.

### The case most easily got wrong

**A profile replacement is not a no-op.** `enrichedCount` is unchanged
because the product was already enriched, but `completeness` can cross
the threshold in either direction and `rejectedFields` can appear or
clear. Treating replacement as "nothing changed" would drift those two on
every re-enrichment — and re-enrichment happens whenever a product's
text changes. There is a test, and breaking it fails that test.

### Batched, not per row

`upsertBatch` and `saveEmbeddings` accumulate one delta across the batch
and write the tenant row once. Patching per row would mean up to 500
writes to a single document per page of a sync.

---

## Reconciliation

Maintained counters go wrong quietly. `reconcileTenant` rebuilds them
from authoritative rows.

- **Driven off `products`**, paginated. For each product it looks up the
  profile and reads `embeddedAt`. It **never reads embeddings** — the
  rebuild would otherwise be the same 60 MB scan, merely moved off the
  request path.
- Walking products rather than profiles is also what makes it agree with
  `catalogHealth`'s semantics: a profile whose product was deleted is an
  orphan, not an enriched product.
- **An action driving bounded queries**, so a large catalog is walked in
  many small reads rather than one that hits the limit this phase exists
  to avoid. Bounded at 500 pages (100,000 products by default).
- **Drift is reported, not silently healed.** A structured log line names
  each field and its before/after. Silent self-healing would hide the bug
  that caused the drift, which is the only reason to have this path.
- **Scheduled daily at 04:00 UTC**, ten tenants per run, oldest
  `catalogCountsAt` first. Never on a request path — nothing in
  `merchant.ts` calls it.

`staleCountTenants` takes a bounded slice of tenants and sorts in memory
rather than adding an index used once a night. Tenant count is small —
this is a B2B product with merchants, not consumers — and the `take(500)`
bound is what makes it visible if that stops being true.

---

## Performance contract

```
catalogHealth   ONE document read, independent of catalog size

reconcileTenant O(products + profiles), paginated, off the request path,
                never O(embeddings)
```

**What is actually established**, and nothing beyond it: `catalogHealth`
issues a single `ctx.db.get` on the tenant and reads no other table. That
is a claim about the query path, verifiable by reading the function; the
tests below prove which table it reads rather than how fast it is.

Reconciliation reads one product row and one profile row per product. It
is bounded per page and per run. No claim is made about wall-clock time.

---

## Privacy

No new table, so no change to the privacy guard. The counters live on the
tenant document, and `purgeTenant` deletes the tenant — there is no way
for them to outlive it.

`products.embeddedAt` is on a table already covered by `TENANT_OWNED` and
already purged. No file storage is referenced, so the guard's known blind
spot does not apply.

---

## Tests

**`convex/lib/catalog-counts.test.ts`** — 17, no database. Every
predicate including the exclusive confidence boundary; product appear /
disappear / change transitions; the retry no-op; profile replacement
moving confidence without moving `enriched`; clamping; absent counters
reading as zero; drift reported per field. And the property that matters
most: **`accumulate` and the deltas produce identical counts for the same
catalog** — if they diverged, the nightly sweep would "correct" correct
numbers and report phantom drift forever.

**`convex/catalog.itest.ts`** — 19, real runtime, everything driven
through the real lifecycle mutations.

### Proving the corpus is not read

Timing proves nothing stable and would be flaky. Instead the tests
**deliberately desynchronise** the embeddings table from the counter:

```
3 products, 2 embedded        -> indexed = 2
delete every productEmbeddings row directly
                              -> indexed is STILL 2
```

The old implementation derived `indexed` by collecting that table, so it
would now answer 0. This is a structural proof of *which table is read*,
which is what the invariant is about.

The 5,000-product test does the same at the scale where the old code
broke, and additionally asserts exact `unavailable` and `missingImages`
figures across the whole fixture.

### Other coverage

Small-catalog correctness (fully embedded, none embedded, partially
embedded, fully enriched, partially enriched, zero products); deletion via
both delete paths; re-embedding, re-enriching and re-upserting all
idempotent; out-of-stock in both directions; an update keeping a product
indexed; drift detected and corrected; correct counters reporting no
drift; paging through 1,200 products; an orphaned profile not counted;
the nightly sweep; tenant scoping.

`merchant.itest.ts`'s `seedProduct` was rewritten to drive the real
mutations instead of inserting rows. That is a strengthening: a fixture
writing rows directly would test a state the product can never be in, and
would pass while the counter-maintaining paths were broken.

### Negative verification

| Break | Result |
| --- | --- |
| restore the old full-embedding read | **2 tests fail** |
| profile replacement treated as a no-op | **1 test fails** |
| deletion does not undo the profile's contribution | **2 tests fail** |
| re-embedding increments every time | **1 test fails** |
| an update wipes the embedded marker | **2 tests fail** |

All five discriminated on the first attempt.

---

## Known limitations

**Counters can drift between nightly reconciliations.** A bug in a
lifecycle path shows on the dashboard until 04:00 UTC. This is inherent
to maintained aggregates; the mitigations are that every transition is
transactional with its cause, and that drift is logged per field when
corrected.

**Negative counts are clamped, which hides the sign of drift.** A
negative would render as nonsense to a merchant, so the clamp is right
for display — but it means an under-count and a large under-count look
the same until reconciliation runs.

**Orphaned profiles are pre-existing and unaddressed.** Neither delete
path removes the `productProfiles` row, so a deleted product leaves one
behind. It is a **storage** leak, not a counting bug: both
`catalogHealth` and the rebuild walk products and look profiles up, so an
orphan is never counted — there is a test asserting exactly that. Fixing
it is a behaviour change outside this phase.

**Two product scans remain on the sync path**, both pre-existing and
both off any request path: `countForTenant`, which `syncCatalog` calls to
set `productCount` at the end of a sync, and `deleteMissing`, which
collects the catalog to find what vanished. Neither reads embeddings, and
`countForTenant` now doubles as a per-sync reconciliation of the one
counter it touches. Left alone deliberately — the invariant this phase
establishes is about the health and overview request paths, and changing
ingest is not needed to hold it.

**`convex/products.ts` contains literal NUL bytes** — `tags.join("\0")`
— which makes the file read as binary to `grep` and to some editors. It
appears deliberate: joining on NUL rather than a space is a
delimiter-collision guard, so `["a b"]` and `["a","b"]` compare
differently. Pre-existing, undocumented, and not changed here. Worth
either a comment or a named constant at some point.

---

## Rollback

Revert the commit. `catalogHealth` returns to collecting three tables,
`lib/catalog-counts.ts` and `catalog.ts` become unused, and the counter
fields on tenants plus `products.embeddedAt` become unread.

Rolling back restores the failure: the Catalog and Overview pages break
above roughly 1,300 products. The counter fields left behind are inert.
