# Disc — production architecture audit

**Phase 0 deliverable. No code was changed to produce this.**

Scope: every source file under `convex/`, `convex/lib/`, `frontend/`,
`dashboard/`, `scripts/`, `evaluation/`, plus `backend/` read only to
identify obsolete behaviour and migration hazards.

Method: call paths were traced, not inferred from filenames. Every
finding below cites the file and function it came from, and several
correct assumptions I held before tracing. Where I could not verify a
claim offline it is marked **UNKNOWN** rather than asserted.

Baseline: `Disc audit.md` was the gap analysis against the spec. This is
a different question — the spec gaps are closed; this asks whether the
result survives contact with production. Those are not the same audit and
passing the first does not imply the second.

---

## 0. Summary

The architecture is sound. The decision pipeline is correctly staged, the
tenant boundary is real and tested, source facts and model inference are
genuinely separated, and the evaluation suite is a merge gate rather than
a report. None of that needs rewriting.

What is missing is the operational layer: **nothing retries, nothing is
idempotent under duplicate delivery, no background work has a durable
record, and the storefront fails open in the one direction it must never
fail.**

Severity counts: **2 P0**, **6 P1**, **7 P2**, **1 P3**.

The two P0s are both in the widget, and both invert promises this repo
documents elsewhere as guaranteed.

**P2-7 was added after this audit was written**, during the P1.2
call-site classification. It is left in place rather than folded in
silently, with a note saying what the original pass got wrong — an audit
that quietly absorbs its own misses stops being evidence of how much was
actually checked.

### Status

The findings below are the **original text**, unedited, so this stays a
record of what was true when it was traced. What has since changed is
tracked here and nowhere else — one table rather than markers scattered
through the findings, so there is nothing to drift.

| Finding | Status | Where |
| --- | --- | --- |
| P0-1 storefront fails open | closed | P0.1 |
| P0-2 no request timeouts | closed | P0.2 |
| P1-1 nothing retries | closed | P1.3 — `PRODUCTION_RETRY_POLICY.md` |
| P1-2 enrichment stalls 6h after a provider blip | **open** | `drainEnrichment` is an orchestration continuation and was deliberately not migrated in P1.2; it has no job and so no retry |
| P1-3 `catalogHealth` full scans | open | P1.6 |
| P1-4 no webhook idempotency, `sourceUpdatedAt` dead weight | closed | P1.4 — `PRODUCTION_WEBHOOKS.md`. Delivery dedupe on the webhook id, freshness on the resource version; `sourceUpdatedAt` is now read |
| P1-5 Stripe events not deduplicated | open | P1.5 |
| P1-6 no durable job state | closed | P1.1 — `PRODUCTION_JOB_STATE.md` |
| P2-1 `/merchant/resync` no concurrency guard | closed | P1.2 — `PRODUCTION_IDEMPOTENCY.md` |
| P2-2 … P2-6 | open | — |
| P2-7 Brand Brain rebuilt on a timer | open | found during P1.2; deliberately not folded into a retry phase |
| P3-1 no startup config validation | open | — |

---

## 1. Findings, ranked

### P0-1 — A backend outage makes Disc hide the merchant's search box

`frontend/disc-widget.js`, `init()` (~line 1810).

```js
fetch(url)
  .then(res => res.ok ? res.json() : null)
  .catch(() => null)              // outage → status = null
  .then(status => {
    if (status && status.active === false) return;          // skipped
    if (status && status.widget_status === "inactive") return; // skipped
    applyBrand(status);
    document.body.appendChild(document.createElement("disc-search-bar"));
    hideNativeSearch();           // ← runs
  });
```

Both guards are `status && …`. A null status skips both and falls
through to `hideNativeSearch()`. So when Disc's backend is unreachable,
the widget hides the theme's own search input and mounts a bar that
cannot answer anything. The shopper then gets *"Disc couldn't reach the
boutique just now"* — from a store whose real search box is now hidden.

`goDormant()` does not save this. Tracing its only caller
(`disc-widget.js` ~line 529), it fires solely when a search **succeeds**
and returns `status === "inactive"`. A network failure lands in the
`.catch` branch, which shows a message and restores nothing.

This directly contradicts two things this repo states as design
guarantees:

- `CLAUDE.md`: *"A lapsed subscription must never leave a storefront
  worse than Disc found it."* The lapsed path is handled. The outage
  path — strictly more likely — inverts it.
- The code comment two lines above the bug: *"A network failure resolves
  as 'carry on'."* "Carry on" was intended to mean *don't block the
  install*. What it does mean is *hide their search anyway*.

Failure is currently **open**; Phase 9 requires it to be **closed**.

**Fix shape:** treat an unresolved status as "do not attach". One line —
mount only on an affirmative `status` object. The reason it is P0 is not
difficulty, it is blast radius: this degrades every merchant's storefront
simultaneously whenever Disc has an incident, and it is invisible to us
because the failure is on their page.

**No test covers this.** `dormant_test.js` covers the lapsed-tenant path
against a live billing-enabled backend. There is no test for
"backend unreachable".

---

### P0-2 — No request in the widget has a timeout

`frontend/disc-widget.js` — zero occurrences of `AbortController`,
`AbortSignal`, or any timeout wrapper across all 1,833 lines.

Every `fetch` — boot status, search, product, look, cart — waits
indefinitely. An outage that *refuses* connections fails fast; one that
*hangs* (an overloaded deployment, a black-holed route, a captive
portal) leaves the shopper on a spinner with no recovery path, and leaves
the boot check pending forever, which means the bar never mounts and no
error is ever shown.

Combined with P0-1 this is the worst case: native search hidden by an
earlier successful boot, then every subsequent request hanging.

**Fix shape:** `AbortSignal.timeout()` with a short budget on the boot
check (it blocks nothing, so it should give up fast) and a longer one on
search. Falls back to the existing error paths, which already exist and
are correct.

---

### P1-1 — Nothing retries. `retryable` is computed and never read

`convex/lib/providers.ts:129` classifies provider failures correctly:

```ts
const retryable = response.status === 429 || response.status >= 500;
throw new ProviderError(`Model request failed (${response.status})`, retryable);
```

`grep -rn "retryable" convex/` returns **five hits, all inside
`providers.ts` itself** — the definition, the constructor, the
assignment, and the throw. No consumer anywhere reads the flag.

So a rate-limit response from Anthropic during catalog enrichment is
handled identically to a malformed request: caught, discarded, product
left stale. The classification was written for a retry policy that was
never built.

There is no backoff, jitter, attempt ceiling or dead-letter state
anywhere in `convex/` (`grep -rniE "backoff|maxattempts|nextattempt|deadletter|jitter"` → no matches).

---

### P1-2 — Enrichment stalls for up to 6 hours after a provider blip

`convex/crons.ts` `drainEnrichment`:

```ts
if (result.remaining > 0 && result.enriched > 0) {
  await ctx.scheduler.runAfter(1000, internal.crons.drainEnrichment, { tenantId });
  return null;
}
await ctx.scheduler.runAfter(0, internal.brand.buildBrandBrain, { tenantId });
```

The `&& result.enriched > 0` guard exists to stop an infinite spin when
every product in a batch fails — which is correct reasoning. But it
conflates *"this batch is permanently broken"* with *"the provider is
having a bad minute"*, and the two need opposite responses.

Traced consequence of a total-batch failure: no reschedule → enrichment
halts → `buildBrandBrain` runs → `canDeriveBrand`
(`lib/brand-stats.ts:215`) correctly refuses below the coverage
threshold and sets `brandBrainStatus` back to `"pending"` → the tenant
sits at "still learning this store's catalog" with nothing scheduled.

**It does self-heal:** `syncCatalog` unconditionally schedules
`drainEnrichment` at its end (`ingest.ts:127`), and `resyncStaleCatalogs`
runs every `DISC_RESYNC_HOURS` (default 6). So the worst case is a stall,
not a permanent halt.

I want to record that I expected this to be a permanent halt before
tracing it, and it is not. The mitigation is real. It is still P1 because
six hours of a merchant watching an install not finish, with no error
surfaced and no retry visible, is an onboarding failure — and the
recovery is accidental (a catalog resync) rather than designed.

**Credit where due:** `canDeriveBrand` refusing to build a Brand Brain on
thin coverage is exactly right, and is what stops this from corrupting
the brand model.

---

### P1-3 — `catalogHealth` will fail on the largest paying tenants

`convex/merchant.ts:117-133` — three unbounded `.collect()` calls:

```ts
const products   = await ctx.db.query("products")...collect();
const profiles   = await ctx.db.query("productProfiles")...collect();
const embeddings = await ctx.db.query("productEmbeddings")...collect();  // ← 
```

The third loads **every embedding vector for the tenant** in order to
compute `embedded.size` — a count. Each row carries 1,536 `float64`
values ≈ 12 KB. Arithmetic:

| Catalog | Embedding bytes read |
|---|---|
| 500 (Pilot ceiling) | ~6 MB |
| 1,300 | ~16 MB |
| 5,000 (Growth ceiling) | ~60 MB |

Convex enforces a per-query read limit (documented at 16 MiB at the time
this stack was chosen — **UNKNOWN whether that figure is current; verify
before sizing the fix**). On that figure the Catalog page breaks around
~1,300 products, which is inside the Growth tier and far inside
Enterprise. The dashboard section that reports catalog health would be
broken for precisely the merchants paying the most, and the failure would
present as a dashboard error with no indication that catalog size is the
cause.

The same function is called by `/merchant/dashboard`, so the landing page
fails too, not just the Catalog tab.

**Fix shape:** counts should come from indexed aggregates or a maintained
counter, never from materialising vectors. No embedding vector should
ever be read by a query whose output is a number.

---

### P1-4 — No webhook idempotency, and `sourceUpdatedAt` is dead weight

`convex/http.ts` `shopifyWebhook()` verifies HMAC, resolves the tenant,
and processes. It does not deduplicate.

- `grep -rniE "webhook-id|X-Shopify-Event|dedup"` → **no matches.**
  `X-Shopify-Webhook-Id` is never read.
- `sourceUpdatedAt` is parsed (`lib/products.ts:158,199`), stored
  (`schema.ts:221`) and **never compared** — no ordering guard exists.

Shopify explicitly does not guarantee once-only or in-order delivery.
Traced consequences:

- **Duplicate `products/update`** → two `syncSingleProduct` jobs → the
  product is re-embedded twice. Correct result, doubled embedding spend.
- **Out-of-order update** → an older payload lands after a newer one and
  overwrites it. The field that would prevent this is already being
  stored; it is simply never read.
- **`update` racing `delete`** → ordering decides whether a deleted
  product remains a recommendation candidate.

---

### P1-5 — Stripe events are not deduplicated, and replay re-grants access

`convex/billing.ts` `applyStripeEvent` patches subscription state
unconditionally. There is no `event.id` ledger
(`grep -n "event.id\|eventId" convex/billing.ts convex/lib/billing.ts` →
no matches).

The signature check I built enforces a 300-second timestamp tolerance,
which bounds *adversarial* replay to five minutes. It does not bound
Stripe's own retry-and-reorder behaviour. A `checkout.session.completed`
delivered after a `customer.subscription.deleted` sets the tenant back to
`trialing` — restoring access to a cancelled merchant, silently.

This is the one finding with a direct revenue impact.

---

### P1-6 — No durable job state anywhere

Every background operation is `ctx.scheduler.runAfter(...)`
fire-and-forget. `grep -n "jobs\|jobId\|idempotency" convex/schema.ts` →
no matches; there is no job table.

Consequences, all traced:

- No attempt count, so nothing can implement a retry ceiling.
- No terminal failure state, so nothing can dead-letter.
- No operator visibility: "is tenant X's enrichment stuck?" is answerable
  only by inferring from `catalogStatus` and profile coverage.
- No idempotency key, so a duplicated trigger duplicates the work.
- Progress is inferred from side effects (`cacheKey` staleness), which
  works but means a job that fails *after* its writes is indistinguishable
  from one that never ran.

This is the single largest structural gap and the prerequisite for fixing
P1-1, P1-2 and P1-4 properly rather than locally.

---

### P2-1 — `/merchant/resync` has no concurrency guard

`convex/http.ts` schedules `syncCatalog` directly. `syncCatalog`
(`ingest.ts`) sets `catalogStatus: "syncing"` but never checks it first.

`dueForResync` (`tenants.ts`) **does** exclude syncing tenants — the cron
is safe. The merchant button is not: the `resync` rate limit permits 4/hr,
so four concurrent full catalog syncs are reachable by clicking four
times. Each pages the entire catalog and re-embeds changed products.

`deleteMissing` is guarded by `if (!cursor)`, so it only runs on a
complete pagination — which prevents the dangerous outcome (mass
deletion from a truncated sweep). The remaining cost is 4× Shopify API
calls and 4× embedding spend, plus interleaved writes to the same rows.

---

### P2-2 — `removeEdgesFor` reads the whole tenant graph per look mutation

`convex/looks.ts:426-434` collects **every** `lookEdges` row for the
tenant, then filters in memory, on every save / approve / archive /
delete. At the 2,000-look ceiling with 3-piece looks that is up to ~6,000
rows read to modify at most 3.

The `by_tenant_and_a` / `by_tenant_and_b` indexes exist and are not used
for this path. Correctness is fine; the cost is avoidable and grows with
library size — i.e. it gets worse exactly as a merchant adopts the
feature.

---

### P2-7 — The Brand Brain is rebuilt on a timer, not on change

*Added during P1.2. The Phase 0 pass missed it: I classified
`buildBrandBrain` as an orchestration continuation and did not follow the
chain to what it writes.*

Traced call path, all unconditional:

```
crons.interval("resync stale catalogs", 6h)   convex/crons.ts:24
  -> resyncStaleCatalogs                       convex/crons.ts:48
  -> syncCatalog                               convex/ingest.ts
  -> drainEnrichment                           convex/ingest.ts:127
  -> buildBrandBrain                           convex/crons.ts:101
  -> saveBrain                                 convex/brand.ts:102
```

`ingest.ts:127` schedules the drain whether or not the sync changed
anything. `crons.ts:101` runs when the backlog is empty, which for an
unchanged catalog is the first pass. `saveBrain` demotes the current row
and **inserts a new version unconditionally** — there is no comparison
against the brain it is replacing.

Two consequences, both proportional to tenant count rather than to
merchant activity:

- **Spend.** Each rebuild is a `reasoningProvider` call
  (`convex/brand.ts:183`) attributed to the tenant. Four a day per
  tenant, whether or not a single product changed.
- **Storage.** `brandBrains` gains ~1,460 rows per tenant per year.
  Nothing prunes old versions — deliberately, because
  `recommendationTraces` reference them and must keep resolving — so the
  table only shrinks when `purgeTenant` drops the tenant entirely.

The version number is also merchant-visible, so a merchant who changed
nothing still watches it climb, which makes it useless as a signal that
anything happened.

Not a correctness bug: a rebuilt brain is a valid brain, and §138's
merchant-correction versioning depends on versions being cheap to create.
The fix is a content check before `saveBrain` inserts — skip when the
derived inputs are unchanged — plus a retention rule for `derived`
versions no trace references. Both are behaviour changes to the brand
path, so neither belongs in a scheduling phase.

---

### P2-3 — Analytics events are not idempotent

`convex/analytics.ts` `recordEvent` is a bare insert. `/events` is a
public beacon (necessarily — it runs on the merchant's page), so browser
retries, double-fires and replays all count twice.

The endpoint is already well-defended against the *worse* problem: the
event vocabulary is closed and client-reportable types are a restricted
subset, so a forged request cannot write `purchase`. Volume inflation is
the residual risk, and it lands directly in the merchant-facing funnel
metrics and in `costPerSessionUsd`'s denominator.

---

### P2-4 — No request correlation

No `requestId` exists anywhere. `recommendationTraces` records versions,
scores and latency per recommendation — genuinely good — but nothing ties
a storefront request to the model calls, usage rows and events it
produced. Debugging "this shopper got a bad answer at 14:02" means
joining on timestamps.

---

### P2-5 — Model output is validated, but two paths trust structure

Vocabulary validation is thorough (`coerceTerm`, `parseProfile`,
`parseDetections`, `sanitiseLookAttributes` all reject out-of-vocabulary
values rather than storing them). This subsystem is in good shape.

One gap traced:

- `looks.saveLook` accepts `detected: v.any()` and stores it verbatim as
  provenance. It is never rendered as HTML (the dashboard reads only
  `label`/`description`, and `parseDetections` truncates both), so this
  is storage of unvalidated model output rather than an injection path —
  but the stored blob itself is unbounded in size, and Convex caps
  documents at 1 MiB. A pathological vision response could fail the
  write.

Checked and clear: `readConfidence` (`enrichment.ts:328`) does clamp —
`Math.max(0, Math.min(1, n))` with a `Number.isFinite` guard and a 0.5
default. I flagged it as unverified before tracing it; it is correct.

---

### P2-6 — Prompt injection via merchant-controlled product text is untested

Product titles, descriptions and tags flow into enrichment prompts
verbatim (`prompts.ts` `productProfileUser`). A merchant — or anyone who
can edit a product in their Shopify admin — controls that text.

The blast radius is genuinely small by construction: the output is forced
through a closed vocabulary, so a successful injection can at most cause
a product to be mis-attributed within the allowed terms. It cannot escape
into CSS, SQL, tenant ids or another merchant's data.

But no test asserts that. Phase 13 asks for exactly this and the
adversarial suite does not exist.

---

### P3-1 — No startup configuration validation

`convex/lib/env.ts` returns `""` for anything unset. There is no
localhost default left in `convex/` (an improvement on the Python
version) — but there is also no check that required values are present.

Traced: `PUBLIC_URL()` unset → the OAuth `redirect_uri` becomes
`"/auth/callback"`, a relative URL Shopify rejects. The install fails
with a Shopify-side error that says nothing about the real cause.

Same shape for `DISC_ENCRYPTION_KEY` (token encryption), `SHOPIFY_API_KEY`
/ `SHOPIFY_API_SECRET`. `billingEnabled()` and the `/admin/economics`
503-when-unset guard are the two places that handle absence deliberately
and correctly — that pattern should be the rule, not the exception.

---

## 2. Subsystem classification

| Subsystem | Files | Verdict | Why |
|---|---|---|---|
| Tenant isolation | `lib/tenancy.ts`, `schema.ts` vector index | **KEEP** | Single chokepoint, filter field on the vector index, re-asserted at every hop, tested cross-tenant. No change. |
| Credential split | `schema.ts`, `auth.ts`, `http.ts` | **KEEP** | `publicKey` vs hashed merchant token is correct and enforced at the route layer. |
| Decision pipeline | `outfits.ts`, `lib/outfit.ts`, `lib/compatibility.ts`, `lib/judge.ts` | **KEEP** | Correctly staged; deterministic funnel before model spend. Add stage contracts (Phase 7), do not restructure. |
| Intent | `lib/intent.ts`, `session.ts` | **KEEP** | Deterministic first, model only on residue. Exactly the right shape. |
| Product intelligence | `enrichment.ts`, `lib/fashion-profile.ts`, `lib/enrichment-cache.ts` | **HARDEN** | Provenance and cache invalidation are right. Needs retry (P1-1) and drain-loop fix (P1-2). |
| Brand Brain | `brand.ts`, `lib/brand-stats.ts` | **KEEP** | Versioned, coverage-guarded, merchant corrections create versions. |
| Look Builder / graph | `looks.ts`, `lib/looks.ts` | **HARDEN** | Cold-start guarantee is tested and correct. Fix `removeEdgesFor` read amplification (P2-2). |
| Model gateway | `lib/providers.ts`, `usage.ts` | **HARDEN** | Adapters, routing, versions and metering all present. Needs retry policy and `requestId` (P1-1, P2-4). |
| Model output safety | `lib/taxonomy.ts`, `parseProfile`, `parseDetections` | **KEEP** | Closed vocabularies, reject-not-invent. Two small gaps in P2-5. |
| Catalog ingestion | `ingest.ts` | **HARDEN** | Paging, bounded, `deleteMissing` correctly guarded. Needs concurrency guard and ordering guard (P2-1, P1-4). |
| Shopify webhooks | `http.ts` | **HARDEN** | Verify-before-parse is right. Needs dedup + ordering (P1-4). |
| Billing | `billing.ts`, `lib/billing.ts` | **HARDEN** | Pure event interpretation is well factored and tested. Needs event dedup (P1-5). |
| Background jobs | `crons.ts`, `scheduler.runAfter` call sites | **REFACTOR** | No durable state. Largest structural gap (P1-6). |
| Analytics | `analytics.ts`, `lib/events.ts` | **HARDEN** | Closed vocabulary and client restriction are right. Needs idempotency (P2-3). |
| Usage metering | `usage.ts`, `lib/model-pricing.ts` | **KEEP** | Compiler-enforced sink; unpriced models cost the max rate. |
| Rate limiting | `lib/rate-limit.ts`, `billing.ts` | **KEEP** | Fixed-window, per tenant, rejected requests don't extend the window. |
| Merchant dashboard | `dashboard/` | **HARDEN** | Server-only token handling is right and tested. `catalogHealth` breaks it at scale (P1-3). |
| Storefront widget | `frontend/disc-widget.js` | **HARDEN** | Both P0s live here. Structure is fine; failure behaviour is not. |
| Evaluation | `evaluation/`, `lib/evaluation.ts` | **HARDEN** | Real merge gate. Needs the failure-mode categories Phase 12 lists. |
| Adversarial tests | — | **UNKNOWN → build** | Does not exist. Phase 13. |
| `/backend` | `backend/*.py` | **REMOVE** | Superseded on every axis. Verified no import, script or test path references it from the production path. |

---

## 3. What I got wrong before tracing

Recorded because the mandate says not to infer from filenames, and I
would otherwise have shipped these as findings:

1. I expected the enrichment stall to be permanent. It self-heals via the
   6-hourly resync. Downgraded from P0 to P1.
2. I expected `deleteMissing` to be exposed to truncated pagination. It is
   guarded by `if (!cursor)`. Not a finding.
3. I expected `dueForResync` to allow overlapping syncs. It filters
   `syncing` tenants. The gap is only on the merchant-triggered path.
4. I expected the Brand Brain to be buildable from thin coverage.
   `canDeriveBrand` refuses. Not a finding.

---

## 4. Recommended order

Ordered by blast radius per unit of effort, not by phase number.

1. **P0-1 and P0-2** — widget failure isolation. Small, contained, and
   they are the only findings that degrade a merchant's storefront.
   Needs the browser test Phase 9 describes.
2. **P1-3** — `catalogHealth`. A counting query must not read vectors.
3. **P1-5** — Stripe event ledger. Revenue impact.
4. **P1-4** — webhook dedup + `sourceUpdatedAt` ordering. The field is
   already stored; this is mostly wiring.
5. **P1-6** — durable job records, then **P1-1** retry and **P1-2** drain
   fix on top of them. Doing retry first would mean building it twice.
6. **P2s** in any order.
7. **Phase 13 adversarial suite** — before any merchant onboarding, not
   after.

Nothing in this list requires new infrastructure. No queue, no broker, no
external scheduler: Convex's scheduler plus a job table covers every job
requirement in Phase 2, and the workload does not demonstrate otherwise.

---

## 5. Not production-ready, and why that is not the same as "broken"

The system is spec-complete and the architecture is right. What it has
not had is a hostile read: every finding above is something that only
appears when you ask "what happens when this fails, twice, out of order,
under load, for the biggest customer".

Two of them would be visible to a merchant's shoppers during any Disc
incident. One breaks the dashboard for the largest tier. One can restore
access to a cancelled subscription. Those four are the gate.
