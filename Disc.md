# DISC — HYPER-DEEP B2B MASTER BUILD SPEC
## Shopify-native personalized commerce layer / Brand Brain / Fashion Decision Engine

> **This is the original implementation spec, kept as written.** Code
> comments reference its section numbers (§29, §73, §133 …), so the body
> is deliberately not rewritten. For the canonical product definition see
> `README.md`: *an AI-native personalized commerce layer for fashion brands that
> turns a Shopify store into a more personal shopping experience, helping
> people discover, style, compare, and decide what to buy from the
> brand's own catalog.* Where this file says "AI Boutique", read it as
> the name this spec gave the shopper experience — not as Disc's
> identity. Point 7 of §0 below already states the definition that
> stuck.

Repository: https://github.com/ENUID/disc.git
Company: Enuid Labs
Working product name: Disc

---

## 0. PURPOSE

This file is the implementation source of truth for turning the existing `ENUID/disc` prototype into a real B2B SaaS product for Shopify fashion brands.

Do not treat this as a list of ideas. Treat it as a product + architecture + implementation contract.

The final system must let a fashion brand:

1. install Disc on Shopify,
2. approve the required permissions,
3. let Disc automatically understand the store,
4. let Disc build a tenant-specific Brand Brain,
5. preview the AI Boutique,
6. activate it on the storefront without copying code,
7. let shoppers discover, style, compare and decide using the merchant's own catalog,
8. measure the resulting shopper/product/commerce activity,
9. pay for the product.

The shopper experience must feel like a native extension of the brand, not a generic chatbot.

The engineering objective is NOT "more agents". It is better decisions, reliable commerce facts, strong tenant isolation, fast iteration, and measurable recommendation quality.

---

# 1. CORE PRODUCT THESIS

Disc is an AI-native personalized commerce layer for fashion brands that
turns a Shopify store into a more personal shopping experience, helping
people discover, style, compare, and decide what to buy from the brand's
own catalog.

A precise internal definition:

> Disc combines a merchant-specific brand model, product intelligence, shopper context, commerce data, visual understanding, retrieval, compatibility reasoning, ranking, and AI explanation to help a shopper decide what to buy from that merchant's catalog.

The foundation model is not the product.

The product is:

```text
SHOPIFY DATA
+
BRAND BRAIN
+
PRODUCT INTELLIGENCE
+
SHOPPER STATE
+
DECISION ENGINE
+
STOREFRONT EXPERIENCE
+
COMMERCE ANALYTICS
```

---

# 2. WHAT DISC IS NOT

Do not build:

- ChatGPT with a fashion skin.
- A generic AI search widget.
- A Pinterest clone.
- A product grid with an LLM explanation.
- A separate LLM per merchant.
- A swarm of autonomous agents.
- A huge hard-coded fashion rule engine.
- A merchant setup flow with dozens of questions.
- A system that fabricates product facts.
- A product that requires merchants to paste API keys or edit theme code manually in the normal installation flow.

---

# 3. THE FOUR PRODUCTS INSIDE DISC

Think of Disc as four systems:

```text
1. SHOPIFY APP
   connects and authorizes the store

2. BRAND BRAIN
   learns the merchant's brand + catalog

3. DECISION ENGINE
   helps shoppers discover, style, compare and decide

4. MERCHANT CONTROL PLANE
   onboarding + configuration + analytics + billing
```

---

# 4. TARGET EXPERIENCE

Merchant:

```text
Find Disc
  ↓
Install on Shopify
  ↓
Approve permissions
  ↓
Disc connects
  ↓
"Getting to know your store..."
  ↓
Catalog sync
  ↓
Product understanding
  ↓
Brand understanding
  ↓
Brand Brain ready
  ↓
Merchant reviews
  ↓
Preview
  ↓
Activate
```

Shopper:

```text
Brand store
  ↓
Disc is available as a subtle AI Boutique
  ↓
"What are you looking for?"
or
"Style this"
or
"Complete the look"
or
"Compare"
  ↓
Disc understands current page + request
  ↓
Retrieves from THIS merchant only
  ↓
Constructs/ranks/judges options
  ↓
Shows visual result
  ↓
Shopper refines
  ↓
Add to cart / save / continue shopping
```

---

# 5. IMPORTANT PLATFORM PRINCIPLE

Do not implement Shopify integration from old tutorials.

Before implementing any Shopify-specific part, verify current official documentation for:

- authentication,
- GraphQL Admin API,
- access scopes,
- theme app extensions,
- app embed blocks,
- webhooks,
- billing,
- app distribution,
- privacy/data deletion.

Current Shopify documentation indicates new public apps should use GraphQL Admin API rather than the legacy REST Admin API. Current Shopify docs also provide AppInstallation/subscription objects, app embed blocks, webhook subscriptions, and theme-editor activation flows. Re-check the exact current requirements immediately before implementation or App Store submission.

---

# 6. REPOSITORY STRATEGY

The existing `ENUID/disc` repo already contains useful foundations.

Do NOT throw it away.

Known useful areas include:

- multi-tenant shop records,
- Shopify integration,
- public/self-serve site-key flow,
- catalog ingestion,
- product indexes,
- Stripe billing prototype,
- storefront widget,
- theme configuration,
- embeddings,
- local/provider model experiments,
- product normalization.

Current low-cost architecture was intentionally designed for prototype economics. Keep it while it works, but document its scaling boundaries.

Before changing code, create:

`DISC_REPO_AUDIT.md`

Classify every important subsystem:

```text
KEEP
REFACTOR
REPLACE
ADD
UNUSED
UNKNOWN
```

Do not guess.

---

# 7. TARGET ARCHITECTURE

```text
                    SHOPIFY
                      |
             +--------+--------+
             |                 |
          ADMIN API        THEME EXTENSION
             |                 |
             v                 v
       TENANT BACKEND      DISC WIDGET
             |
       +-----+------+
       |            |
    CATALOG      BRAND DATA
       |            |
       v            v
 PRODUCT MODEL   BRAND BRAIN
       |            |
       +-----+------+
             |
             v
       DECISION ENGINE
             |
   +---------+---------+---------+
   |         |         |         |
 INTENT   RETRIEVAL  STYLE   USER MODEL
   |         |         |         |
   +---------+---------+---------+
             |
        COMPATIBILITY
             |
        OUTFIT ENGINE
             |
           RANKER
             |
           JUDGE
             |
         DIVERSITY
             |
        EXPLANATION
             |
         VISUAL UI
             |
        SHOPPER ACTION
             |
          EVENTS
             |
        ANALYTICS
             |
        EVALUATION
```

---

# 8. MULTI-TENANT MODEL

Every merchant is a tenant.

Conceptually:

```text
tenant_id
shop_domain
shopify_shop_id
installation_id
access_scopes
encrypted_credentials
subscription
status
catalog_status
brand_brain_status
widget_status
created_at
updated_at
```

Every tenant-owned object must be tenant scoped.

A request must resolve:

```text
request
→ authenticated installation
→ tenant
→ tenant resources
```

Never:

```text
request
→ global product index
```

---

# 9. CROSS-TENANT SECURITY REQUIREMENT

These must be impossible:

- Brand A can retrieve Brand B products.
- Brand A's Brand Brain appears for Brand B.
- Brand A's shopper data appears for Brand B.
- Brand A's analytics appears for Brand B.
- Brand A's embeddings are searchable by Brand B.

Write automated tests for this.

---

# 10. SHOPIFY INSTALLATION

Target experience:

```text
Disc website / Shopify App Store
  ↓
Install
  ↓
Shopify authorization
  ↓
callback
  ↓
tenant creation
  ↓
background onboarding
  ↓
Disc app home
```

Merchant should NOT need to:

- paste an API key,
- export a product CSV,
- paste a script,
- edit `theme.liquid`.

The normal path should be automatic.

---

# 11. ACCESS SCOPES

Request only the scopes required by the current product.

Initial catalog-only product likely needs product/catalog related read access and other narrowly scoped permissions required for the chosen features.

Do NOT request customer/order data simply because it might be useful later.

If a future feature requires protected customer data, treat that as a separate product/security/Shopify approval decision.

---

# 12. SHOPIFY APP INSTALL CALLBACK

After authorization:

```text
receive callback
→ validate shop
→ persist secure session/access state
→ create/update tenant
→ save granted scopes
→ enqueue onboarding
→ redirect to merchant dashboard
```

Never expose credentials in browser code.

Never log tokens.

---

# 13. STOREFRONT ACTIVATION

Use a Shopify Theme App Extension / App Embed architecture for the production storefront integration.

Target:

```text
Merchant installs
→ Disc prepares embed
→ merchant previews
→ theme editor activation path
→ Disc appears on store
```

Where current Shopify supports an activation deep link, use it.

Do not silently edit theme source code.

The widget must be removable/disableable without damaging the merchant storefront.

---

# 14. STOREFRONT FAILURE PRINCIPLE

If Disc is unavailable:

```text
Shopify store still works.
Checkout still works.
Theme still works.
```

Disc is an enhancement.

It must never become a single point of failure for the merchant's storefront.

---

# 15. MERCHANT WEBSITE

Build a separate merchant website/control plane.

Routes:

```text
/
 /product
 /how-it-works
 /pricing
 /demo
 /login
 /signup
 /app
 /app/onboarding
 /app/overview
 /app/brand
 /app/catalog
 /app/experience
 /app/analytics
 /app/billing
 /app/settings
 /privacy
 /terms
```

The public site sells Disc.

The `/app` area operates Disc.

The Shopify storefront embed is the shopper-facing product.

---

# 16. MARKETING WEBSITE

Homepage should explain:

> Turn your Shopify store into an AI boutique.

Supporting message:

> Disc learns your catalog and brand, then helps shoppers discover, style, compare and decide what to buy.

Primary CTA:

```text
Install on Shopify
```

Secondary:

```text
See a live demo
```

Do not lead with infrastructure jargon.

---

# 17. MERCHANT ONBOARDING

Do not ask dozens of questions.

Automatic process:

```text
Connect Shopify
→ Disc reads allowed store data
→ catalog sync
→ representative visual analysis
→ full enrichment in background
→ Brand Brain
→ merchant review
→ preview
→ activate
```

The merchant should primarily correct Disc, not manually teach Disc everything.

---

# 18. ONBOARDING PROGRESS

Show truthful stages:

```text
Connected to Shopify
Reading your catalog
Understanding your products
Learning your brand
Preparing your AI Boutique
Ready to preview
```

Do not fake progress.

Progress events should come from real job state.

---

# 19. BRAND REVIEW SCREEN

Show:

```text
YOUR BRAND

Style:
Minimal / Tailored / Contemporary

Common palette:
Cream / Navy / Camel

Common silhouettes:
Relaxed / Structured

Typical formality:
Smart casual → Formal

Strong categories:
Tops / Trousers / Outerwear
```

Actions:

```text
Looks right
Edit
```

Do not make the merchant configure 50 variables.

---

# 20. BRAND BRAIN

Brand Brain is NOT one giant prompt.

It is structured tenant intelligence.

Sections:

```text
Identity
Visual language
Tone
Style
Product world
Silhouettes
Materials
Palette
Formality
Occasions
Styling relationships
Merchandising priorities
Excluded behaviors
```

Version:

```text
brand_brain_version
```

Every recommendation trace records which version was used.

---

# 21. BRAND VISUAL PROFILE

Possible data:

```text
surface
foreground
accent
muted
border
radius
heading font
body font
spacing density
card style
image ratio
motion intensity
```

Model outputs must map to approved design tokens.

Do NOT let the model write arbitrary CSS/JS.

---

# 22. BRAND VOICE

Structured data:

```json
{
  "tone": ["quiet", "warm", "editorial"],
  "preferred_terms": ["collection", "piece", "look"],
  "avoid_terms": ["cheap", "deal", "must-have"]
}
```

This adapts the wording without modifying the underlying reasoning.

---

# 23. BRAND STYLE MODEL

Represent style as weighted characteristics, not one label.

Example:

```json
{
  "minimal": 0.82,
  "classic": 0.74,
  "tailored": 0.71,
  "streetwear": 0.05
}
```

A brand can be a mixture.

---

# 24. BRAND PRODUCT WORLD

Automatically derive:

- categories,
- subcategories,
- recurring silhouettes,
- materials,
- colors,
- price ranges,
- collections,
- seasonal patterns,
- new-arrival patterns,
- best-seller patterns where accessible.

---

# 25. BRAND MERCHANDISING PRIORITIES

Merchant should be able to set simple priorities:

```text
Prioritize:
[New arrivals]
[Core collection]
[Best sellers]
[Seasonal]
[High margin]
```

These become ranking boosts, not hard overrides.

Shopper constraints take priority over merchant promotion.

---

# 26. PRODUCT MODEL

Every product needs two layers:

## Source layer

```text
product id
title
description
brand/vendor
price
currency
URL
images
variants
inventory/availability
category
collections
```

## Disc intelligence layer

```text
garment
fit
volume
silhouette
fabric
weight
drape
pattern
pattern scale
color
color family
formality
style vector
occasion vector
season vector
logo level
graphic level
visual weight
confidence
provenance
```

Never overwrite source facts with model inference.

---

# 27. PRODUCT PROVENANCE

For each inferred field store:

```text
value
source
model
confidence
version
timestamp
```

Sources:

```text
merchant
shopify
text_model
vision_model
rule
human
```

---

# 28. PRODUCT ATTRIBUTE TAXONOMY

Minimum controlled vocabulary:

Garments:

```text
shirt
t-shirt
polo
blouse
sweater
hoodie
trouser
jeans
chinos
shorts
skirt
dress
jumpsuit
jacket
blazer
coat
suit
vest
sneaker
loafer
boot
derby
sandal
heel
flat
bag
belt
hat
scarf
jewelry
watch
```

Include regional/cultural garments when the catalog requires them.

Fit:

```text
skinny
slim
regular
relaxed
oversized
wide
tailored
cropped
```

Volume:

```text
fitted
boxy
```

Weight:

```text
light
medium
heavy
```

Drape:

```text
crisp
fluid
structured
```

Pattern:

```text
plain
stripe
check
floral
graphic
geometric
textured
```

Pattern scale:

```text
none
small
medium
large
```

Style:

```text
classic
minimal
preppy
streetwear
workwear
smart_casual
formal
romantic
resort
sport
vintage
avant_garde
```

---

# 29. PRODUCT INGESTION PIPELINE

```text
Shopify
 ↓
page/pagination fetch
 ↓
raw source storage
 ↓
canonical product normalization
 ↓
attribute extraction
 ↓
image/vision enrichment
 ↓
merge
 ↓
quality check
 ↓
embedding
 ↓
tenant product index
```

Do not do the entire enrichment job synchronously during installation.

Use background jobs.

---

# 30. INCREMENTAL PRODUCT SYNC

Subscribe to the relevant Shopify product/catalog events supported by the current platform.

Webhook flow:

```text
webhook
 ↓
verify authenticity
 ↓
resolve tenant
 ↓
parse event
 ↓
update source product
 ↓
invalidate derived profile if needed
 ↓
enqueue enrichment
```

Also run periodic reconciliation to recover from missed events.

---

# 31. PRODUCT ENRICHMENT CACHING

Do not vision-analyze a product on every shopper request.

Cache using:

```text
tenant
product_id
image/content version
profile schema version
vision prompt version
model version
```

If unchanged:

```text
reuse enrichment
```

---

# 32. VISION MODEL ROLE

Vision model should extract only visible/inferable fashion information:

```text
garment type
apparent fit
silhouette
volume
pattern
pattern scale
color
visual weight
visible material cues
logo/graphic prominence
styling context
```

If not visible:

```text
unknown
```

Do not hallucinate hidden garment properties.

---

# 33. TEXT MODEL ROLE

Use text reasoning for:

- product description interpretation,
- style semantic classification,
- occasion classification,
- collection interpretation,
- brand language,
- ambiguous category interpretation.

---

# 34. EMBEDDING ROLE

Embeddings are for:

- semantic retrieval,
- "more like this",
- visual similarity,
- style similarity.

Embeddings are NOT the compatibility engine.

A product can be semantically similar but stylistically incompatible.

---

# 35. TENANT VECTOR INDEX

Current prototype uses per-shop indexing. That can remain for early scale.

Every vector search must be tenant scoped.

Do not create one global index without a tenant filter.

Test tenant isolation.

---

# 36. SHOPPER MODEL

Two levels:

## Session state

```text
current query
occasion
context
budget
style
fit
negative preferences
locked products
current outfit
```

## Persistent profile

```text
explicit preferences
saved products
saved outfits
repeated acceptances
repeated rejections
```

Do not infer sensitive characteristics.

---

# 37. SESSION STATE IS THE MEMORY

Do NOT make the LLM remember everything through conversation history.

Store structured state.

Example:

```json
{
  "occasion": "dinner",
  "formality": 0.55,
  "style": ["minimal"],
  "budget": 300,
  "avoid": ["skinny"],
  "locked": {
    "top": "p123",
    "bottom": "p456"
  }
}
```

---

# 38. INTENT ENGINE

Two paths:

## Simple requests

Use deterministic parsing when obvious.

Example:

```text
"black linen shirt under $100"
```

## Complex/ambiguous requests

Use reasoning model.

Example:

```text
"I want something expensive-looking without looking flashy."
```

The deterministic path must never discard meaningful semantic residue.

If the parser cannot interpret a meaningful phrase, hand it to the reasoning layer.

---

# 39. INTENT OUTPUT

Example:

```json
{
  "workflow": "outfit",
  "occasion": "dinner",
  "formality": 0.55,
  "style_positive": ["minimal"],
  "style_negative": ["flashy"],
  "fit_negative": ["skinny"],
  "budget": {
    "amount": 300,
    "currency": "USD"
  }
}
```

Validate with a runtime schema.

---

# 40. FOLLOW-UP TRANSFORMS

"Make it cheaper."

```text
existing session
→ lower budget
→ keep everything else
```

"Make it less formal."

```text
existing session
→ lower formality target
```

"Change the shoes."

```text
existing outfit
→ lock all non-shoe slots
→ only search shoes
```

---

# 41. SHOPPER ENTRY POINTS

The widget can expose:

```text
What are you looking for?
Style this
Complete the look
Find similar
Compare
```

These all invoke the same underlying engine through different workflows.

---

# 42. PAGE CONTEXT

If shopper is on a product page, Disc should know safe page context:

```text
tenant
product_id
collection_id
page_type
```

"Style this" should not require shopper to explain which product.

---

# 43. DECISION ENGINE WORKFLOWS

Minimum:

```text
PRODUCT_SEARCH
SIMILAR
STYLE_PRODUCT
COMPLETE_LOOK
OUTFIT
COMPARE
REFINE
```

---

# 44. CATALOG RETRIEVAL

Flow:

```text
intent
→ query plan
→ Shopify catalog search
→ candidate pool
→ normalization
→ hard filters
→ semantic retrieval
→ fashion-aware ranking
```

UCP/Shopify remains the source of merchant catalog truth.

Disc owns the intelligence above it.

---

# 45. RETRIEVAL VS COMPATIBILITY VS RANKING VS JUDGING

Never collapse these.

Retrieval:

> Could this be relevant?

Compatibility:

> Do these pieces actually work together?

Ranking:

> Which valid options are strongest for this shopper?

Judge:

> Is the final recommendation actually coherent?

---

# 46. CANDIDATE GENERATION

Example:

```text
30 tops
30 bottoms
20 shoes
= 18,000 combinations
```

Never send all to a frontier model.

Use:

```text
category filters
availability
budget
brand rules
obvious conflicts
compatibility pre-score
```

to reduce candidate count.

Example target:

```text
18,000
→ 3,000
→ 500
→ 100
→ 20
→ 5 final
```

Thresholds configurable.

---

# 47. HARD CONSTRAINTS

Hard constraints usually include:

```text
tenant
category
valid product ID
availability
explicit banned attribute
strict budget
```

A hard conflict should reject a candidate.

---

# 48. SOFT SIGNALS

Soft signals:

```text
color harmony
style coherence
silhouette
formality
occasion
season
brand fit
shopper taste
```

Use scores/penalties.

---

# 49. COMPATIBILITY ENGINE

Conceptually:

```text
pair_score =
color
+ silhouette
+ formality
+ style
+ material/weight
+ pattern
+ occasion
+ shopper fit
```

Then whole-outfit score also considers:

```text
composition
proportion
cohesion
brand coherence
```

Do not assume one universal static set of weights forever.

Start configurable.

Learn later from outcomes.

---

# 50. COLOR REASONING

Represent:

```text
hue
lightness
saturation
family
contrast
temperature
```

Relationships:

```text
tonal
analogous
complementary
neutral
high contrast
low contrast
```

Do not make color theory rigid.

Context matters.

---

# 51. SILHOUETTE REASONING

Evaluate relationships such as:

```text
relaxed + straight
fitted + wide
boxy + slim
cropped + high-rise
structured + fluid
```

The model should reason about the whole outfit, not isolated product labels.

---

# 52. FORMALITY MODEL

Use a normalized scale such as:

```text
0 = very casual
1 = casual
2 = smart casual
3 = polished
4 = formal
5 = highly formal
```

Exact implementation can evolve.

The point is that incompatible formality gaps should be penalized.

---

# 53. STYLE MODEL

Represent style as a vector/weighted tags rather than one label.

Example:

```json
{
  "minimal": 0.8,
  "classic": 0.75,
  "streetwear": 0.1
}
```

This permits partial overlap.

---

# 54. BRAND COHERENCE

Every recommendation must answer:

> Would this combination plausibly belong inside this merchant's world?

This is a distinct score.

A fashion-valid outfit can still be wrong for the merchant.

---

# 55. MERCHANDISING BOOSTS

The merchant may want certain products prioritized.

But hierarchy:

```text shopper hard constraint
>
product validity
>
brand coherence
>
fashion quality
>
merchandising boost
```

Merchandising cannot override explicit shopper needs.

---

# 56. OUTFIT OBJECT

Structured:

```json
{
  "slots": {
    "top": "p123",
    "bottom": "p456",
    "shoes": "p789",
    "outerwear": null,
    "accessories": []
  },
  "direction": "Quiet evening",
  "scores": {},
  "issues": [],
  "confidence": 0.84
}
```

---

# 57. JUDGE / CRITIC

The judge receives:

```text
shopper request
session state
brand context
product profiles
outfit
images if relevant
```

Returns structured:

```json
{
  "overall": 0.91,
  "color": 0.94,
  "silhouette": 0.87,
  "formality": 0.96,
  "style": 0.90,
  "occasion": 0.95,
  "brand": 0.92,
  "shopperFit": 0.88,
  "issues": [],
  "confidence": 0.82
}
```

Judge does not invent products.

---

# 58. INDEPENDENT JUDGE PRINCIPLE

Do not ask the generator to simply explain why its own result is good.

Generator:

```text
create
```

Judge:

```text
challenge
```

Then rank.

---

# 59. DIVERSITY

Final results should be meaningfully different.

Possible diversity dimensions:

```text
palette
silhouette
formality
shoe type
style direction
brand collection concentration
```

Return 3–5 strong alternatives.

Not 20 mediocre products.

---

# 60. EXPLANATION ENGINE

Explanations are generated from actual evidence:

```text
selected products
score components
shopper constraints
brand context
```

Example:

> The relaxed trouser keeps the jacket from feeling too formal, while the lower-profile shoe keeps the look understated.

Do not invent reasons.

---

# 61. SLOT-LEVEL REFINEMENT

If shopper says:

"Change the shoes."

Represent:

```text
locked = top, bottom, outerwear
target = shoes
```

Search only the target slot.

Preserve all other constraints.

---

# 62. VISUAL UI

Do NOT make the storefront experience a chat transcript.

Primary hierarchy:

```text
visual product/outfit
>
short explanation
>
actions
```

Actions:

```text
Keep
Change
Compare
Save
See alternatives
Why this
```

---

# 63. WIDGET DESIGN

Use:

- floating entry,
- bottom sheet/full-screen panel on mobile,
- full-screen or centered panel on desktop,
- brand tokens,
- minimal UI chrome,
- smooth but restrained motion,
- accessible controls.

The merchant's normal storefront remains visible whenever appropriate.

---

# 64. BRAND-ADAPTIVE VISUAL LANGUAGE

The widget should inherit brand context.

For a quiet-luxury brand:

```text
airy
restrained
editorial
soft motion
minimal controls
```

For streetwear:

```text
denser
bolder
more expressive
```

Same component system.

Different design tokens.

---

# 65. NO ARBITRARY AI-GENERATED CSS

Brand Brain produces controlled configuration.

Example:

```json
{
  "density": "airy",
  "motion": "subtle",
  "cardStyle": "editorial",
  "cornerRadius": "small"
}
```

Renderer maps this to known design tokens.

---

# 66. MOBILE UX

Mobile should be designed independently.

Prefer:

```text
bottom sheet
full-screen AI Boutique
swipeable looks
large product images
```

No tiny desktop-style chat window.

---

# 67. PRODUCT PAGE

Product page entry:

```text
Style this
Complete the look
More like this
```

The current product is locked.

---

# 68. COLLECTION PAGE

Entry:

```text
Find my look
Show me how to wear this collection
Build an outfit
```

Current collection can be part of context.

---

# 69. HOME PAGE

Entry:

```text
What are you looking for?
```

Optional editorial examples.

Do not cover the homepage with AI branding.

---

# 70. MERCHANT DASHBOARD

Required sections:

```text
Overview
Brand
Catalog
AI Boutique
Analytics
Billing
Settings
```

---

# 71. OVERVIEW

Show:

```text
Disc status
Catalog health
Brand Brain status
Widget status
AI-assisted discovery
AI-assisted product clicks
AI-assisted add-to-cart
```

---

# 72. BRAND DASHBOARD

Show:

```text
Brand identity
Style profile
Palette
Product world
Language
Merchandising
```

Allow merchant correction.

---

# 73. CATALOG DASHBOARD

Show:

```text
Products
Indexed
Enriched
Missing data
Low confidence
Failed enrichment
Last sync
```

---

# 74. EXPERIENCE DASHBOARD

Controls:

```text
Enable/disable
Widget placement
Greeting
Brand style
Allowed workflows
```

Keep controls high-level.

---

# 75. ANALYTICS DASHBOARD

Prefer business metrics:

```text
AI sessions
Products discovered
Product clicks
Outfit saves
Add to cart
Checkout starts
AI-assisted revenue
Repeat AI usage
```

Do not present "messages processed" as the main value metric.

---

# 76. BILLING

Current prototype has Stripe billing.

For the production Shopify App Store architecture, verify current Shopify app subscription/billing rules and prefer the Shopify-native model where appropriate.

For a private/direct pilot, Stripe can remain if it is materially faster for early sales.

Do not maintain competing subscription sources without a deliberate reason.

---

# 77. PRICING HYPOTHESIS

Initial direct-sales pricing:

```text
Pilot      $149–$299/mo
Growth     $499–$799/mo
Enterprise $1,500+/mo
```

These are hypotheses to test.

Do not lock them as universal truth.

---

# 78. WHAT JUSTIFIES THE PRICE

At ~$500/mo Disc should provide:

```text
one-click Shopify connection
automatic catalog sync
brand learning
product intelligence
AI Boutique
style this
complete the look
comparison
refinement
merchant analytics
reliable storefront integration
```

The price is justified by merchant value, not the number of AI calls.

---

# 79. BILLING METRIC

Potential eventual pricing:

```text
base subscription
+
catalog/traffic/AI usage tier
```

Do not expose token pricing to merchants.

---

# 80. ANALYTICS EVENT MODEL

Events:

```text
widget_opened
query_submitted
intent_created
catalog_search
outfit_generated
outfit_viewed
product_viewed
product_clicked
product_saved
outfit_saved
slot_swapped
refinement_requested
comparison_started
add_to_cart
checkout_started
purchase
error
```

Each event should include:

```text
tenant
session
timestamp
recommendation_id if applicable
product_ids if applicable
```

---

# 81. RECOMMENDATION TRACE

Every result should be traceable:

```text
recommendation_id
tenant_id
session_id
brand_brain_version
product_profile_versions
retrieval_version
ranker_version
judge_version
model/provider
prompt versions
candidate IDs
final IDs
score components
fallback status
latency
estimated cost
```

---

# 82. DEBUG PANEL

Internal support dashboard:

```text
Request
Intent
Brand Brain
Shopper state
Queries
Candidates
Filters
Scores
Judge
Final output
Model calls
Latency
Cost
Errors
```

This is how the team will diagnose:

> "Why did Disc recommend that?"

---

# 83. AI MODEL ARCHITECTURE

Do not hardcode one vendor.

Interfaces:

```text
ReasoningProvider
VisionProvider
EmbeddingProvider
```

Model routing:

```text
simple parsing
→ deterministic/cheap

semantic extraction
→ efficient model

vision enrichment
→ efficient vision model

complex reasoning
→ stronger model

judge
→ strong model or specialized evaluator
```

Benchmark.

---

# 84. PROMPT REGISTRY

Prompts:

```text
brand_extract_v1
product_profile_v1
intent_parse_v1
outfit_generate_v1
outfit_judge_v1
explanation_v1
```

Each response records prompt version.

No giant prompt hidden in a route file.

---

# 85. MODEL OUTPUT VALIDATION

Every AI output used by code must pass schema validation.

If invalid:

```text
repair/retry
→ fallback
```

Never accept arbitrary model prose as trusted state.

---

# 86. COST CONTROLS

Required:

- cache product profiles,
- cache embeddings,
- batch enrichment,
- limit candidates,
- parallelize independent work,
- use cheaper model for simple tasks,
- token budgets,
- image-size control,
- timeout,
- retry limit.

---

# 87. BACKGROUND JOBS

At minimum:

```text
initial_catalog_sync
product_enrichment
embedding_generation
brand_brain_build
product_update
brand_refresh
analytics_aggregation
evaluation_run
```

Expensive AI should not block Shopify webhooks.

---

# 88. JOB IDEMPOTENCY

Jobs can run twice safely.

Use a deterministic key such as:

```text
tenant + product + version + job_type
```

---

# 89. CATALOG RECONCILIATION

Webhooks can miss events or jobs can fail.

Run periodic reconciliation:

```text
source catalog
vs
Disc catalog
```

Repair differences.

---

# 90. SECURITY

Mandatory:

- server-side API keys,
- encrypted credential storage,
- authorization,
- tenant checks,
- rate limiting,
- output validation,
- tool permission checks,
- secure webhook verification,
- no secrets in logs.

---

# 91. SHOPIFY WEBHOOK SECURITY

Webhook handler:

```text
raw body
→ signature verification
→ parse
→ tenant resolution
→ idempotent processing
→ fast acknowledgement
```

Never enqueue expensive AI before validating authenticity.

---

# 92. PRIVACY

Document:

- what merchant data is read,
- what shopper data is stored,
- retention periods,
- personalization usage,
- deletion behavior,
- model/provider processing,
- whether merchant data is ever used across tenants.

Default:

```text
merchant data is tenant-specific.
```

Do not train shared models on merchant private data without an explicit product/legal decision.

---

# 93. UNINSTALL

When uninstalled:

```text
disable widget
stop tenant jobs
revoke sessions as appropriate
follow Shopify deletion requirements
retain/delete data according to policy
record state
```

Verify current Shopify privacy requirements before App Store submission.

---

# 94. PERFORMANCE

The storefront widget must not block rendering.

Use:

```text
lazy loading
code splitting
small initial bundle
cached tenant config
request on interaction
async enrichment
```

Disc must degrade gracefully if backend latency is high.

---

# 95. REQUEST LATENCY STRATEGY

For normal query:

```text
intent
→ catalog retrieval
→ ranking
→ result
```

Run independent requests in parallel.

Do not do 10 sequential model calls if 4 can run concurrently.

---

# 96. NO-RESULT STATE

If no strong result:

```text
I couldn't find a strong match for everything you asked for.

Here are the closest options and what changes in each.
```

Never fabricate.

---

# 97. LOW-CONFIDENCE STATE

If confidence is low:

```text
I found a few possibilities, but I'm less certain about the style match.
```

Be honest.

---

# 98. EVALUATION SUITE

Build 100–300 benchmark cases.

Categories:

```text
search
similar
style this
complete the look
outfit
compare
refine
budget
negative preference
occasion
weather
brand-specific
no result
```

---

# 99. EVALUATION DIMENSIONS

Measure:

```text
category correctness
constraint satisfaction
brand coherence
fashion coherence
style coherence
formality
occasion
fact accuracy
availability accuracy
diversity
latency
cost
```

---

# 100. HUMAN REVIEW

Have fashion-aware reviewers score:

```text
Would this work?
Does it fit the requested style?
Does it fit the brand?
Would a real shopper plausibly choose it?
What is wrong?
```

Store labels.

---

# 101. ERROR TAXONOMY

Use:

```text
wrong_category
wrong_brand_style
wrong_color
wrong_silhouette
wrong_fit
wrong_formality
wrong_occasion
wrong_season
wrong_material
wrong_budget
bad_outfit
duplicate
hallucinated_fact
availability_error
constraint_loss
conversation_state_loss
tenant_leak
```

---

# 102. LEARNING LOOP

Do not let one user event rewrite production behavior.

Correct:

```text
events
→ aggregation
→ pattern
→ hypothesis
→ offline evaluation
→ controlled experiment
→ deploy
```

---

# 103. FUTURE SPECIALIZED MODELS

Do not build a new LLM initially.

Later, proprietary data can support:

```text
compatibility ranker
outfit ranker
shopper preference model
attribute classifier
```

Train only when benchmarks justify it.

---

# 104. SHARED FASHION KNOWLEDGE

Shared knowledge can contain:

```text
color relationships
silhouette concepts
occasion conventions
formality
material/weight concepts
pattern relationships
general styling principles
```

Tenant knowledge contains:

```text
brand style
catalog
brand language
merchant rules
```

Shopper knowledge contains:

```text
personal preferences
history
session
```

Keep these separate.

---

# 105. CONTEXT ASSEMBLY

Every complex model request gets:

```text
system rules
+
relevant brand context
+
shopper session
+
current product(s)
+
retrieved candidates
+
relevant fashion knowledge
```

Do not send the full catalog or full conversation every time.

---

# 106. ORCHESTRATOR

The orchestrator should be a controlled decision workflow system.

It may call:

```text
get_brand_brain
get_shopper_profile
get_session
search_catalog
get_product
get_product_profile
find_similar
find_compatible
generate_outfits
score_outfit
judge_outfit
select_diverse
update_session
record_event
```

It must enforce:

```text
tenant
permissions
time budget
tool count
candidate limit
```

---

# 107. DO NOT USE AUTONOMOUS AGENTS FOR SIMPLE TASKS

Simple:

```text
change shoes
save product
compare two products
```

should be deterministic workflows.

Complex:

```text
ambiguous fashion request
multiple constraints
uncertain intent
```

may use reasoning/tool selection.

---

# 108. DATABASE TABLE CONCEPTS

Minimum conceptual entities:

```text
Tenant
ShopInstallation
Subscription
Product
ProductVariant
ProductFashionProfile
ProductEmbedding
Collection
BrandBrain
BrandBrainVersion
ShopperProfile
ShopperSession
Recommendation
Outfit
RecommendationTrace
Event
EvaluationCase
EvaluationRun
WidgetConfig
ThemeConfig
```

Exact implementation should respect the current repo's chosen database first.

Do not migrate to another database just because another technology sounds more scalable.

---

# 109. CURRENT LOW-COST INFRASTRUCTURE

The current prototype intentionally uses inexpensive/local components.

Keep current infrastructure while validating the product.

Migrate only when:

```text
multi-process deployment
high traffic
availability
data volume
background jobs
```

justify it.

Do not buy GPUs.

Do not build Kubernetes.

Do not add complex infrastructure just to look production-ready.

---

# 110. CURRENT VECTOR STORAGE

If LanceDB per-tenant indexes work for the current early deployment, retain them initially.

Document the limit:

```text
single process
local persistence
```

When scaling beyond that, evaluate:

```text
pgvector
managed vector database
hosted LanceDB-like service
```

Only after the requirement exists.

---

# 111. CURRENT BILLING

The current repo contains Stripe billing code and catalog-size-based placeholder plans.

For direct early pilots, Stripe can be retained.

For public Shopify app distribution, verify Shopify's current app subscription/billing model and decide whether Shopify-native billing should become the source of truth.

Never have two active billing sources without reconciliation logic.

---

# 112. PRICING

Recommended starting hypothesis:

```text
Pilot:       $149–$299/month
Growth:      $499–$799/month
Enterprise:  $1,500+/month
```

Test with actual merchants.

The first goal is not perfect pricing.

The first goal is to prove:

```text
merchant pays
+
merchant keeps using
+
merchant sees value
```

---

# 113. $500/MONTH VALUE REQUIREMENT

A merchant at this tier should receive:

```text
automatic installation
catalog sync
brand learning
product intelligence
AI Boutique
Style This
Complete the Look
comparison
refinement
analytics
support
```

The merchant should not need an engineer to maintain it.

---

# 114. FIRST 5 CUSTOMERS

For first customers:

- manual onboarding is acceptable,
- manual QA is acceptable,
- manual brand review is acceptable,
- manual support is acceptable.

But build the automation so every manual step becomes a future product capability.

---

# 115. FIRST 5 CUSTOMER SUCCESS CRITERIA

For each:

```text
install completed
brand brain plausible
widget live
at least one useful AI flow
recommendations accepted
merchant understands analytics
merchant willing to pay
```

---

# 116. MERCHANT SUPPORT

Support tool should expose:

```text
tenant
store
widget version
brand brain version
recommendation ID
session ID
error
```

No secret credentials.

---

# 117. VERSIONING

Track:

```text
app version
widget version
brand brain version
fashion schema version
product profile version
embedding version
ranker version
judge version
prompt version
```

This is required to reproduce recommendations.

---

# 118. RELEASE PROCESS

Each release:

```text
change
→ unit tests
→ integration tests
→ AI benchmark
→ regression check
→ deploy staging
→ test Shopify dev store
→ production
```

---

# 119. CLAUDE CODE RULES

Claude Code must:

1. Read this entire file.
2. Read the existing repository.
3. Audit before changing.
4. Reuse existing working components.
5. Never rewrite everything at once.
6. Never invent Shopify APIs.
7. Never invent product facts.
8. Never introduce dependencies without a reason.
9. Never remove a feature without identifying its replacement.
10. Keep tenant isolation explicit.
11. Validate all model output.
12. Add tests for deterministic logic.
13. Add evaluation cases for AI changes.
14. Keep recommendation traces.
15. Keep provider adapters separate.
16. Never expose secrets.
17. Stop when a product decision is genuinely ambiguous.

---

# 120. CLAUDE CODE PHASE 0 PROMPT

Paste this into Claude Code after putting this document into the repo:

```text
Read DISC_B2B_HYPERDEEP_END_TO_END_MASTER_SPEC.md in full.

Do NOT modify code yet.

Audit the existing ENUID/disc repository against this specification.

Produce DISC_REPO_AUDIT.md containing:

1. Current app architecture
2. Current Shopify auth/install architecture
3. Current access scopes
4. Current tenant model
5. Current catalog ingestion
6. Current vector/index architecture
7. Current product model
8. Current AI/model providers
9. Current prompts
10. Current widget architecture
11. Current theme system
12. Current merchant dashboard
13. Current billing
14. Current recommendation flow
15. Current outfit flow
16. Current analytics
17. Current tests
18. Current deployment
19. Current security risks
20. Current privacy/data handling

For every subsystem classify:

KEEP
REFACTOR
REPLACE
ADD
UNKNOWN

Use exact file paths.

Do not guess.

Do not implement anything.

Stop after the audit and wait for approval.
```

---

# 121. CLAUDE CODE PHASE IMPLEMENTATION TEMPLATE

For every phase, use:

```text
PHASE:
[one specific phase]

GOAL:
[exact measurable outcome]

IN SCOPE:
[files/features]

OUT OF SCOPE:
[everything else]

INPUT:
[exact input]

OUTPUT:
[exact output]

DATA CHANGES:
[schemas/tables]

AI CHANGES:
[models/prompts/tools]

UI CHANGES:
[components/routes]

FAILURE HANDLING:
[behavior]

TESTS:
[exact tests]

EVALUATION:
[AI quality cases]

ACCEPTANCE:
[pass/fail criteria]
```

---

# 122. IMPLEMENTATION PHASES

## Phase 0
Audit only.

## Phase 1
Shopify app installation/auth.

## Phase 2
Tenant + secure persistence.

## Phase 3
Catalog sync + webhooks + reconciliation.

## Phase 4
Canonical product model.

## Phase 5
Product enrichment + vision + embeddings.

## Phase 6
Brand Brain.

## Phase 7
Merchant onboarding/review.

## Phase 8
Theme app embed + storefront widget.

## Phase 9
Intent/session/decision engine.

## Phase 10
Compatibility + outfit engine.

## Phase 11
Ranking + judge + diversity.

## Phase 12
Shopper feedback + analytics.

## Phase 13
Merchant dashboard.

## Phase 14
Billing.

## Phase 15
Evaluation/evolution.

## Phase 16
Production hardening.

---

# 123. PHASE 1 DETAILED ACCEPTANCE

A fresh development store:

```text
install Disc
→ authorize
→ callback succeeds
→ tenant created
→ app home loads
```

No manual code insertion.

---

# 124. PHASE 3 DETAILED ACCEPTANCE

After catalog sync:

```text
source product count
=
Disc source product count
```

within defined reconciliation behavior.

Product update event:

```text
Shopify changes product
→ webhook
→ source update
→ enrichment invalidation
→ updated index
```

---

# 125. PHASE 5 DETAILED ACCEPTANCE

Given a product with an image:

```text
Disc stores source metadata
+
fashion profile
+
confidence
+
provenance
+
embedding
```

Same unchanged product requested again:

```text
no unnecessary new vision call
```

---

# 126. PHASE 6 DETAILED ACCEPTANCE

For a merchant:

Disc automatically produces:

```text
style profile
palette
formality
category distribution
silhouette distribution
language style
```

Merchant can correct.

Correction affects future ranking/context.

---

# 127. PHASE 8 DETAILED ACCEPTANCE

Merchant can:

```text
preview
activate
disable
```

Widget:

- works on desktop,
- works on mobile,
- does not break theme,
- does not block checkout,
- respects reduced motion,
- does not expose secrets.

---

# 128. PHASE 9 DETAILED ACCEPTANCE

Request:

```text
"I want a relaxed dinner outfit under $300."
```

System produces structured intent.

Follow-up:

```text
"Make it less formal."
```

The system preserves the original context.

---

# 129. PHASE 10 DETAILED ACCEPTANCE

Request:

```text
"Style this jacket."
```

Output:

```text
3–5 plausible complete looks
```

All products must be from the merchant.

---

# 130. PHASE 11 DETAILED ACCEPTANCE

The top results must pass:

```text
hard constraints
+
category correctness
+
brand coherence
+
fashion coherence
```

Final results should be meaningfully diverse.

---

# 131. PHASE 12 DETAILED ACCEPTANCE

User actions generate events.

Attribution links:

```text
recommendation
→ product click
→ add-to-cart
→ checkout/purchase
```

where technically measurable.

---

# 132. PHASE 13 DETAILED ACCEPTANCE

Merchant can see:

```text
store status
brand status
catalog status
AI usage
product discovery
commerce impact
```

---

# 133. PHASE 14 DETAILED ACCEPTANCE

Merchant can:

```text
start trial
subscribe
upgrade
cancel
```

and Disc correctly changes access state.

---

# 134. PHASE 15 DETAILED ACCEPTANCE

Every major AI/ranking release can be evaluated against a fixed benchmark.

No silent quality regression.

---

# 135. EXAMPLE COMPLETE SHOPPER REQUEST TRACE

User:
"I need something understated for dinner tonight."

System:

```text
1. Resolve tenant.
2. Load current brand summary.
3. Load page context if relevant.
4. Parse intent.
5. Resolve location/time/weather if available and permitted.
6. Build outfit plan.
7. Search merchant catalog.
8. Retrieve candidate tops/bottoms/shoes.
9. Apply hard filters.
10. Enrich missing product profiles.
11. Generate combinations.
12. Compute compatibility.
13. Apply brand coherence.
14. Apply shopper preferences.
15. Rank.
16. Judge top candidates.
17. Diversify.
18. Generate explanation.
19. Render visual result.
20. Record recommendation trace.
21. Record shopper actions.
```

---

# 136. EXAMPLE "STYLE THIS" TRACE

```text
product page
→ product_id = X
→ load product profile
→ load tenant brand brain
→ load shopper state
→ lock X
→ retrieve compatible products
→ build looks
→ rank
→ judge
→ return 3–5
```

---

# 137. EXAMPLE SLOT SWAP TRACE

```text
active outfit:
top A
bottom B
shoe C

user:
"change the shoes"

session transformation:
target_slot = shoes
locked = top,bottom

retrieve shoes
→ compatibility with A+B
→ brand score
→ shopper score
→ judge
→ return
```

---

# 138. EXAMPLE MERCHANT BRAND CORRECTION

Disc:
```text
Brand style = minimal 0.75
streetwear = 0.25
```

Merchant:
```text
"We are not streetwear."
```

Store:

```text
brand_brain_version 2
streetwear = 0.05
```

Future recommendations use version 2.

Past traces continue to show version 1.

---

# 139. BUSINESS MODEL

The merchant pays for:

```text
AI commerce infrastructure
```

not:

```text
AI tokens
```

Value comes from:

```text
better discovery
better styling
better decision support
better product engagement
potentially better commerce outcomes
```

---

# 140. FINAL PRODUCT DEFINITION

The final Disc product is:

```text
Shopify app
+
automatic merchant onboarding
+
tenant catalog
+
product intelligence
+
Brand Brain
+
AI Boutique storefront embed
+
decision engine
+
style / outfit engine
+
comparison
+
personalization
+
analytics
+
billing
```

The product should be installable by a merchant without engineering assistance.

The shopper should be able to use it without learning how AI works.

The merchant should see measurable commercial value.

The system should never break the merchant storefront.

The intelligence should become better through measured evaluation, not uncontrolled prompt edits.

---

# 141. FINAL CLAUDE CODE MASTER COMMAND

After placing this file in the repository:

```text
Read DISC_B2B_HYPERDEEP_END_TO_END_MASTER_SPEC.md completely.

Treat it as the product and engineering source of truth.

Read the whole repository.

Do NOT code immediately.

First produce DISC_REPO_AUDIT.md.

Do not guess.

Do not rewrite the project wholesale.

Use the current repo as the starting point.

After the audit, stop.

Once approved, implement exactly one phase at a time.

For every phase:
- show plan,
- list files,
- list data changes,
- list AI/model changes,
- list UI changes,
- implement,
- run tests,
- run evaluation,
- report known limitations,
- stop.

The end state must match the specification rather than a generic "AI Shopify app" interpretation.
```

---

# 142. IMPORTANT FOUNDER MENTAL MODEL

As the non-technical founder, do not think:

> "I have to learn all the code."

Think:

```text
I define the product behavior.
Claude/engineers implement it.
Tests prove the implementation.
Evaluation proves the AI behavior.
Merchant feedback proves whether it is valuable.
```

Your most important product questions are:

```text
What should Disc know?
What should Disc remember?
What should Disc recommend?
What should Disc never recommend?
How should the brand feel?
How should the shopper feel?
How do we measure that it worked?
```

Everything else is implementation.

---

# 143. END STATE

The merchant says:

> Install Disc.

Disc connects.

Disc says:

> "I understand your store."

The merchant previews.

Disc appears inside the store.

A shopper says:

> "I need something for a dinner."

Disc understands:

```text
brand
+
catalog
+
shopper
+
context
```

and responds visually with strong options.

Shopper says:

> "Keep the jacket, change the shoes."

Disc understands exactly what changed.

Shopper asks:

> "Why this?"

Disc explains based on actual product/decision data.

Shopper saves/adds to cart.

Merchant sees the outcome.

That is the B2B Disc product.

---

# 144. END
