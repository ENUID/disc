/**
 * Shop domain validation and normalisation.
 *
 * Deliberately dependency-free: this is a security boundary, and it
 * should be testable and reviewable without dragging in configuration or
 * an API client.
 *
 * A shop domain gets interpolated into an Admin API URL and used as a
 * tenant lookup key, so a suffix check is not enough. The prototype used
 * `shop.endswith(".myshopify.com")`, which admits values containing a
 * path, a port, or an `@` userinfo section — each of which ends with the
 * right suffix while pointing a credentialed request somewhere else.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN.test(shop);
}

/**
 * Normalise merchant-entered input to a bare domain.
 *
 * Merchants paste whatever is in their address bar, so this accepts a
 * full URL, a trailing slash, a path or a query string. Lowercasing
 * matters: the domain is a lookup key, and `Shop.com` and `shop.com`
 * must not become two tenants.
 */
export function normaliseDomain(raw: string): string {
  let domain = (raw ?? "").trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (domain.startsWith(prefix)) domain = domain.slice(prefix.length);
  }
  domain = domain.split("/")[0].split("?")[0];
  if (domain.startsWith("www.")) domain = domain.slice(4);
  return domain;
}
