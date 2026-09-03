/**
 * Shopify Admin API client — GraphQL only.
 *
 * The REST Admin API became legacy on 2024-10-01, and since 2025-04-01
 * all new public apps must be built exclusively with the GraphQL Admin
 * API. The Python prototype used REST throughout
 * (`/admin/api/2024-01/products.json`, Link-header cursors), which is
 * why that path is a rewrite rather than a port.
 *
 * Two practical differences from REST that shape everything here:
 *   - pagination is cursor-based via `pageInfo.endCursor`, not Link headers
 *   - the response carries `extensions.cost`, so throttling is
 *     observable rather than guesswork
 */

import { SHOPIFY_API_VERSION } from "../lib/env";

// Validation lives in its own dependency-free module so it can be
// tested and reviewed in isolation; re-exported for existing callers.
export { isValidShopDomain } from "../lib/shop-domain";

export type GraphQLResult<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
};

export class ShopifyAdminError extends Error {
  // Declared and assigned explicitly rather than as a constructor
  // parameter property: those emit runtime code, which Node's
  // type-stripping (used to run the tests) cannot handle.
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ShopifyAdminError";
    this.status = status;
  }
}

export async function adminGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResult<T>> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) {
    // Deliberately does not include the body: Shopify echoes request
    // context in errors and this string ends up in logs.
    throw new ShopifyAdminError(
      `Shopify Admin API returned ${response.status}`,
      response.status,
    );
  }

  const payload = (await response.json()) as GraphQLResult<T>;
  if (payload.errors?.length) {
    throw new ShopifyAdminError(payload.errors.map((e) => e.message).join("; "));
  }
  return payload;
}

/**
 * Everything ingestion needs, in one page.
 *
 * `variants(first: 100)` and `images(first: 10)` are deliberate caps: a
 * product with more than 100 variants is vanishingly rare, and pulling
 * every image of every product multiplies the query cost for imagery the
 * detail view will never show.
 */
export const PRODUCTS_PAGE_QUERY = `
  query DiscProductsPage($cursor: String) {
    shop { currencyCode }
    products(first: 50, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          productType
          vendor
          tags
          updatedAt
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          images(first: 10) { edges { node { url } } }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                availableForSale
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

export const SINGLE_PRODUCT_QUERY = `
  query DiscProduct($id: ID!) {
    shop { currencyCode }
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      productType
      vendor
      tags
      updatedAt
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      images(first: 10) { edges { node { url } } }
      variants(first: 100) {
        edges {
          node { id title price availableForSale selectedOptions { name value } }
        }
      }
    }
  }
`;

export const SHOP_QUERY = `
  query DiscShop {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

/**
 * Register the webhooks incremental sync depends on.
 *
 * GraphQL `webhookSubscriptionCreate`, not the REST endpoint the
 * prototype used. Failures are collected rather than thrown: a webhook
 * that fails to register degrades the tenant to periodic resync, which
 * is a slower catalog, not a broken install.
 */
export const WEBHOOK_CREATE_MUTATION = `
  mutation DiscWebhookCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      userErrors { field message }
      webhookSubscription { id }
    }
  }
`;

export const WEBHOOK_TOPICS = [
  { topic: "PRODUCTS_CREATE", path: "/webhooks/shopify/products/create" },
  { topic: "PRODUCTS_UPDATE", path: "/webhooks/shopify/products/update" },
  { topic: "PRODUCTS_DELETE", path: "/webhooks/shopify/products/delete" },
  { topic: "APP_UNINSTALLED", path: "/webhooks/shopify/app/uninstalled" },
] as const;

export async function registerWebhooks(
  shopDomain: string,
  accessToken: string,
  publicUrl: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const { topic, path } of WEBHOOK_TOPICS) {
    try {
      const result = await adminGraphQL<{
        webhookSubscriptionCreate: { userErrors: Array<{ message: string }> };
      }>(shopDomain, accessToken, WEBHOOK_CREATE_MUTATION, {
        topic,
        callbackUrl: `${publicUrl}${path}`,
      });
      const errors = result.data?.webhookSubscriptionCreate?.userErrors ?? [];
      // "already exists" on reinstall is expected, not a failure.
      const real = errors.filter((e) => !/already exists/i.test(e.message));
      if (real.length) failures.push(`${topic}: ${real.map((e) => e.message).join(", ")}`);
    } catch (err) {
      failures.push(`${topic}: ${(err as Error).message}`);
    }
  }
  return failures;
}

export function exchangeCodeUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/oauth/access_token`;
}

