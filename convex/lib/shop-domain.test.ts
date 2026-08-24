import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidShopDomain, normaliseDomain } from "./shop-domain.ts";

/**
 * Shop-domain validation.
 *
 * The domain is interpolated into an Admin API URL, so a suffix check is
 * not enough. The prototype used `shop.endswith(".myshopify.com")`,
 * which admits values containing slashes, `@` or a userinfo section —
 * enough to point a credentialed request somewhere other than the shop.
 */

test("accepts real shop domains", () => {
  assert.equal(isValidShopDomain("acme.myshopify.com"), true);
  assert.equal(isValidShopDomain("acme-store-2.myshopify.com"), true);
  assert.equal(isValidShopDomain("a1.myshopify.com"), true);
});

test("rejects domains that a suffix check would have allowed", () => {
  // Each of these ends with ".myshopify.com" but is not a shop.
  assert.equal(isValidShopDomain("evil.com/x.myshopify.com"), false);
  assert.equal(isValidShopDomain("evil.com@acme.myshopify.com"), false);
  assert.equal(isValidShopDomain("acme.myshopify.com:8080"), false);
  assert.equal(isValidShopDomain("sub.acme.myshopify.com"), false);
  assert.equal(isValidShopDomain("../acme.myshopify.com"), false);
});

test("rejects the obvious cases", () => {
  assert.equal(isValidShopDomain(""), false);
  assert.equal(isValidShopDomain("acme.com"), false);
  assert.equal(isValidShopDomain("myshopify.com"), false);
  assert.equal(isValidShopDomain("ACME.myshopify.com"), false, "case is not normalised here");
  assert.equal(isValidShopDomain("-acme.myshopify.com"), false, "cannot start with a hyphen");
});

test("normaliseDomain strips scheme, www, path and query", () => {
  assert.equal(normaliseDomain("https://WWW.Shop.com/collections/all?x=1"), "shop.com");
  assert.equal(normaliseDomain("http://acme.myshopify.com/"), "acme.myshopify.com");
  assert.equal(normaliseDomain("  Acme.Com  "), "acme.com");
});
