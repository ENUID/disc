/**
 * Crypto helpers — Web Crypto only, so these run in Convex's default
 * runtime as well as Node actions.
 *
 * Three separate concerns live here, and they are genuinely different
 * schemes. The prototype implemented all three correctly in Python and
 * had tests for each; the tests port as specifications even though the
 * code does not.
 *
 *   Shopify OAuth callback   hex HMAC over sorted `k=v&…` query params
 *   Shopify webhook          base64 HMAC over the RAW request body
 *   Stripe webhook           hex HMAC over `{timestamp}.{raw body}`, with
 *                            a replay window
 *
 * The webhook ones must run against raw bytes. Parsing and
 * re-serialising changes whitespace and key order, which breaks the
 * signature — and verifying after parsing would mean a forged request
 * had already been interpreted.
 */

const encoder = new TextEncoder();

/**
 * Copy bytes into a freshly allocated ArrayBuffer.
 *
 * TypeScript 5.7 made typed arrays generic over their backing buffer, so
 * a `Uint8Array<ArrayBufferLike>` (which could be SharedArrayBuffer-backed)
 * no longer satisfies WebCrypto's `BufferSource`. Copying is a few bytes
 * of allocation and keeps this honest — the alternative is a cast that
 * asserts something the type system correctly cannot prove.
 */
function bufferOf(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

async function hmacRaw(secret: string, message: Uint8Array | ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferOf(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", key, bufferOf(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Constant-time comparison. A `===` here leaks how much of the signature
 * matched through timing, which is enough to forge one byte at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Shopify OAuth callback: hex HMAC over sorted params, `hmac` removed. */
export async function verifyShopifyOAuthHmac(
  params: Record<string, string>,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  const received = params["hmac"];
  if (!received) return false;

  const message = Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const computed = toHex(await hmacRaw(secret, encoder.encode(message)));
  return timingSafeEqual(computed, received);
}

/** Shopify webhook: base64 HMAC over the raw body bytes. */
export async function verifyShopifyWebhookHmac(
  rawBody: ArrayBuffer,
  headerHmac: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !headerHmac) return false;
  const computed = toBase64(await hmacRaw(secret, new Uint8Array(rawBody)));
  return timingSafeEqual(computed, headerHmac);
}

/**
 * Stripe webhook: `t=<ts>,v1=<hex>[,v1=<hex>]`, signed over
 * `{t}.{raw body}`. Several v1 values can appear during a secret
 * rotation, so any match counts. The timestamp check is not optional —
 * without it a captured request stays replayable forever.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const computed = toHex(await hmacRaw(secret, encoder.encode(`${timestamp}.${rawBody}`)));
  return signatures.some((candidate) => timingSafeEqual(computed, candidate));
}

/**
 * Opaque tokens: 32 bytes of CSPRNG, base64url. Used for merchant
 * session tokens, OAuth state and public keys.
 *
 * The `disc_` prefix on public keys is deliberate — it makes the value
 * recognisable in a log or a support email, and it signals that the
 * thing is an identifier rather than a secret.
 */
export function randomToken(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return prefix ? `${prefix}${token}` : token;
}

/**
 * Encrypt a Shopify access token for storage (AES-GCM, key from
 * DISC_ENCRYPTION_KEY as base64).
 *
 * The prototype stored these in plaintext, which spec §90 forbids. The
 * exposure was latent while every tenant used the credential-free public
 * catalog path, and becomes live the moment OAuth is used — which is
 * what this phase turns on, so it is fixed here rather than later.
 */
async function encryptionKey(secretB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("DISC_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plaintext: string, secretB64: string): Promise<string> {
  const key = await encryptionKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  // iv is prepended rather than stored separately: it is not secret, it
  // must be unique per encryption, and keeping them together makes it
  // impossible to pair the wrong one with a ciphertext.
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  let binary = "";
  for (const b of packed) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function decryptSecret(packedB64: string, secretB64: string): Promise<string> {
  const key = await encryptionKey(secretB64);
  const packed = Uint8Array.from(atob(packedB64), (c) => c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
