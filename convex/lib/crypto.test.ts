import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyShopifyOAuthHmac,
  verifyShopifyWebhookHmac,
  verifyStripeSignature,
} from "./crypto.ts";

/**
 * Three genuinely different signature schemes, ported from the Python
 * suite. Signatures are computed here with Node's crypto — independently
 * of the implementation under test — so a bug in the implementation
 * cannot make its own signature verify.
 */

const SECRET = "test_secret_for_local_verification";

test("Shopify OAuth callback HMAC: hex over sorted params", async () => {
  const params: Record<string, string> = {
    shop: "test-shop.myshopify.com",
    code: "abc123",
    state: "xyz",
    timestamp: "1234567890",
  };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", SECRET).update(message).digest("hex");

  assert.equal(await verifyShopifyOAuthHmac({ ...params, hmac }, SECRET), true);
  assert.equal(
    await verifyShopifyOAuthHmac({ ...params, code: "tampered", hmac }, SECRET),
    false,
    "params modified after signing must be rejected",
  );
  assert.equal(await verifyShopifyOAuthHmac(params, SECRET), false, "no hmac param");
  assert.equal(await verifyShopifyOAuthHmac({ ...params, hmac }, ""), false, "no secret");
});

test("Shopify webhook HMAC: base64 over the RAW body", async () => {
  const body = JSON.stringify({ id: 123, title: "Test Product" });
  const raw = new TextEncoder().encode(body);
  const sig = createHmac("sha256", SECRET).update(Buffer.from(raw)).digest("base64");

  assert.equal(await verifyShopifyWebhookHmac(raw.buffer as ArrayBuffer, sig, SECRET), true);

  const tampered = new TextEncoder().encode(body + " ");
  assert.equal(
    await verifyShopifyWebhookHmac(tampered.buffer as ArrayBuffer, sig, SECRET),
    false,
    "a body modified after signing must be rejected",
  );
  assert.equal(
    await verifyShopifyWebhookHmac(raw.buffer as ArrayBuffer, "wrong", SECRET),
    false,
  );
  assert.equal(await verifyShopifyWebhookHmac(raw.buffer as ArrayBuffer, null, SECRET), false);
});

test("Stripe signature: hex over {timestamp}.{body}, with a replay guard", async () => {
  const body = '{"type":"checkout.session.completed"}';
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

  assert.equal(await verifyStripeSignature(body, `t=${ts},v1=${sig}`, SECRET), true);
  assert.equal(
    await verifyStripeSignature(body + " ", `t=${ts},v1=${sig}`, SECRET),
    false,
    "tampered body",
  );
  assert.equal(
    await verifyStripeSignature(body, `t=${ts},v1=${"0".repeat(64)}`, SECRET),
    false,
    "bad signature",
  );

  // A correctly-signed but stale request must still be rejected —
  // without this a captured request is replayable forever.
  const old = (Math.floor(Date.now() / 1000) - 9999).toString();
  const oldSig = createHmac("sha256", SECRET).update(`${old}.${body}`).digest("hex");
  assert.equal(
    await verifyStripeSignature(body, `t=${old},v1=${oldSig}`, SECRET),
    false,
    "replay guard",
  );
});

test("Stripe signature: any v1 matches during a secret rotation", async () => {
  const body = "{}";
  const ts = Math.floor(Date.now() / 1000).toString();
  const good = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  const header = `t=${ts},v1=${"0".repeat(64)},v1=${good}`;
  assert.equal(await verifyStripeSignature(body, header, SECRET), true);
});

test("timingSafeEqual compares correctly", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("access tokens round-trip through AES-GCM", async () => {
  const key = randomBytes(32).toString("base64");
  const token = "shpat_" + randomBytes(16).toString("hex");

  const cipher = await encryptSecret(token, key);
  assert.notEqual(cipher, token, "ciphertext must not contain the plaintext");
  assert.equal(cipher.includes(token), false);
  assert.equal(await decryptSecret(cipher, key), token);
});

test("encryption is non-deterministic and key-bound", async () => {
  const key = randomBytes(32).toString("base64");
  const other = randomBytes(32).toString("base64");

  // A fresh IV per encryption, so the same token never produces the same
  // ciphertext twice — otherwise equal ciphertexts leak equal tokens.
  const a = await encryptSecret("same-token", key);
  const b = await encryptSecret("same-token", key);
  assert.notEqual(a, b);

  await assert.rejects(() => decryptSecret(a, other), "the wrong key must not decrypt");
});

test("encryption rejects a key of the wrong length", async () => {
  await assert.rejects(
    () => encryptSecret("x", Buffer.from("too-short").toString("base64")),
    /32 bytes/,
  );
});

test("randomToken is unique, prefixed and URL-safe", () => {
  const a = randomToken("disc_");
  const b = randomToken("disc_");
  assert.notEqual(a, b);
  assert.match(a, /^disc_[A-Za-z0-9_-]+$/);

  // base64url, so a token is safe in a URL and in a header without
  // escaping. Over many samples, standard-base64 characters must never
  // appear — a single sample would pass by luck.
  for (let i = 0; i < 200; i++) {
    const t = randomToken();
    assert.doesNotMatch(t, /[+/=]/, `token must be URL-safe: ${t}`);
  }
  // 32 bytes of entropy -> 43 base64url characters, unpadded.
  assert.equal(randomToken().length, 43);
});

test("sha256Hex is stable", async () => {
  assert.equal(await sha256Hex("abc"), await sha256Hex("abc"));
  assert.notEqual(await sha256Hex("abc"), await sha256Hex("abd"));
  assert.equal((await sha256Hex("abc")).length, 64);
});
