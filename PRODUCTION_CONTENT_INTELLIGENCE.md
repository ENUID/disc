# P2.3 — the content intelligence foundation

**Status: foundation implemented. Video and social connectors are NOT.**

Content is a knowledge layer inside Disc, not a product Disc offers. It
exists to make the decision engine better at helping someone choose from
a brand's catalog — nothing here makes Disc a content platform, a feed,
or a social tool.

---

## 0. The distinction the whole phase is built around

```
PRESENCE       product X appears in this content
COMPATIBILITY  product X and product Y were styled together
```

**These are different claims and they must never collapse into one.**

A campaign photograph establishes both, because everything in frame was
put there by one styling decision. A twenty-minute lookbook film does
not: a shirt at minute 2 and trousers at minute 16 were never styled as
an outfit. Deriving a compatibility edge from that co-presence would fill
the outfit graph with pairs nobody approved — and because that graph is
*merchant-approved* evidence, the corruption would carry the authority of
a human decision that never happened.

So the separation is structural rather than documented:

| | stored in | derived from | reaches ranking |
| --- | --- | --- | --- |
| compatibility | `lookEdges` | a look's confirmed `items` | yes, capped additive bonus |
| presence | `contentProducts` | any content's confirmed products | **no** |

`rebuildEdgesFor` never queries `contentProducts`. Making presence create
compatibility takes adding a read that is deliberately absent, not a
plausible one-line edit.

---

## 1. What `looks` was, precisely

Established by tracing the call graph before anything changed.

| question | answer |
| --- | --- |
| content identity | `title`, `source`, `imageStorageId`, `status`, `createdAt` |
| detected products | `detected` — raw vision output, `DetectedGarment[]` |
| confirmed products | `items[]` — `{productId, slot, detectedLabel?, confidence?}` |
| what creates edges | **only** `items[].productId`, and only when `status === "approved"` |
| provenance only | `detected`, `items[].detectedLabel`, `items[].confidence` |
| tenant-scoped | `looks.tenantId`, `lookEdges.tenantId`; every index leads with it |
| file storage | `looks.imageStorageId` — the only storage reference in the schema |
| on delete | `removeEdgesFor` → `storage.delete` → `db.delete` |
| on tenant purge | `purgeTenant` walks looks, deletes each image explicitly, then edges |
| reaches ranking | `affinityFor` → `buildAffinity` → `affinityBonus`, capped at `MAX_AFFINITY_BONUS` (0.06), added on top of the weighted sum |
| reaches explanation | nothing — the affinity figure appears in the score breakdown of a trace, never in the explanation prompt |
| mutable | everything on a look |
| versioned | nothing; unlike `brandBrains`, looks are edited in place |
| approval | `setLookStatus` patches status, then rebuilds edges. Only `approved` contributes |
| assumes a still image | `analyseImage`, the single `imageStorageId`, `listLooks`/`getLook`, the dashboard builder |
| assumes a styled look | `rebuildEdgesFor` — it paired every item of any approved look |

**A look means: these products form an intentionally styled
combination.** That meaning is preserved exactly. Nothing in P2.3
changes what an existing approved look asserts or what it contributes.

---

## 2. The generalisation

`looks` IS the content table now. It was generalised in place rather than
replaced, because Convex has no rename and the audit found nothing that
required a destructive rewrite. Five optional fields:

| field | meaning | absent means |
| --- | --- | --- |
| `role` | what the content ASSERTS | `look` |
| `mediaKind` | what the bytes are | `image` |
| `origin` | where it came from | derived from `source` |
| `externalId` | identity at the source | nothing writes it yet |
| `externalUrl` | address at the source | nothing writes it yet |

All optional, so **every row written before P2.3 reads as exactly what it
was**: an uploaded still image asserting a styled look. A test pins that
by inserting a role-less row and asserting it still produces edges.

`role` is the load-bearing one, and `assertsStyling()` in
`convex/lib/content.ts` is the single place that reads it. Only `look`
returns true.

**An unreadable role degrades to `look`, not to something wider.** That
is the narrow direction: `look` is the only meaning the system has ever
had, it requires an explicit merchant approval before it affects
anything, and falling back to a presence-only role would silently
discard a real styling claim.

### Vocabularies

```
MEDIA_KINDS            image | video | article
PROCESSABLE_MEDIA_KINDS image                     <- deliberately one
CONTENT_ROLES          look | campaign | lookbook | editorial | social_post
CONTENT_ORIGINS        merchant_upload | merchant_built | shopify
                       instagram | tiktok | youtube
PRESENCE_STATES        detected | confirmed | rejected
```

**A term appearing in a vocabulary is not a claim that it is
implemented.** `instagram` is a value, not an integration. `video` is a
value, not a pipeline. `PROCESSABLE_MEDIA_KINDS` is what says which
kinds Disc can actually analyse, and it holds one entry.

---

## 3. Product presence

New table `contentProducts`, one row per (content, product).

```
tenantId  contentId  productId  state  scope  provenance
```

`scope` says WHERE or WHEN, and is closed rather than an open metadata
bag:

```
{ kind: "whole" }                                  the whole item
{ kind: "region", x, y, w, h }                     0..1 of an image
{ kind: "interval", startMs, endMs }               a video time range
```

Absent means whole, which is what every still-image look means. Nothing
in P2.3 produces an interval; the field exists so the shape does not have
to change when video arrives.

**An unreadable bound is not a narrower claim.** An interval that ends
before it starts, or a region missing its height, falls back to `whole`
rather than being stored. A half-scope is more dangerous than no scope,
because a future rule keyed on "did these share a bounded scope?" would
answer yes for two products that shared nothing.

Queries are bounded and tenant-scoped in both directions:
`presenceFor(content)` and `contentForProduct(product)`, each capped at
`MAX_PRESENCE_PER_CONTENT`. There is no global content index.

---

## 4. Detected, confirmed, rejected

The merchant authority boundary, and the same rule P2.2 established for
the Brand Brain applied at a different granularity — **not a second
correction system**.

- `recordDetections` writes `detected` rows. It **never** overwrites a
  row a merchant has already ruled on, including when a later analysis
  proposes the same product with higher confidence. A merchant who has
  said no should not have to keep saying it.
- `rejected` is stored, not deleted. A deleted rejection lets the next
  analysis propose the same wrong product again.
- Provenance survives confirmation. `detectedLabel`, `confidence` and
  `detectedBy` are kept after a human rules on a row, so "did a human
  approve this, and what did the model originally think?" stays
  answerable.
- `contentForProduct` returns **confirmed only**, so an unreviewed model
  proposal cannot reach a shopper by that route.

A look's confirmed `items` are mirrored into presence in the same
mutation that writes them, so the two cannot drift. The dependency is
one-way and must stay that way: confirmed items become presence;
presence never becomes items, and never becomes an edge. A re-map
rebuilds presence rather than accumulating it, and leaves rejected rows
alone.

---

## 5. What changed about looks, and what did not

**Did not change:** what a look means, how it is approved, how its edges
are built, the cold-start guarantee, `MAX_AFFINITY_BONUS`, the capped
additive term in `rankOutfits`, or anything in the decision engine.

**Changed:**

- `rebuildEdgesFor` gained the role gate.
- `saveLook` accepts `role`/`mediaKind`/`origin`, all defaulting to what
  a look has always been.
- The two-product minimum now applies to **looks only**. A styled
  combination of one piece is not a combination — that floor is what
  makes a look's items a compatibility claim. A campaign photograph of
  one product is a perfectly good statement about that product, and
  applying outfit semantics to something that never claimed to be an
  outfit would be wrong.
- `deleteLook` clears presence and edges separately, because they are
  separate claims with separate lifecycles.
- `listLooks` and `lookStats` filter to `role === "look"`, so the Looks
  page cannot present a campaign as a styled outfit.

---

## 6. Storage and purge

Unchanged in mechanism, extended in coverage. `looks.imageStorageId` is
still deleted explicitly on look deletion and on tenant purge.

**File storage is not a table**, so the schema-reading guard in
`privacy.itest.ts` cannot see it — that guard asserts every
`tenantId`-bearing table is in `purgeTenant`, and `contentProducts` was
added to both. Storage needs its own assertion, and has one: a test
stores a real blob, purges, and asserts `_storage` is empty.

No external object storage was introduced. No video decoding was
introduced.

---

## 7. Ranking

Untouched. Content presence contributes **nothing** to ranking in P2.3 —
`affinityFor` reads `lookEdges` only, and a tenant with twelve approved
campaigns naming the same two products still gets an empty graph.

The cold-start guarantee holds: no approved styling evidence means a zero
bonus and byte-identical recommendations.

And evidence never outranks a constraint. A sold-out product with
approved looks pairing it to the rest of the outfit AND ten confirmed
campaign appearances still does not reach a shopper, because availability
is a hard constraint applied before ranking.

---

## 8. Tests

`convex/content.itest.ts` (21) and `convex/lib/content.test.ts` (11).

Covering: an approved look still makes edges; approved non-look content
of every role makes none; a video role cannot smuggle co-presence into
the graph while its interval scopes survive; presence and compatibility
have independent lifecycles; detection ≠ confirmation; provenance
survives confirmation; a rejection is not resurrected by re-analysis; a
confirmation is not downgraded by it; unreadable scopes fall back;
cross-tenant reads, writes and detections all refused; provenance
survives confirmation through the look path too; delete and re-map
rebuild presence; purge removes presence and empties file storage;
presence contributes nothing to the affinity graph; cold start is empty;
a single-product campaign is valid where a single-product look is not; an
unreadable role degrades to `look`; pre-P2.3 rows still behave as looks;
and a sold-out product stays out however much content vouches for it.

### Negative verification

| break | tests failed |
| --- | --- |
| approved content of any role creates edges | 3 |
| detections recorded as confirmed | 1 |
| tenant filtering removed from presence | 1 |
| storage deletion removed from purge | 2 |
| merchant decisions overwritten by re-analysis | 2 |
| cold-start floor removed from `affinityBonus` | 5 (unit) |
| availability no longer a hard constraint | 1 |
| provenance rewritten instead of preserved | 1 |

The provenance row is not one of the seven the brief named — it was
found by reading this phase's own diff. `syncPresenceFor` rewrote every
field of an existing row, and Convex DELETES a field patched to
`undefined`, so a merchant confirming a model-detected product through a
path that does not resend the label would have erased exactly the
provenance §4 promises survives. Fixed, and the test was verified
against the broken version.

**The availability break initially failed to fail, and that mattered.** The first
version of the constraint test used a sold-out *jacket*, and the outfit
it was checking never wanted outerwear — so the test passed whether or
not the constraint existed. It was rewritten to use a sold-out *shirt*
competing for a slot the outfit actually fills, and then the break failed
it. A clean run against a broken implementation is a finding about the
test, not a reassurance about the code.

---

## 9. Known limitations

- **The table is still called `looks`.** It is the content table now, and
  the name is one generation behind. Renaming is mechanical but touches
  every query, route, test and dashboard type for no capability gain, and
  the audit did not find anything that required it. Left as a deliberate
  deferral rather than mixed into this phase.
- **Non-look content is not reachable from the merchant API.**
  `/merchant/looks/save` does not accept a role, by design: P2.3 is a
  backend foundation and the brief defers the Content dashboard. Roles
  other than `look` are exercised by tests and by internal callers.
- **Nothing consumes presence yet.** `contentForProduct` exists and is
  bounded and confirmed-only, but no ranking, retrieval or explanation
  path reads it. Content-aware ranking is a later phase and needs the
  capped-additive treatment the outfit graph already has.
- **`removeEdgesFor` still reads the whole tenant graph** per look
  mutation — audit finding P2-2, pre-existing and untouched here to avoid
  mixing unrelated cleanup into this commit.
- **`outfits.itest.ts`'s own "sold-out products never reach an outfit"
  test is hollow** in the same way the first draft of mine was: it still
  passes with the availability constraint removed. Found while running
  negative verification, reported rather than fixed, for the same
  scope reason.
- **The integration cold-start test did not catch the cap removal** —
  only the pure tests in `lib/looks.test.ts` did. Both sides of that
  comparison shift equally when the floor is removed, so the identity it
  asserts still holds. The pure tests are the real guard.

---

## 10. The video boundary

**Explicitly deferred, and nothing in this phase approaches it.**

Not implemented, not started, not scaffolded: video decoding, frame
extraction, shot detection, FFmpeg, external processing infrastructure,
Instagram ingestion, any social connector.

What exists is the ability to *represent* a bounded time range
(`{kind: "interval", startMs, endMs}`) and to record that a content item
is a video (`mediaKind: "video"`) which Disc cannot yet process
(`PROCESSABLE_MEDIA_KINDS` holds `image` alone).

The agreed direction for video, unchanged by this phase, is
**merchant-defined time ranges rather than automatic shot detection** —
cheaper, and consistent with the principle that a model proposes and a
merchant confirms. Changing that needs evidence from the product
requirements, not a preference.

---

## 11. Rollback

Revert the commit. The five `looks` fields are optional and ignored by
the previous code. `contentProducts` becomes an orphan table that nothing
reads or writes; dropping it needs a schema edit and, once anything is
deployed, a data deletion — it holds tenant-owned rows, so it must go
through `purgeTenant`-shaped deletion rather than being abandoned.
