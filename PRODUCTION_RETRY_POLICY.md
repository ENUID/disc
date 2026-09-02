# Retry policy (P1.3)

Durable jobs stop being "persisted work" and become "persisted work with
bounded, observable recovery".

**Scope:** classification, backoff, attempt accounting, crash recovery and
manual retry. No webhook event ledger, no Shopify ordering, no Stripe
ledger, no external queue — those are P1.4 and after.

---

## The architectural rule

> **Retry belongs to the durable job executor. Callers never retry.**

No HTTP handler, webhook handler or cron caller retries anything. They
enqueue logical work once; the executor decides how many times that work
is attempted.

```
one logical operation
  -> one idempotency key
    -> one durable job
      -> multiple bounded attempts
```

A caller that retried on its own would either duplicate the executor's
attempts or race them, and neither would appear in the job row — the
record that is supposed to explain why something ran three times. It
would also break the P1.2 guarantee directly: a caller re-triggering its
own work either produces a second job under a new key, or deduplicates
into the existing one and does nothing while believing it retried.

`ProviderError.retryable` is decided at the call site that saw the
response and read **only** by `classifyFailure`. No production caller
inspects it: outside `lib/providers.ts` (which sets it) and
`lib/retry.ts` (which reads it), the only `.retryable` references in
`convex/` are tests, and they read the `Classification` and the job row
rather than the provider error.

---

## Error taxonomy

`convex/lib/retry.ts`. The set is closed; the retryable half is written
out explicitly rather than derived.

| Class | Retryable | Raised by |
| --- | --- | --- |
| `provider_rate_limited` | yes | model / embedding 429 |
| `provider_unavailable` | yes | model / embedding 5xx |
| `shopify_throttled` | yes | Shopify 429, or `Throttled` in a GraphQL error body |
| `shopify_unavailable` | yes | Shopify 5xx |
| `network` | yes | transport failure, named as such in the message |
| `stalled` | yes | the crash-recovery sweeper |
| `shopify_unauthorized` | **no** | Shopify 401/403 |
| `invalid_input` | **no** | any other 4xx; a rejected GraphQL query |
| `invalid_configuration` | **no** | `TerminalJobError` — e.g. a tenant with no credentials |
| `malformed_source_data` | **no** | `MalformedSourceError` — a product that cannot be mapped |
| `malformed_model_output` | **no** | `MalformedModelOutputError` — see below |
| `unknown` | **no** | everything else |

### `unknown` is terminal, and that is the load-bearing decision

An error nobody has classified is not an error anybody has shown is safe
to repeat. The failure mode of the opposite default is a bill: every new
bug becomes a paid retry loop, three times over, on every tenant it
touches. The failure mode of this default is a job that stops and says
so, which someone can see.

`isRetryableClass("unknown") === false` is asserted directly, and
flipping it fails 9 integration tests and 3 pure tests.

### Malformed model output is terminal, by explicit policy

Not by default — by decision, stated because "just retry the model" is
the most tempting and most expensive wrong answer here.

Disc's model callers already implement spec §85's repair-then-fallback
*inside* the call: `extractJson` tries the raw text, a fenced block and a
brace-delimited slice, and the caller keeps its deterministic result when
none parse. By the time an unparseable response escapes as an error, the
bounded repair has already run and failed. A job-level retry would re-run
a whole job to re-roll the same prompt at full cost, with no bound
visible to anyone reading the job row.

### Classification does not use `instanceof`

An error raised in one Convex action and observed by another has crossed
a serialisation boundary; its prototype does not survive that, but
`error.name` does. Classifying on the prototype would pass every unit
test and silently degrade every real cross-boundary failure to `unknown`
— presenting as "nothing ever retries", with no error to point at. There
is a test that classifies a plain object shaped like a `ProviderError`.

Message matching is a last resort, applied only after the typed paths,
and only to text that names a transport condition. A bare `TypeError`
from a programming mistake classifies as `unknown`, not `network`, even
though `fetch` failures are also `TypeError`s.

---

## The state machine

No new states. P1.1's matrix is unchanged, including the empty transition
sets on terminal states.

```
queued ─claim─> running ──success────> succeeded
                   │
                   ├── retryable, attempts left ──> retrying ─claim─> running
                   │
                   └── terminal, or exhausted ───> failed
```

`retrying` is claimable, which is what makes a retry *a second attempt of
the same job* rather than a second job: the id, the idempotency key and
the attempt count all survive.

---

## Attempt semantics

**`attempt` increments on claim, not on failure.** P1.1 established this
and P1.3 depends on it entirely.

```
maxAttempts = 3

claim #1  attempt = 1   retryable failure -> retrying
claim #2  attempt = 2   retryable failure -> retrying
claim #3  attempt = 3   retryable failure -> failed
```

A process that crashes after claiming and never reports anything has
still consumed its attempt. Counting on failure instead would mean a
process that disappears never reaches the counter — and the crash
recovery sweeper below would then resurrect the same job forever. The
crash-loop test asserts exactly this: claim, die, recover, three times,
then `failed`.

Exhaustion is `attempt >= maxAttempts`, with no off-by-one at any call
site. A job whose `maxAttempts` is later lowered below its `attempt`
still stops rather than looping.

---

## Backoff

```
delay = min(capMs, baseMs * 2^(attempt - 1)), then jittered, then clamped
```

| Constant | Default | Env |
| --- | --- | --- |
| base | 1 s | `DISC_RETRY_BASE_MS` |
| cap | 5 min | `DISC_RETRY_CAP_MS` |
| jitter | ±25% | `DISC_RETRY_JITTER` |

**These are not claimed to be production-optimal.** They are a starting
point chosen so being wrong is cheap: fast enough to ride out a
one-second blip, slow enough not to hammer a provider that is genuinely
down. They are environment-configurable precisely because the right
values depend on failure data this deployment does not have yet.

The cap is a real ceiling: jitter is applied and then clamped back into
`[0, capMs]`, so `capMs` means what it says rather than "cap plus 25%".
The consequence is that at the cap the spread becomes one-sided
(`[0.75·cap, cap]`), which is fine — jitter exists to stop a fleet of
jobs that failed together from retrying in lockstep, and a one-sided
spread does that just as well.

Growth is capped rather than unbounded because without it a generous
attempt ceiling schedules the last retry days out, which is
indistinguishable from losing the job. The exponent is also clamped so
the arithmetic stays finite for absurd inputs.

---

## Scheduling a retry

`reportJobFailure` (`convex/scheduling.ts:363`) writes the transition and
schedules the next attempt **in one mutation**, for the same reason
`enqueue` does: Convex schedules transactionally, so "moved to retrying"
and "an attempt is scheduled" commit together or not at all. Split across
two calls, a crash between them leaves a `retrying` row with nothing
coming — which looks exactly like a job about to run, and never will.

The retry re-schedules the **same job id** with the **same idempotency
key**. Worker arguments come from `jobs.payload`.

### Why `payload` was added

P1.1 deliberately had no payload field, reasoning that a job's
authoritative input lives in the domain tables it operates on. That is
true of `catalog_sync`, whose only input is the tenant, and false of
`product_embedding`: its input is a Shopify product id that may not
correspond to any row yet — a `products/create` webhook for a product
Disc has never seen. A retry must re-schedule the same worker with the
same arguments, and the crash sweeper must do it for a job whose action
died holding them.

The shape is a **closed object**, not `v.any()`. That is what stops it
becoming a general side-channel, and it means a credential cannot be put
there without a visible schema edit.

### A retry that cannot be scheduled fails the job

Scheduling happens *before* the row is patched to `retrying`, and a throw
from it is caught and turned into a terminal failure rather than allowed
to abort the mutation.

An abort would roll the row back to `running`, where nothing can reach
it: the stale sweeper would pick it up, hit the same error, abort again,
and the job would be wedged forever with no state recording why. The
reachable case is a job whose worker needs arguments the row cannot
supply — a `product_embedding` with no `payload` — which is a
configuration fault, not a transient one.

Found during the pre-commit diff review, not by a failing test; the test
was written afterwards and the guard's removal fails it.

### The report is ignored unless the job is running

A failure report against a job in any other state is a no-op. Without
that guard, a late report from an execution the sweeper already recovered
would consume a second transition and could push a job past its ceiling
on a single attempt. It is also what makes two concurrent failure reports
produce exactly one retry.

---

## Crash recovery

`recoverStuckJobs` (`convex/crons.ts:155`), every 5 minutes.

| Question | Answer |
| --- | --- |
| How long is `running` healthy? | Up to `JOB_STALE_RUNNING_MS`, default 15 min (`DISC_JOB_STALE_MS`) |
| When is it stale? | `startedAt` older than that |
| How is a stale job handled? | Reported to `reportJobFailure` as class `stalled` |
| Is the stale attempt consumed? | **Yes** — it was consumed at claim |
| How many recoveries? | Bounded by `maxAttempts`, like any other failure |

The threshold is deliberately well above Convex's action time limit: a
threshold below it would "recover" jobs that are still working.

**It does not re-run the work.** Blind re-execution would race a job that
is merely slow, giving two live executions of the same work — the exact
thing P1.2 exists to prevent. The job is moved back into the state
machine and the ordinary decision is applied.

### The one race this accepts

A job still alive past the threshold is moved to `retrying` under it, and
its eventual `succeedJob` is then refused — `retrying → succeeded` is not
a legal transition — so its work is redone.

Stated plainly rather than engineered around. The threshold makes it
vanishingly unlikely, and the consequence when it happens is a redundant
re-run, not corruption. The alternative — widening the transition matrix
so a zombie execution can still report success — would weaken a tested
invariant to handle a case that should not occur.

---

## Manual retry

The gap P1.2 opened and named: a failed job holds its idempotency key
forever, so an ordinary enqueue deduplicates against it and the merchant's
"Retry sync" button does nothing until the 5-minute bucket rolls over.
**Idempotency became a user-facing deadlock.**

```
ordinary duplicate + failed job   ->  deduplicate
explicit retry     + failed job   ->  new execution opportunity
```

The distinction is `explicit: true` on `enqueueCatalogSync`, set by
`POST /merchant/resync` — a person pressing a button — and not by the
cron sweep, which repeating itself is not a new decision by anyone.

**It changes the failed case and nothing else.** A running, retrying or
queued job still wins: an explicit trigger must not start a second
concurrent sync any more than an automatic one may.

### The design, and the one that was rejected

**Rejected: reset the failed row to `retrying`.** That puts an edge out of
a terminal state. "A completed job cannot become pending again" is an
invariant with a test asserting all thirty-six transition pairs, and
weakening a proven safety property to add a feature is the wrong trade.

**Chosen: a new job row with a derived key and a `supersedes` link.**

| Requirement | How |
| --- | --- |
| historical attempts | the failed row is not touched at all |
| idempotency | the derived key deduplicates exactly like the original |
| auditability | `supersedes` makes the chain followable |
| no double execution | the old job is terminal and unclaimable; the new one is the only live row |

The key is `manualRetryKey(k) = k + "|%retry"`. `%` cannot collide:
`escapePart` rewrites `%` to `%25` before joining, so the sequence `|%`
is unreachable through `idempotencyKey`. A plain `|retry` suffix would
**not** be safe — a product whose discriminator happened to be the string
`"retry"` produces exactly that. This is the same class of bug the P1.1
delimiter escaping fixed.

### The chain, and the bug the tests caught

The first implementation retried the job it was handed. Retrying a job
that had *already* been retried then derived the key its own successor
was using, found it, and deduplicated into it — so a merchant whose first
retry also failed got a second Retry button that silently did nothing.
The same deadlock, one link along.

`retryFailedJob` now walks to the newest link in the chain before
deciding anything, bounded by `MAX_MANUAL_RETRY_DEPTH` (10). Ten
consecutive manual retries inside one deduplication window is not a
merchant who needs an eleventh — it is a merchant who needs the
underlying failure fixed, and refusing with a nameable reason
(`retry_chain_too_long`) says so better than growing a key forever.

### API change

`POST /merchant/resync` gains `recovered: boolean` alongside the existing
`deduplicated`. Additive; nothing reads it yet.

---

## Error persistence

Written on the job row: `errorClass`, `lastError` (normalised, ≤200
chars), `attempt`, `failedAt`, `nextAttemptAt`, `retryable`, and an
`attempts[]` history with one entry per failed attempt.

Final vs temporary is `status`, not a separate field — adding one would
be a second source of truth for something the state machine already
answers.

**Never persisted:** access tokens, API keys, authorization headers, or
provider response bodies. Two concrete changes enforce this rather than
assume it:

- `lib/embeddings.ts` previously interpolated `body.slice(0, 300)` of the
  provider's error response into the message. That message now reaches a
  job row and a log line, and a provider's error body is exactly where
  request context turns up. It now throws a typed `ProviderError` with
  the status and no body.
- `jobs.payload` is a closed object, so a credential cannot be stored
  there without a schema edit that shows up in review.

`attempts[]` is bounded by `MAX_ATTEMPT_HISTORY` (10) independently of
`maxAttempts`, because `maxAttempts` is caller-supplied and a document
that grows without limit fails to write at exactly the scale where its
history mattered. The most recent entries are kept: what happened last is
what explains where the job ended up.

---

## Provider integration

`ProviderError.retryable` is connected to job recovery **only** through
the executor. `ProviderError` gained an optional `status` so the executor
can tell a rate limit from an outage from a malformed request without
parsing a message.

When the flag and the status disagree, the flag wins: the thrower saw the
response, `classifyFailure` sees a number.

Model accounting is unaffected. Usage is reported inside the provider
call, so a retried attempt meters its own real spend — which is correct,
because a retry is a real second call. Model name, prompt version and the
`NullReasoningProvider` fallback contract are all unchanged.

---

## Observability

One structured line per decision, `{"scope":"jobs",...}`:

```
jobId  tenantId  type  attempt  maxAttempts  errorClass  decision  nextAttemptAt
```

Events: `job_retrying`, `job_failed`, `job_manual_retry`.

Deliberately carries the error **class**, not the error text — the
normalised message is already on the row, and a raw provider message is
the most likely place for request context to leak into a log.

"Why did this job run three times?" is answerable from the row alone:
`attempts[]` gives each attempt's class, timestamp and retry decision in
order.

---

## Tests

**`convex/lib/retry.test.ts`** — 27, no database. Taxonomy; the
`unknown`-is-terminal default; every classification path including
prototype loss and the flag-beats-status case; backoff growth, the cap,
jitter bounds (200 samples × 20 attempt levels), the one-sided spread at
the cap, and degenerate configuration; the decision table including the
full attempt sequence, a ceiling of 1, an attempt count past the ceiling,
and terminal-beats-exhaustion.

**`convex/retry.itest.ts`** — 36, real runtime. One job across many
attempts with an unchanged key; bounded attempts; the attempt history and
its cap; concurrent failure reports; a retrying job claimed four times;
crash recovery including the young-job and cross-tenant cases; the whole
manual-retry design including the chain and its bound; tenant isolation
on every new operation; `runAsJob` driven with real `ProviderError`
objects; and `POST /merchant/resync` recovering a failed sync end to end.

### Negative verification

Each break was applied to working code, the suite run, then reverted:

| Break | Result |
| --- | --- |
| retry decision always terminal | **10 integration tests fail** |
| executor ignores the claim refusal | **1 test fails** (see below) |
| stale jobs seen but never recovered | **3 tests fail** |
| explicit retry falls back to plain dedupe | **5 tests fail** |
| `unknown` treated as retryable | **9 integration + 3 pure tests fail** |
| unschedulable retry allowed to abort the mutation | **1 test fails** |

**The claim-refusal break initially caught nothing**, and the test was
rewritten. The original drove two concurrent executions and asserted
`attempt === 1` — but `reportJobFailure`'s "not running" guard already
absorbed the second execution's report, so both orderings left `attempt`
at 1 and a missing claim guard passed unnoticed. The test now claims the
job first and asserts the job is *untouched* by the arriving execution,
which distinguishes the two.

### What is proven, and what is not

The concurrency tests prove the guards are correct given serialised
mutations. They do **not** prove Convex's isolation — as recorded in
`PRODUCTION_JOB_STATE.md`, `convex-test` cannot be made to distinguish
interleaving from end-to-end serialisation from outside. Exclusivity
under real concurrency rests on Convex's documented serializable
isolation of mutations.

---

## Operational consequence

**Two workers stopped swallowing errors.** This is the largest behaviour
change in the phase:

- `syncSingleProduct` had a bare `catch {}`. A Shopify 429 on a
  webhook-triggered re-ingest vanished completely — no log, no status
  change, no record. The merchant edited a product and Disc kept serving
  the old one until the six-hourly resync happened to catch it. It now
  classifies and retries.
- `syncCatalog` caught, set `catalogStatus: "error"`, and stopped. It
  still sets that status — that is what the merchant sees — and now
  rethrows, which is the difference between "the dashboard says something
  broke" and "the system knows something broke".

**Retries cost money.** A retryable failure now means up to 3 attempts
rather than 1, so a provider outage triples that window's Shopify reads
and embedding calls for affected tenants. That is the trade the phase
buys: work that used to be silently lost now completes. The attempt
ceiling and the cap are what bound it.

**A failed sync is recoverable by hand**, closing the P1.2 regression.

**Two crons now exist where one did.** `recover stuck jobs` runs every 5
minutes and does nothing when nothing is stuck (one indexed query on
`by_status`).

---

## Rollback

Revert the commit. `lib/retry.ts`, `jobrunner.ts` and the two test files
are new. The schema additions are all optional fields — rolling back
leaves them present on existing rows and unread, which is inert.

The behavioural changes that do **not** silently revert:

- `syncCatalog` and `syncSingleProduct` go back to swallowing errors. A
  reverted deployment loses failure visibility, it does not break.
- `POST /merchant/resync` loses `recovered`, and a failed sync becomes
  un-retryable again until its bucket rolls over.
- Jobs mid-retry at the moment of rollback stay in `retrying` with a
  scheduled execution that will still arrive; the worker will run it
  without claiming, exactly as it did before this phase.
