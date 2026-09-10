import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentHash,
  embeddingText,
  fromGraphQL,
  fromStorefrontJson,
  numericId,
  stripHtml,
  tagList,
  variantAvailable,
} from "./products";

/**
 * These are ports of the Python suite's parsing checks. They pin the two
 * transforms that corrupt an index silently rather than throwing — the
 * audit's point is that a wrong answer here never raises, it just
 * degrades every search result or offers sold-out stock for sale.
 */

test("stripHtml does not glue words across a tag boundary", () => {
  assert.equal(stripHtml("<p>A <strong>warm</strong> beanie.</p>"), "A warm beanie.");
  // The failure this guards: deleting tags outright produces "onetwo".
  assert.equal(stripHtml("<p>one</p><p>two</p>"), "one two");
  assert.equal(stripHtml(null), "");
});

test("tagList handles both source shapes", () => {
  // Admin API: comma-separated string.
  assert.deepEqual(tagList("winter, wool, accessories"), ["winter", "wool", "accessories"]);
  // Storefront products.json: a real array.
  assert.deepEqual(tagList(["wool", "shoes"]), ["wool", "shoes"]);
  assert.deepEqual(tagList(undefined), []);
  assert.deepEqual(tagList(""), []);
});

test("variantAvailable prefers an explicit flag over inventory inference", () => {
  // Storefront + GraphQL both state it outright.
  assert.equal(variantAvailable({ available: false }), false);
  assert.equal(variantAvailable({ available: true }), true);
  assert.equal(variantAvailable({ availableForSale: false }), false);

  // Admin API: untracked inventory means buyable, not sold out.
  assert.equal(variantAvailable({ inventoryManagement: null }), true);
  assert.equal(variantAvailable({ inventory_management: null }), true);

  // Tracked inventory at zero is genuinely sold out.
  assert.equal(
    variantAvailable({ inventoryManagement: "shopify", inventoryQuantity: 0 }),
    false,
  );
  assert.equal(
    variantAvailable({ inventoryManagement: "shopify", inventoryQuantity: 4 }),
    true,
  );
});

test("variantAvailable: a sold-out flag is never overridden by absent inventory", () => {
  // The exact regression that would mark 2,098 of 2,509 real variants as
  // buyable: the explicit flag must win even when no inventory fields
  // are present to infer from.
  assert.equal(variantAvailable({ available: false, inventoryManagement: null }), false);
});

test("numericId unwraps a GraphQL global id", () => {
  assert.equal(numericId("gid://shopify/Product/123456"), "123456");
  assert.equal(numericId("gid://shopify/ProductVariant/999"), "999");
  assert.equal(numericId("7788"), "7788");
  assert.equal(numericId(undefined), "");
});

test("fromGraphQL produces a canonical product with currency", () => {
  const node = {
    id: "gid://shopify/Product/1",
    title: "Merino Runner",
    descriptionHtml: "<p>Light <b>wool</b> sneakers.</p>",
    handle: "merino-runner",
    productType: "Shoes",
    vendor: "Acme",
    tags: ["wool", "everyday"],
    updatedAt: "2026-01-01T00:00:00Z",
    priceRangeV2: { minVariantPrice: { amount: "98.00", currencyCode: "GBP" } },
    images: { edges: [{ node: { url: "https://cdn/a.jpg" } }] },
    variants: {
      edges: [
        {
          node: {
            id: "gid://shopify/ProductVariant/11",
            title: "8",
            price: "98.00",
            availableForSale: true,
            selectedOptions: [{ name: "Colour", value: "Grey" }],
          },
        },
        {
          node: {
            id: "gid://shopify/ProductVariant/12",
            title: "9",
            price: "98.00",
            availableForSale: false,
            selectedOptions: [{ name: "Colour", value: "Grey" }],
          },
        },
      ],
    },
  };

  const p = fromGraphQL(node, "USD")!;
  assert.equal(p.shopifyProductId, "1");
  assert.equal(p.description, "Light wool sneakers.");
  // Currency was never ingested by the prototype, so every non-USD
  // merchant rendered dollar prices. The product's own currency wins
  // over the shop default.
  assert.equal(p.currency, "GBP");
  assert.equal(p.variants.length, 2);
  assert.deepEqual(
    p.variants.map((v) => v.available),
    [true, false],
  );
  assert.equal(p.anyVariantAvailable, true);
  assert.equal(p.colour, "Grey");
  assert.equal(p.variants[0].id, "11", "variant ids must be numeric for /cart/add.js");
});

test("fromGraphQL falls back to the shop currency", () => {
  const p = fromGraphQL(
    {
      id: "gid://shopify/Product/2",
      title: "x",
      variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/1", price: "1.00" } }] },
    },
    "EUR",
  )!;
  assert.equal(p.currency, "EUR");
});

test("a product with no purchasable variant is excluded", () => {
  assert.equal(fromGraphQL({ id: "gid://shopify/Product/3", variants: { edges: [] } }, "USD"), null);
  assert.equal(fromStorefrontJson({ id: 4, variants: [] }), null);
});

test("anyVariantAvailable is false when every size is sold out", () => {
  const p = fromStorefrontJson({
    id: 5,
    title: "Sold out",
    variants: [
      { id: 1, title: "S", price: "10.00", available: false },
      { id: 2, title: "M", price: "10.00", available: false },
    ],
    images: [],
  })!;
  // This is what makes availability usable as a hard filter, which the
  // prototype stored but never applied.
  assert.equal(p.anyVariantAvailable, false);
});

test("fromStorefrontJson matches the GraphQL shape", () => {
  const p = fromStorefrontJson({
    id: 987654321,
    title: "Merino Runner",
    body_html: "<p>Light wool sneakers.</p>",
    handle: "merino-runner",
    product_type: "Shoes",
    tags: ["wool", "shoes"],
    variants: [{ id: 1, title: "8", price: "98.00", available: true, option1: "Grey" }],
    images: [{ src: "https://cdn/a.jpg" }, { src: "https://cdn/b.jpg" }],
  })!;
  assert.equal(p.shopifyProductId, "987654321");
  assert.deepEqual(p.tags, ["wool", "shoes"]);
  assert.equal(p.colour, "Grey");
  assert.equal(p.images.length, 2);
});

test("contentHash changes with text and with model", () => {
  const a = contentHash("hello world", "m1");
  assert.equal(a, contentHash("hello world", "m1"), "must be deterministic");
  assert.notEqual(a, contentHash("hello worlds", "m1"), "text change must invalidate");
  // A model change has to invalidate too, or a re-embed would reuse
  // vectors from a different embedding space.
  assert.notEqual(a, contentHash("hello world", "m2"), "model change must invalidate");
});

test("embeddingText includes title, description and tags", () => {
  const text = embeddingText({ title: "T", description: "D", tags: ["a", "b"] } as never);
  assert.match(text, /^T\. D Tags: a, b$/);
});
