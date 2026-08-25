# Disc — data handling

Spec §92 requires this document to exist and to say seven specific
things. Each has its own heading below. Where a claim is enforced by
code, the file is named; where it is enforced by a test, the test is
named. A statement here that nothing verifies is a statement that will
eventually stop being true.

This is an engineering description of what the system does, not a legal
privacy policy. A public App Store listing needs one of those as well
(§93), and it needs to be written against this.

---

## 1. What merchant data is read

Disc reads a merchant's **product catalog** and nothing else.

Via the Shopify Admin GraphQL API, with the `read_products` scope
(`SHOPIFY_SCOPES`, `convex/shopify/admin.ts`):

| Field | Used for |
| --- | --- |
| title, description, handle, product type, vendor, tags | embedding text, attribute inference |
| price, currency | budget filtering, display |
| images | display, and vision enrichment where enabled |
| variants (id, title, price, availability) | size selection, availability as a hard filter |

Disc does **not** request and does not hold: customers, orders,
checkouts, draft orders, inventory locations, staff accounts, discounts,
or any Shopify scope beyond product read. A scope Disc never asks for is
data it cannot be compelled to leak.

Also stored per merchant, in `tenants`: the shop domain, the Shopify
Admin API access token (**encrypted at rest**, AES-GCM, see
`convex/lib/crypto.ts` — never returned by any route and never logged),
brand tokens, widget configuration, and Stripe customer/subscription
identifiers.

## 2. What shopper data is stored

No shopper identity of any kind. Disc has no accounts, sets no cookie
that identifies a person, and receives no name, email, address, payment
detail or Shopify customer id.

Three records touch shopper behaviour:

- **`shopperSessions`** — the structured state of one shopping
  conversation: occasion, formality, budget range, things to avoid,
  locked items. Keyed by whatever `session_key` the caller sends, which
  is intended to be a random per-visit value; Disc derives nothing from
  it and never links two of them. This is intent, not identity: it says
  "someone wants a wedding outfit under £400", never who. Written only
  on the `/outfit` route, which the shipped widget does not yet call —
  so on a current install this table is empty.
- **`events`** — interaction counts (spec §80's closed vocabulary:
  viewed, clicked, saved, added to cart, and so on), with product ids
  and a bounded payload. Written from the storefront, so the endpoint is
  necessarily public — which is why the accepted event types are a
  closed subset (a storefront cannot report `purchase` and inflate a
  merchant's revenue) and the payload is truncated to 20 keys of 200
  characters, one level deep (`sanitisePayload`, `convex/lib/events.ts`).
- **`modelUsage`** — how many tokens Disc spent, per day, per operation,
  per model. Cost accounting about Disc's own infrastructure; it carries
  no query text, no product ids and no shopper reference of any kind.
- **`recommendationTraces`** — what Disc recommended and why: the
  candidate set, the final set, the score components, and the prompt,
  model, ranker and schema versions in force. Contains no shopper
  identity.

Free-text queries a shopper types reach the model provider as part of
producing a result, and are recorded in the trace's request field. They
are not associated with a person.

## 3. Retention periods

| Data | Retained | Set by |
| --- | --- | --- |
| Shopper sessions | 30 days after last activity | `DISC_SESSION_RETENTION_DAYS` |
| Analytics events | 180 days | `DISC_EVENT_RETENTION_DAYS` |
| Recommendation traces | Life of the tenant | — |
| Merchant sessions (dashboard login) | 14 days, then expired and swept | `MERCHANT_SESSION_TTL_MS` |
| OAuth state | 10 minutes | `OAUTH_STATE_TTL_MS` |
| Rate-limit counters | Swept after 24 hours | — |
| AI usage rollups | 730 days | `DISC_USAGE_RETENTION_DAYS` |
| Product catalog, profiles, Brand Brain | Life of the tenant | — |

Enforced by the nightly `purgeExpired` cron (`convex/crons.ts`), which
runs each sweep in bounded batches so a large backlog drains over
several nights rather than in one mutation that exceeds its limits.

Traces are the deliberate exception. They are what makes a past
recommendation explainable — "why did Disc recommend that?" is
unanswerable once they are gone, and they cannot be backfilled — and
they carry no shopper identity, so ageing them out costs accountability
and protects nobody.

## 4. Personalization

Within a single session only. Disc adjusts to what a shopper says in
that conversation ("something less formal", "under £200", "not
leather"), and that state lives in `shopperSessions` keyed by a random
per-visit key.

There is no cross-session profile, no cross-device linking, no
behavioural profile that persists after the session expires, and no
targeting of any kind. A returning shopper is a new shopper.

## 5. Deletion

- **Merchant uninstalls the app** (`app/uninstalled`) or **Shopify
  requests redaction** (`shop/redact`): `purgeTenant`
  (`convex/tenants.ts`) deletes every row the tenant owns — products,
  embeddings, product profiles, every Brand Brain version, events,
  recommendation traces, shopper sessions, merchant sessions, and the
  AI usage rollups — and then the tenant record itself, encrypted access
  token included.

  The usage rollups are worth a note, because keeping them would be
  defensible: they hold no shopper data and no merchant business data —
  they are Disc's own infrastructure spend, the equivalent of an
  invoice. They are deleted anyway, because they are tenant-scoped and
  `shop/redact` promises that a redacted shop leaves nothing behind.
  Retaining economics across departed merchants would need a separate,
  un-scoped aggregate rather than an exception in the deletion path.
- **`customers/data_request` and `customers/redact`**: acknowledged, and
  there is genuinely nothing to act on. Disc holds no customer PII, so
  there is no customer record to export or erase. These topics are
  mandatory for every Shopify app regardless of what it stores.
- **A single product deleted**: `products/delete` removes the product
  and its embedding.

`convex/privacy.itest.ts` asserts this rather than assuming it. Its
first test reads the schema, finds every table carrying a `tenantId`,
and fails if one is not in the deletion set — so a table added later and
forgotten breaks the build instead of quietly outliving the shop that
owned it. The remaining tests seed a tenant across all nine tables,
purge it, and assert that no row anywhere still carries its id, while a
second tenant's rows are untouched.

## 6. Model and provider processing

| Provider | Sent | Purpose |
| --- | --- | --- |
| Anthropic | product text and images; shopper query text | attribute enrichment, intent parsing, styling copy |
| OpenAI | product text; query text | embeddings (`text-embedding-3-small`) |
| Stripe | merchant billing details only | subscriptions |
| Shopify | — | source of catalog data |

Configured in `convex/lib/providers.ts` and `convex/lib/embeddings.ts`,
both written as a seam so a provider can be changed or self-hosted
without touching anything that calls them.

No shopper identity is sent to any provider, because Disc holds none.
Provider API terms govern what those providers may do with data sent to
them; Disc does not opt any merchant into training on their catalog.

## 7. Cross-tenant use

**Never.** A merchant's catalog, inferred product attributes, Brand
Brain, events and traces are used to serve that merchant and no other.

This is structural rather than a policy: every tenant-owned row carries
`tenantId`, every index leads with it, `tenantId` is a filter field on
the vector index, and `convex/lib/tenancy.ts` is the single chokepoint
that resolves a request to a tenant. `convex/integration.itest.ts`'s
"cross-tenant isolation" suite asserts this through the real `search`
action, and separately that a product lookup scoped to the wrong tenant
returns nothing.

Disc does not train shared models on merchant data. Spec §92 requires an
explicit product and legal decision before that could change, and no
such decision has been made.

---

## Configuration summary

| Variable | Default | Effect |
| --- | --- | --- |
| `DISC_SESSION_RETENTION_DAYS` | 30 | Idle shopper session lifetime |
| `DISC_EVENT_RETENTION_DAYS` | 180 | Analytics event lifetime |
| `DISC_ENCRYPTION_KEY` | — | Required; encrypts Shopify tokens at rest |

## Known gaps

- No merchant-facing data export. A merchant can see their catalog
  health and analytics in the dashboard, but cannot download the raw
  events or traces.
- Retention is enforced by a nightly sweep, so a record can outlive its
  stated period by up to 24 hours plus however long the backlog takes to
  drain.
- This document describes the Convex backend. The legacy Python backend
  in `/backend` has no equivalent guarantees and must not be run against
  real merchant data.
