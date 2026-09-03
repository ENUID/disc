# Stripe event ledger and ordering (P1.5)

Replay-safe, order-safe billing state.

**Scope:** Stripe webhook processing. No pricing change, no Stripe
product configuration, no move to Shopify Billing — that remains a future
App Store concern, and `lib/billing.ts` already records why.

---

## UNKNOWN, recorded before anything else

> **Reliable cross-event freshness ordering requires a monotonic version
> on the subscription object or a trustworthy event sequence number.
> Stripe provides neither to a webhook consumer.**

This is the stop condition from the phase brief, and it was reached. The
evidence:

- Stripe's webhook documentation states: *"Stripe doesn't guarantee the
  delivery of events in the order that they're generated… Snapshot events
  record `created` in seconds, so distinct events can share a timestamp.
  **Don't use `created` to determine event order** or whether you've
  already processed an event. Track event IDs to identify duplicate
  deliveries instead."*
- A Stripe Subscription object carries `created`, `current_period_*`,
  `canceled_at`, `ended_at` and `status` — but **no `updated` field and
  no version counter**. There is nothing on the object that distinguishes
  a newer snapshot from an older one.

So P1.5 does **not** implement a timestamp comparison. `event.created` is
stored for audit and never compared by anything.

**What was built instead** is a state-machine guard derived from what
Stripe's semantics make *impossible*, which needs no clock. It closes the
case that matters — access being re-granted after a cancellation — and
leaves a documented residual below.

**The known remedy for the residual**, from Stripe's own guidance
(*"You can also use the API to retrieve any missing objects"*): fetch the
subscription from the Stripe API at processing time and apply that
instead of the payload. That is authoritative and order-independent. It
is deliberately **not** in this phase — it adds a network call and a
credential dependency to the billing path, and the brief said to stop and
report rather than expand scope. It is the right shape for a later phase.

---

## The four signals, and which are used

| Signal | Stripe's meaning | Used for |
| --- | --- | --- |
| `event.id` (`evt_…`) | unique per event | **deduplication** |
| `event.created` | when generated, whole seconds | **audit only** — never ordering |
| subscription `status` | current state of that subscription | the value applied |
| subscription `id` (`sub_…`) | which subscription | **transition identity** |

The subscription id doing ordering work in place of a timestamp is the
whole trick of this phase.

---

## The flow

```
verify signature ──fail──▶ 401, nothing recorded
   ↓
parse JSON ──fail──▶ 400
   ↓
extract event.id ──absent──▶ 400
   ↓
[1] already processed?          ← event.id
   ↓ yes ──▶ 200, no row, no transition
   ↓ no
[2] interpret ──unhandled──▶ record, 200
   ↓
[3] resolve tenant ──unresolved──▶ record, 200
   ↓
[4] transition guard ──refused──▶ record with reason, 200
   ↓
[5] applyStripeEvent
   ↓
[6] record as applied
   ↓
200
```

Steps 1–6 are **one mutation**. The asymmetry that forces it:

```
ledger written, state not applied
   -> Stripe's retry is deduplicated and the billing change is lost
      FOREVER. A merchant pays and never gets access, or cancels and
      keeps it.

state applied, ledger not written
   -> Stripe's retry re-applies the same state. Harmless: applying a
      status twice is the same as applying it once.
```

`applyStripeEvent` remains the **only** place that changes cached
subscription state. `recordStripeEvent` decides *whether* to call it and
calls it inside the same transaction, so that invariant is preserved
rather than worked around.

### Why a missing event id is a 400

Unlike a Shopify delivery — where losing deduplication costs a duplicate
catalog read — a Stripe event that cannot be identified is one that can
be **replayed to re-grant access**. Refusing is the safe direction, and
Stripe always sends an id, so this is the defensive branch rather than an
expected one.

---

## The transition guard

Not a timestamp comparison. A rule about what Stripe's semantics make
impossible.

**The principle: refuse only changes that no ordering of events could
justify.** Everything else is allowed, because guessing would be worse
than the ambiguity.

Two such changes exist:

### 1. Reviving a terminal subscription — `revives_terminal`

The same subscription id is `canceled`, and a later event claims it is
`active` or `trialing`. That cannot be true at any point after the
cancellation: a Stripe subscription that is deleted is gone, and a
merchant who resubscribes gets a **new** subscription with a **new id**.
So the event is stale by construction rather than by clock.

**This is the centrepiece.** It is exactly the reversed delivery:

```
customer.subscription.deleted  ->  canceled
checkout.session.completed     ->  trialing   ✗ refused
```

`checkout.session.completed` carries `object.subscription`, so the guard
can tell it concerns the cancelled subscription rather than a new one.

Terminal statuses are `canceled` and `incomplete_expired`. `past_due` and
`unpaid` are **not** terminal — a merchant can fix a card, and treating
those as terminal would permanently lock out a paying customer whose
payment briefly failed.

### 2. Cancelling a subscription the tenant no longer holds — `cancels_superseded`

A terminal event arrives for a *different* subscription than the tenant's
current one. Whatever the delivery order, cancelling subscription A says
nothing about subscription B, and acting on it removes access from a
merchant who is paying.

### The deliberate asymmetry

A **non-terminal** event for a different subscription **is** allowed. A
merchant genuinely resubscribing must not be locked out by a rule written
to protect them, and an upgrade that creates a new subscription rather
than editing the old one must not be refused. The failure mode of
refusing — a paying merchant with no access — is worse than the ambiguity
it would resolve.

### The residual, stated plainly

Among **live** statuses (`trialing`, `active`, `past_due`, `unpaid`,
`incomplete`, `paused`) for the **same** subscription, transitions are
genuinely bidirectional and Stripe gives no ordering signal. An
out-of-order pair there can leave the wrong final state — for example a
stale `active` arriving after a real `past_due`.

Not guessed at, per the stop condition. Three things bound it: the states
involved all still entitle or all still deny in the same direction for
most pairs, Stripe redelivers the current state on subsequent lifecycle
events, and the remedy above (fetching the subscription) resolves it
properly when it is worth doing.

---

## Tenant resolution

Unchanged from the existing implementation, and deliberately narrow:
`metadata.tenantId`, then `client_reference_id`. Checkout sets both plus
`subscription_data[metadata][tenantId]`, so subscription events carry it
too.

**The tenant is never guessed from a customer id.** That mapping is not a
trusted input, and inventing one would let a stray event move a tenant
that never named itself. There is a test that sends an event carrying a
customer id Disc already knows and asserts nothing happens.

A malformed tenant id is normalised to nothing and recorded as
`ignored_unresolved` — a `v.id` validator would throw, turning junk
metadata into a 500 that Stripe then retries forever.

---

## Outcomes and status codes

| Outcome | Meaning | HTTP |
| --- | --- | --- |
| `applied` | subscription state changed | 200 |
| `ignored_unhandled` | an event type Disc does not act on | 200 |
| `ignored_unresolved` | no tenant could be safely resolved | 200 |
| `ignored_stale` | refused by the guard, with a reason | 200 |
| *(duplicate)* | already in the ledger; no new row | 200 |

Everything verified answers **200**. Stripe retries a non-2xx, and every
one of these stays the same on redelivery — a non-2xx would be an
infinite retry of an event whose only correct outcome is to be ignored.

**401** is a failed signature; **400** is a malformed body or a missing
event id. Neither writes a row.

Unknown event types stay harmless: recorded, never interpreted
speculatively, never retried forever merely because Disc does not care
about them.

---

## Auditability

The ledger answers, per event: was it received, was it processed, was it
ignored and why, which tenant it resolved to, what type it was, what
status it applied, which subscription it concerned, and when.

`claimedTenantId` keeps what the metadata said even when it resolved to
nothing, so an unresolved event is diagnosable rather than anonymous.

**No secrets.** No authorization headers, no signing secret, no raw
request. A test serialises the whole ledger and asserts the webhook
secret, `whsec`, and `authorization` appear nowhere in it.

---

## Concurrency

Deduplication is a read-then-insert on `by_event_id` inside one mutation
— the same pattern as `enqueue` (P1.2) and the Shopify ledger (P1.4).

**What the test proves:** the guard is correct. Five concurrent
deliveries of one event produce one row and one transition.

**What it does not prove:** Convex's isolation. As recorded in
`PRODUCTION_JOB_STATE.md`, `convex-test` cannot be made to distinguish
interleaving from end-to-end serialisation from outside. Exactly one row
under real concurrency rests on Convex's documented serializable
isolation of mutations. Convex has no unique constraint, so there is no
second line of defence.

---

## Retention and purge

`STRIPE_EVENT_RETENTION_DAYS`, default **45**
(`DISC_STRIPE_EVENT_RETENTION_DAYS`) — longer than the Shopify ledger's
14, for a specific reason: Stripe permits a **manual resend for up to 30
days** from the dashboard and CLI, and a ledger that has forgotten an
event cannot deduplicate its replay. A replayed
`checkout.session.completed` is precisely the event that re-grants
access, so the retention window must outlive Stripe's resend window with
margin.

`purgeTenant` deletes a tenant's resolved events. Rows that never
resolved to a tenant are not tenant data and age out by retention
instead. The schema-reading guard in `privacy.itest.ts` flags any table
with a `tenantId` field, so `stripeEvents` had to be added to both
`TENANT_OWNED` and `purgeTenant` — which is what that guard is for.

No file storage is referenced by this table, so the guard's known blind
spot does not apply here.

---

## Exact code paths

**New**

- `stripeEvents` table, three indexes.
- `convex/billing.ts` — `recordStripeEvent`, `purgeExpiredStripeEvents`.
- `convex/lib/billing.ts` — `SUBSCRIPTION_STATUSES`,
  `TERMINAL_SUBSCRIPTION_STATUSES`, `isTerminalSubscriptionStatus`,
  `guardStripeTransition`.

**Changed**

| File | Change |
| --- | --- |
| `convex/http.ts` | the Stripe route extracts the event id and hands off to `recordStripeEvent`; it no longer interprets or applies |
| `convex/tenants.ts` | `purgeTenant` deletes `stripeEvents` |
| `convex/privacy.itest.ts` | `TENANT_OWNED` gains `stripeEvents` |
| `convex/crons.ts` | retention sweep |
| `convex/lib/env.ts` | `STRIPE_EVENT_RETENTION_DAYS` |

`applyStripeEvent` and `interpretStripeEvent` are **unchanged**. The
existing billing tests drive `applyStripeEvent` directly and still pass,
which is the point: the state-writing primitive did not move.

---

## Tests

**`convex/lib/billing.test.ts`** — 18 (9 new). The centrepiece
cancellation-then-checkout case; every declared status checked against a
cancelled subscription; cancellations still landing on live
subscriptions; the superseded-cancel case; resubscription allowed; a new
subscription taking over from a live one; first subscriptions never
blocked; ordinary lifecycle movement untouched; the terminal set matching
what Stripe cannot walk back, and no terminal status entitling access.

**`convex/stripe-events.itest.ts`** — 24, each signing a real
`Stripe-Signature` and posting to the route. Replay (twice, ten times,
after a cancellation, of an ignored event, and five concurrent);
out-of-order cases A–F from the brief; payment failing and recovering;
unknown types; no tenant; malformed tenant id; the customer-id guess
refused; unsigned event; missing event id; the audit fields; no secrets
in the ledger; cross-tenant isolation; purge; retention.

### Negative verification

| Break | Result |
| --- | --- |
| disable event-id dedupe | **4 tests fail** |
| ledger written, state never applied | **8 tests fail** |
| bypass the stale-event guard | **4 tests fail** |
| process an unhandled event as handled | **4 tests fail** |
| mark processed before the transition | **8 tests fail** |
| `canceled` removed from the terminal set | **4 integration + 4 pure fail** |
| accept an event with no id | **1 test fails** |

All seven discriminated on the first attempt — unlike P1.3 and P1.4,
where a break initially passed and the test had to be rewritten.

---

## Operational consequence

**A dashboard resend no longer re-grants access.** This was one click,
and it was the audit finding.

**Reversed delivery no longer re-entitles a cancelled merchant.** The
specific sequence `deleted` → `checkout.session.completed` now ends
`canceled`.

**A late cancellation no longer removes access from a paying merchant**
whose subscription has since been replaced.

**One new table, one row per non-duplicate event.** Small — bounded by
billing activity, which is a handful of events per merchant per month —
swept at 45 days by the existing nightly cron.

**Two extra indexed reads per event**: the ledger lookup and the tenant
read the guard needs.

---

## Rollback

Revert the commit. The route returns to interpreting and applying
directly, `stripeEvents` becomes unread, and `applyStripeEvent` is
untouched either way so no billing state is disturbed.

What comes back with a rollback: replays re-grant access, and reversed
delivery re-entitles a cancelled merchant. Rows left behind are inert;
drop the table if the phase is not going to be re-applied.
