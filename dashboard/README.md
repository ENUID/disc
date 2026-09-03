# Disc merchant dashboard

The merchant-facing console (spec §70–§76). Next.js App Router, deployed
to Vercel, talking to the Convex HTTP router.

Seven sections: Overview, Brand, Catalog, Experience, Analytics, Billing,
Settings. (§70 names the section that controls the shopper experience
"AI Boutique"; it is called Experience here, because AI is how Disc works
rather than what it is — see the repository README.)

## The one architectural rule

**Every page is a server component, and the merchant token never reaches
the browser.**

That token authorises resync, billing and settings for a merchant's whole
store. It arrives once in a query string from the Shopify OAuth callback,
is swapped for an httpOnly cookie by `app/app/route.ts`, and from then on
is read only in `lib/api.ts` on the server. State changes go through
server actions in `app/actions.ts` rather than client fetches, for the
same reason.

`tests/render_test.js` asserts this rather than trusting it: on every
page, in every scenario, it checks the token appears in neither the
rendered HTML nor any client script payload.

## Running it locally

```bash
cd dashboard
npm install
NEXT_PUBLIC_DISC_API_URL=https://your-deployment.convex.site npm run dev
```

Without a Convex deployment you can still see the whole UI, because the
test harness ships a mock backend:

```bash
npm run build
node tests/render_test.js        # renders all 7 sections, 3 scenarios
DISC_TEST_OUT=./shots node tests/render_test.js   # keep the screenshots
```

## The render suite

The same question `frontend/tests/coverage_test.js` asks of the widget,
for the merchant side: not "does it compile" but "does a merchant see the
right thing". A passing `next build` only proves the types line up.

It runs three scenarios against three viewports:

| Scenario | What it represents |
| --- | --- |
| `healthy` | 412 products, live, subscribed, a month of real numbers |
| `fresh` | just installed — nothing built, nothing live, no numbers |
| `lapsed` | catalog sync failed, payment failed, catalog over plan limit |

`fresh` and `lapsed` are the ones that matter. Any dashboard looks fine
full of data; these two are where a merchant either understands what is
wrong or concludes the product is broken. The suite asserts, among other
things, that a rate with no denominator never renders as `0%`, that a
missing Brand Brain reads as pending rather than failed, and that
`past_due` reaches the merchant as "Payment failed" rather than as raw
Stripe vocabulary.

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `NEXT_PUBLIC_DISC_API_URL` | yes | The Convex deployment's HTTP router, e.g. `https://your-deployment.convex.site` |

The backend needs `DASHBOARD_URL` pointing back at this deployment — it is
where the OAuth callback and the Stripe return URLs send the merchant. If
it is unset, the backend falls back to `PUBLIC_URL` and the merchant
lands on the API rather than the dashboard.

## Deploying to Vercel

1. Point a Vercel project at this directory (set **Root Directory** to
   `dashboard`).
2. Set `NEXT_PUBLIC_DISC_API_URL`.
3. On the Convex deployment, set `DASHBOARD_URL` to the Vercel URL.

The `headers()` block in `next.config.ts` is not decoration: `DENY`
framing stops another origin driving this console, and `no-referrer` is
what stops the session token leaking through a `Referer` on the first
outbound link after the OAuth handoff.

## What is deliberately not here

- **No colour picker or CSS box.** §65: merchant styling maps onto known
  design tokens, never free-form CSS — this config is rendered into a
  storefront, so an arbitrary string here would reach every shopper's
  browser.
- **No AI-assisted revenue figure.** It needs order attribution Disc does
  not have. The Analytics page names it as unmeasured rather than
  estimating it (§18).
- **No repeat-usage metric.** Shopper sessions are deliberately not linked
  across visits; Disc stores no shopper identity at all.
- **No token counts, model names or per-query pricing anywhere** (§79).
