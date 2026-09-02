# P2 — architecture audit and design

**Status: audit and plan. No implementation.** Written the same way as
Phase 0: trace the code, decide the architecture, stop before writing it.

The question P2 answers is not "can Disc run reliably" — P1.6 closed
that — but "what is Disc's production architecture when every fashion
brand has its own Disc". Two pieces: how Disc reaches a storefront, and
how a brand's content becomes evidence the decision engine can use.

---

## 0. Summary

**The App Embed is already built.** `extensions/disc-boutique/` is a
complete Shopify theme app extension, wired to `/storefront/config` and
to P0.1's fail-closed boot. Both `CLAUDE.md` and `PRODUCT_DIRECTION.md`
describe it as future work. That is documentation drift, and it means
P2's real weight sits almost entirely on the content architecture.

**The entry point the product direction asks for is half-built.**
`placement: "floating_button"` is a valid, merchant-settable, persisted
config value that `frontend/disc-widget.js` never reads. A merchant who
chooses it today gets a docked bar.

**`looks` is already the content system** — for exactly one content type.
The pipeline (media → detection → candidate products → merchant approval
→ ranking evidence) is the content pipeline, and its hardest product
decision (`detected` vs `items`) is already made and tested. The
recommendation is to **generalise `looks`, not to add tables beside it**.

**But not naively.** A look asserts *these products go together*; a video
scene asserts *this product appears here*. Folding the second into the
outfit graph as though it were the first would silently corrupt ranking.
That distinction is the main design finding below.

---

## 1. Distribution — what is actually left

### Already built and verified

`extensions/disc-boutique/`:

| Piece | State |
| --- | --- |
| `shopify.extension.toml` | `type = "theme"` — a theme app extension, not a script tag or the ScriptTag API |
| `blocks/disc.liquid` | app embed block, `target: "body"` |
| tenant identification | `shop.permanent_domain` → `/storefront/config?shop=` → public key. **The merchant pastes nothing.** |
| page context | `request.page_type`, product id/handle, collection id (spec §42) |
| currency and locale | `cart.currency.iso_code`, `request.locale.iso_code` |
| load behaviour | `defer`, asset served by Shopify's CDN |
| default state | app embeds start deactivated; the merchant switches Disc on |
| asset sync | `scripts/sync-extension-asset.mjs`, checked by `npm run verify` |

The storefront boot path holds P0.1: the widget resolves config **before
hiding anything**, and mounts only on `active === true` and
`widget_status !== "inactive"`. An unknown shop resolves as inactive
rather than 404 — the safe direction. Disc cannot become a dependency
that breaks a store.

### Genuinely outstanding

| Item | Kind | Blocking? |
| --- | --- | --- |
| Shopify Partner account, app registration | external | yes, for any real install |
| `shopify app deploy` | operational | yes |
| App review | external, slow | only for a public listing |
| Shopify Billing migration | code + product decision | only for a public listing (`lib/billing.ts` records why) |
| `floating_button` placement | **code** | yes, for the product direction |
| Entry-point copy | product decision | yes |

**Only one of those is code**, and it is the entry point.

### Finding P2-A: `placement` is declared and ignored

`convex/lib/widget-config.ts` defines
`PLACEMENTS = ["bottom_bar", "floating_button"]`. The value validates,
persists, and is exposed to the merchant. `frontend/disc-widget.js`
contains no reference to `placement` at all.

This is precisely the "Personalized Style" entry point:

```
merchant's storefront
      ↓  small branded control        ← floating_button, unimplemented
Disc experience                        ← already built
```

There is also **no field for the entry-point label**. `greeting` is the
in-bar placeholder ("What are you looking for?"), not a button caption.
Copy candidates — "Your Style", "Personalized Style", "Personal
Stylist", "Discover Your Style" — need a config field to live in, and
that field is merchant-visible text rendered into a storefront, so it
must go through `parseWidgetConfig`'s validation like everything else
(spec §65: design tokens, never free-form).

---

## 2. Is `looks` the content primitive?

**Yes — and the evidence is that the pipeline already has the shape.**

```
generateUploadUrl   →  Convex file storage
analyseImage        →  vision: detected garments
suggestMatches      →  per-garment catalog candidates (vector search, tenant-scoped)
saveLook            →  merchant-confirmed items, status: draft
setLookStatus       →  approved
rebuildEdgesFor     →  lookEdges
affinityFor         →  buildAffinity → capped additive bonus in ranking
```

Read that with the words replaced and it is the content pipeline from
`PRODUCT_DIRECTION.md`, unchanged.

### What it already gets right, and must not be rebuilt

- **`detected` vs `items`.** Raw vision output is provenance and is never
  merged into what the merchant confirmed. This is *the* product
  decision — a model can see "a white shirt" and have no idea which of
  fourteen it is — and it is already made.
- **Approval is a separate, explicit act.** Draft on save; edges only on
  approve; un-approving genuinely removes them.
- **The cold-start guarantee.** `MAX_AFFINITY_BONUS = 0.06`, capped and
  additive on top of the existing weighted sum, never folded in. Two
  tests: no-affinity must deep-equal empty-affinity, and a vouched
  outfit must win through the bonus alone.
- **Tenant scoping with an explicit cross-tenant check.** `saveLook`
  verifies every product belongs to the tenant — a merchant cannot pull
  another shop's product ids into their graph.
- **Explicit storage deletion.** `purgeTenant` deletes
  `look.imageStorageId` per row, because the schema-reading privacy guard
  cannot see file storage.

Rebuilding any of that in a parallel `content` table would mean two
approval flows, two purge paths, two vision pipelines, and two places for
the cold-start guarantee to hold. That is the outcome to avoid.

### What it lacks for general content

| Gap | Needed for |
| --- | --- |
| `source` is `uploaded \| merchant_built` | Instagram, video, editorial, Shopify-native media |
| no media type | distinguishing image from video |
| single `imageStorageId` | multi-image editorial, video assets |
| no time dimension | video scenes and timestamps |
| no external identity | `externalId`, `externalUrl`, `caption`, `publishedAt` |
| `items` carry no anchor | *where* in the image, *when* in the video |
| `detected: v.any()` unbounded | a video's detections will not fit a 1 MiB document |

---

## 3. The design finding: two assertions, not one

This is the part that would go wrong if content were folded in
mechanically.

```
a look           asserts:  these products GO TOGETHER
a video scene    asserts:  this product APPEARS HERE
```

Those are different claims and they feed ranking differently:

- **Outfit assertion** → a product↔product compatibility edge. This is
  `lookEdges`, and it is what `affinityBonus` reads.
- **Presence assertion** → a content→product association. Useful for
  "show me the pieces from this video" and for style evidence. It is
  **not**, on its own, a compatibility claim.

Co-presence implies styling intent only within a bounded context. A
campaign photograph: yes, everything in frame was styled together. A
twenty-minute lookbook video where two garments appear eight minutes
apart: no. Deriving outfit edges from whole-video co-presence would fill
the outfit graph with pairs nobody styled — and because the graph is
merchant-*approved* evidence, that corruption would carry the authority
of a human decision it never had.

**Recommended shape:**

```
content (generalised `looks`)
   │
   ├── contentProducts      presence: which products, where/when
   │        │
   │        └── anchor: { startMs, endMs } | { bbox } | none
   │
   └── lookEdges            compatibility: derived ONLY from a bounded
                            co-presence context the merchant approved
```

`lookEdges` keeps its current semantics and its `lookIds` provenance
array. What changes is that edge derivation becomes explicit about the
*scope* of co-presence rather than assuming one media item is one outfit.

For a still image, that scope is the image — identical to today, so
existing looks migrate with no change in meaning. For a video, the scope
is a scene, and a scene is a merchant-confirmed unit rather than an
inferred one.

---

## 4. Consumption: content is evidence, never a dictator

The decision engine already has the correct seam. `convex/outfits.ts`:

```ts
const graph = await ctx.runQuery(internal.looks.affinityFor, {...});
const affinity = buildAffinity(graph.edges, graph.lookCount);
```

→ a **capped additive bonus** on top of the existing weighted sum.

Content evidence must enter the same way, for the same reason a sixth
term inside the sum would renormalise the other five and shift every
existing result for every tenant. The two cold-start assertions in
`lib/looks.test.ts` are the template any new evidence source owes:

1. no evidence must **deep-equal** empty evidence
2. vouched candidates must win through the bonus **alone**, with every
   other term unchanged

And the hard constraint from `PRODUCT_DIRECTION.md`: **content must never
override an explicit shopper constraint.** "Under £200", "no leather",
"available in my size" outrank any campaign.

---

## 5. Tenant isolation

Sound, and content inherits it for free if it stays in-pattern.

- `lib/tenancy.ts` is the single chokepoint; nothing else reads the
  tenants table by key.
- Every tenant-owned index leads with `tenantId`; the vector index
  declares it as a filter field.
- `assertTenant` is belt-and-braces on top of already-scoped queries.
- `privacy.itest.ts` reads the schema and **fails the build** if a table
  with a `tenantId` field is missing from `purgeTenant`.

**The one blind spot, and P2 makes it worse.** That guard cannot see
Convex file storage. `looks.imageStorageId` is deleted explicitly, and
`looks.itest.ts` asserts storage is empty after a purge. Video content
means far more stored bytes and probably more than one asset per content
item — so any new storage reference needs the same explicit deletion and
its own assertion. This should be a stated precondition of P2, not a
thing discovered later.

---

## 6. Cost, and the pricing tension

Vision is metered per upload (`usageSink(ctx, tenantId, "vision")`), and
`UsageSink` is a required parameter, so a new call site cannot compile
without attributing spend. That part is ready.

The **pricing model** is not. `planForCatalog` tiers on product count,
on the sound reasoning that catalog size was the only thing that cost
anything real. Video breaks that: a merchant with 40 products and 200
campaign videos is cheap on the current model and expensive in reality.

Metering will attribute it correctly; the tiers will be wrong. §79 still
forbids exposing token pricing to merchants, so this is a packaging
question, not a passthrough one. Worth deciding before P2 ships, not
after.

Related and already open: **P2-7**, the Brand Brain rebuilding
unconditionally on every 6-hourly sweep. If approved content also feeds
the Brand Brain, that churn compounds. Better fixed before content lands
than after.

---

## 7. Documentation drift found by this audit

| Document | Says | Actually |
| --- | --- | --- |
| `CLAUDE.md` | "merchants install a single `<script>` tag"; "sold direct, not through the App Store"; theme app extension needed "for a listing" | the theme app extension exists and is the delivery path; the asset sync is in `npm run verify` |
| `PRODUCT_DIRECTION.md` | P2 = "Shopify App Embed distribution, replacing the pasted script tag" | largely done; what remains is Partner registration, deploy, and the entry point |

Both should be corrected as part of P2 rather than left to mislead the
next reader. The `/backend` Python prototype and the "Distribution"
section of `CLAUDE.md` describe a model the code has already left.

---

## 8. Recommended P2 sequence

Ordered so that each step is independently verifiable and none depends on
an external account that may take weeks.

| Step | Scope | External dependency |
| --- | --- | --- |
| **P2.1** | Entry point: implement `floating_button`, add a validated label field, keep P0.1's fail-closed mount | none |
| **P2.2** | Generalise `looks` → `content`: media type, provenance, external identity, bounded `detected`, multi-asset. Existing looks are images with an unchanged meaning | none |
| **P2.3** | `contentProducts` with anchors; split presence from compatibility; edge derivation becomes scope-explicit | none |
| **P2.4** | Video ingest as a durable job (`content_ingest`, `video_analysis`) using P1.1–P1.3 primitives; scene/timestamp model | none |
| **P2.5** | Merchant Content section in the dashboard: add, review, confirm, edit, archive, see usage | none |
| **P2.6** | Content-aware decision engine: capped additive evidence with the two cold-start assertions | none |
| **P2.7** | Partner registration, `shopify app deploy`, listing | **yes — start now, in parallel** |

Corrections to `CLAUDE.md` and `PRODUCT_DIRECTION.md` belong with P2.1.

---

## 9. Decisions needed before implementation

These are the user's to make; each changes what gets built.

1. **Entry-point copy.** Which label, and is it merchant-editable or
   fixed? Merchant-editable means validated, length-capped, and rendered
   into a storefront.
2. **Rename or extend?** `looks` → `content` is a clean name and nothing
   is deployed, so there is no migration cost — but every reference,
   test, dashboard route and doc changes with it. Extending in place
   keeps the diff small and leaves the name slightly wrong.
3. **Does a look remain a distinct concept**, or is "look" simply
   content whose co-presence scope is the whole item? I lean to the
   latter: one table, one approval flow, and scope as a field.
4. **Video scope granularity.** Scene-level requires either shot
   detection or merchant-defined ranges. Merchant-defined is cheaper and
   matches the "merchant confirms" principle; automatic is better UX and
   more expensive.
5. **Pricing.** Content volume needs a place in the model before the
   feature ships.

---

## What this audit did not do

No code was changed. No schema was added. No table was created.

The next step is a decision on §9, not an implementation.
