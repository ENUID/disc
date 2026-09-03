# Shopify webhook identity and ordering (P1.4)

Delivery deduplication and resource freshness, kept apart.

**Scope:** Shopify webhooks only. No Stripe ledger (P1.5), no
`catalogHealth` aggregates (P1.6), no content or video topics — those
belong to the deferred product architecture in `PRODUCT_DIRECTION.md`.

---

## The correction this phase is built on

An earlier proposal was to *replace* `productDiscriminator`'s
`updated_at` with the Shopify event id. **That was wrong**, and the
design changed before any code was written.

Shopify exposes four signals, and they are not interchangeable:

| Signal | Means | Used for |
| --- | --- | --- |
| `X-Shopify-Webhook-Id` | unique per **delivery** | delivery deduplication |
| `X-Shopify-Event-Id` | shared across deliveries from **one merchant action**, including across different subscriptions | correlation **only** |
| `X-Shopify-Triggered-At` | when the event fired | ordering, where the resource has no version |
| `payload.updated_at` | the **resource version** | resource freshness |

An event id is an *identity* primitive, not an *ordering* primitive.
Deduplicating on it would be actively harmful: one merchant action fans
out to every subscribed topic, so the second delivery is a different
topic, not a duplicate — and dropping it silently loses a topic.

Shopify states plainly that **ordering is not guaranteed** and
**delivery is not guaranteed**. Both facts shape what follows.

---

## Two questions, two answers

```
verify HMAC
   ↓
parse delivery headers
   ↓
resolve tenant  ──unknown──▶ 200, nothing recorded
   ↓
[1] have we processed THIS DELIVERY?      ← webhook id
   ↓ yes ──▶ 200, no-op, no new row
   ↓ no
[2] is this event newer than what we applied?   ← resource timestamp
   ↓ stale ──▶ record as stale, 200, do not apply
   ↓ fresh
[3] do the work — enqueue the durable job
   ↓
[4] write the ledger row
   ↓
200
```

Steps 1–4 are **one Convex mutation**. Same structural reason as P1.2:

```
ledger says processed, no work scheduled
   -> Shopify's retry is deduplicated and the update is lost FOREVER

work scheduled, no ledger row
   -> Shopify's retry re-enqueues, and the job key collapses it. Harmless.
```

Those are not symmetric, and the first is unrecoverable without a
reconciliation sweep. One transaction means neither can happen.

### Three layers, each catching what the others cannot

```
webhook id  ->  the same delivery, twice
timestamp   ->  an older version, arriving late
job key     ->  the same version, arriving by a different route
```

This is **not** a second deduplication mechanism competing with job
idempotency. `productSyncKey` is unchanged and still keyed on the
resource version. The layers compose: two deliveries of one merchant
action to two topics both pass the ledger (different webhook ids) and
both pass freshness (equal version is not stale), then collapse into one
job because they describe the same version.

---

## Freshness in detail

### One comparable quantity

`updated_at` is a resource **version**; `triggeredAt` is a **wall clock**.
Comparing one against the other would be comparing a version to a clock
and calling the result an order. So `eventTime()` picks one scale:

```
resource version  ->  triggered-at  ->  received-at
```

The version wins wherever it exists, because that is also what
`products.sourceUpdatedAt` holds — making the comparison like-for-like.
`triggeredAt` covers events with no version, which in practice means
deletes. `receivedAt` is the last resort: an event that can be ordered
against nothing is treated as current and therefore applied, because
losing an ordering guarantee is recoverable and discarding a real update
is not.

### Timestamps are parsed, never string-compared

Shopify emits offsets rather than always-UTC. `2026-08-26T09:00:00-04:00`
sorts *before* `2026-08-26T12:00:00+00:00` lexicographically while being
an hour *later* in real time. A string comparison would present as "a
real update was discarded as stale" — the worst outcome this phase can
produce. `Date.parse`, with a test pinning exactly that pair.

### Strictly older, not older-or-equal

An equal timestamp with a *different* delivery id is a second delivery of
the same version, not a duplicate delivery. Discarding it would drop work
on the strength of a timestamp that only says "same version". Letting it
through costs nothing — the job key collapses it.

### Where "what we already applied" comes from

Two sources, because neither alone is sufficient:

- **The ledger** survives a delete. After `products/delete` there is no
  product row left, so a late `products/update` would look like a
  brand-new product and be **re-created**. The ledger remembers.
- **The product row** (`products.sourceUpdatedAt`) survives ledger
  retention and covers every product that arrived by catalog sync rather
  than by webhook — which on a fresh install is all of them. Without it,
  the first webhook for a synced product would always look fresh.

The higher of the two wins. `sourceUpdatedAt` was ingested and never read
— audit P1-4 called it "dead weight". This is the purpose it was written
for.

### The O(1) lookup

The resource index is `[tenantId, resourceId, appliedEventAt]`, walked
descending, first row taken. Rows that were **not** applied carry
`appliedEventAt: 0`, which sorts below every real event time, so they can
never be mistaken for the last applied state. No scan, no filter, and no
"take the last N and hope" constant whose correctness depends on N.

An acknowledgement never advances the watermark. Without that, a GDPR
no-op would start suppressing real product updates.

---

## Status codes

Every verified delivery gets **200**, including duplicates and stale
events. Shopify retries a non-2xx, and both would still be duplicate or
stale on redelivery — refusing them would produce an infinite retry of an
event whose only correct outcome is to be ignored.

**401** is reserved for a failed HMAC. A forged delivery writes nothing.

A delivery for an unknown shop is **200** and records nothing: it causes
no work in any case, so there is nothing to deduplicate.

---

## Reconciliation is still load-bearing

Shopify does not guarantee delivery. Nothing in this phase changes that,
and Shopify's own guidance is to reconcile periodically. The six-hourly
`resyncStaleCatalogs` sweep remains the backstop for events that never
arrive at all, and `deleteMissing` remains the backstop for deletes that
were missed.

Two residual cases it covers, stated rather than engineered around:

- A `products/create` for a product whose `products/delete` was never
  delivered. Freshness cannot help — there is no record of a delete that
  never arrived.
- Anything older than `WEBHOOK_RETENTION_DAYS` where the product row is
  also gone.

---

## Exact code paths

**New**

- `convex/lib/webhooks.ts` — `parseDeliveryHeaders`, `parseTimestamp`,
  `eventTime`, `isStale`, `NOT_APPLIED`. Pure.
- `convex/webhooks.ts` — `recordDelivery` (the whole decision, one
  mutation), `lastAppliedAt`, `purgeExpiredDeliveries`.
- `webhookDeliveries` table with four indexes.

**Changed**

| File | Change |
| --- | --- |
| `convex/http.ts` | `shopifyWebhook` takes a topic + an action-producing function instead of a handler; routes now *describe* what a topic means and never perform work outside the checks |
| `convex/tenants.ts` | `purgeTenant` deletes `webhookDeliveries` |
| `convex/privacy.itest.ts` | `TENANT_OWNED` gains `webhookDeliveries` |
| `convex/crons.ts` | retention sweep in `purgeExpired` |
| `convex/lib/env.ts` | `WEBHOOK_RETENTION_DAYS`, default 14 (`DISC_WEBHOOK_RETENTION_DAYS`) |

`productSyncKey` and `productDiscriminator` are **unchanged**. The
correction meant less change, not more.

### Why routes return an action instead of doing work

`shopifyWebhook` now takes a function producing a typed action
(`product_sync`, `product_delete`, `purge_tenant`, `acknowledge`) rather
than a handler that performs one. A route doing its own work would be
doing it *outside* the deduplication and freshness checks, which is the
exact shape of the bug this phase removes. The union is explicit rather
than a callback for the same reason `scheduleWorker` is an explicit
switch — and because for `purge_tenant` a callback would mean a
destructive operation smuggled through a dedupe path.

`products/create` and `products/update` map to **identical** actions,
deliberately. Ordering is not guaranteed across topics for one resource,
so an `update` can arrive before the `create` it followed; treating them
differently would let arrival order change the outcome. Both re-read the
product from Shopify, so whichever lands first produces correct state.

---

## Tests

**`convex/lib/webhooks.test.ts`** — 12, pure. The offset trap;
`parseTimestamp` rejecting what it cannot read; each of the four signals
read from its own header; `eventTime` precedence; `isStale` including the
equal case; the sentinel ordering the O(1) lookup depends on.

**`convex/webhooks.itest.ts`** — 22, every one driving a real
HMAC-signed request through the actual route, because the status code is
part of the contract. Deduplication including a six-way concurrent retry
storm and the no-header case; the event id applying twice across two
topics and never deduplicating; out-of-order updates; the timezone pair;
later edits never suppressed; same version by two routes; the
catalog-synced fallback in both directions; deletes ordered by trigger
time; **a late update not resurrecting a deleted product**; GDPR
acknowledgement not advancing the watermark; uninstall purging the ledger
and a redelivered uninstall being harmless; forged delivery recorded
nowhere; two kinds of cross-tenant collision; retention.

### Negative verification

Each break applied to working code, suite run, reverted:

| Break | Result |
| --- | --- |
| dedupe key is the event id (stored **and** looked up) | **2 tests fail** |
| no delivery deduplication at all | **2 tests fail** |
| no freshness check | **4 tests fail** |
| timestamps compared as strings | **8 tests fail** |
| freshness from the product row only | **3 tests fail** |
| freshness from the ledger only | **1 test fails** |
| acknowledgements advance the watermark | **1 test fails** |
| `isStale` uses `<=` | **1 test fails** |

**The first attempt at the event-id break caught nothing**, and the break
was wrong rather than the test: it changed the *lookup* to the event id
while still *storing* the webhook id, so the two never matched and the
mechanism was inert. A faithful break — storing and looking up the same
field — fails the two tests it should. Recorded because a break that
passes is only evidence when you have confirmed the break was real.

---

## Operational consequence

**A Shopify retry storm now costs one job instead of N.** Previously
every redelivery re-enqueued; the job key collapsed identical versions,
but a redelivery arriving after the first job finished created a second.

**Out-of-order deliveries stop corrupting state.** The concrete case: an
`update` arriving after a `delete` re-created the product. It is now
recorded as stale.

**One new table, one row per applied or stale delivery.** The
fastest-growing table this phase adds — bounded by merchant edit volume,
not catalog size — swept at 14 days by the existing nightly cron.
Duplicates write no row.

**One extra indexed read per product delivery** (the freshness lookup),
plus one product lookup. Both are indexed point reads.

---

## Rollback

Revert the commit. `convex/lib/webhooks.ts`, `convex/webhooks.ts` and the
two test files are new; the `webhookDeliveries` table becomes unread.
`http.ts` returns to handlers that act directly, `productSyncKey` is
untouched either way, and duplicate and out-of-order deliveries resume
being applied as they arrive.

Rows left behind are inert. Nothing else reads them, and `purgeTenant`
would no longer clear them — so a rollback should be followed by dropping
the table if it is not going to be re-applied.
