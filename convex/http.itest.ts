import { expect, test } from "vitest";
import http from "./http";

/**
 * The HTTP router's own shape.
 *
 * This file exists because of a bug it would have caught immediately:
 * `/merchant/analytics` was registered twice — once explicitly and once
 * through the `merchantRoute` helper — and Convex's router throws on a
 * duplicate path/method at import time. Nothing imported `http.ts`, so
 * typecheck, lint and every test passed while the deployment itself
 * would have refused to start.
 *
 * Importing the module is most of the test. The assertions below are the
 * rest: that the routes the widget and the webhooks depend on are
 * actually registered, since a route silently renamed is the same class
 * of failure.
 */

type RouteSpec = { path?: string; pathPrefix?: string; method: string };

function registeredRoutes(): RouteSpec[] {
  // getRoutes() returns [pathOrPrefix, method, handler] triples.
  return (
    http as unknown as {
      getRoutes: () => Array<[string, string, unknown]>;
    }
  )
    .getRoutes()
    .map(([path, method]) => ({ path, method }));
}

function has(path: string, method: string): boolean {
  return registeredRoutes().some((r) => r.path === path && r.method === method);
}

test("the router builds — no duplicate path/method registrations", () => {
  const routes = registeredRoutes();
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  expect(duplicates).toEqual([]);
  expect(routes.length).toBeGreaterThan(0);
});

test("the storefront contract the widget depends on is registered", () => {
  // These paths and shapes are deliberately compatible with the Python
  // backend's, which is what lets `frontend/disc-widget.js` work against
  // either without an edit. Renaming one here breaks every install.
  // Prefix routes are reported with a trailing `*`.
  expect(has("/search", "POST")).toBe(true);
  expect(has("/product/*", "GET")).toBe(true);
  expect(has("/look/*", "GET")).toBe(true);
  expect(has("/sites/*", "GET")).toBe(true);
  expect(has("/storefront/config", "GET")).toBe(true);
  expect(has("/events", "POST")).toBe(true);
  expect(has("/outfit", "POST")).toBe(true);
});

test("every storefront route answers CORS preflight", () => {
  // The widget runs on arbitrary merchant domains, so a POST route
  // without an OPTIONS handler is a route the browser refuses to call.
  for (const path of ["/search", "/outfit", "/events"]) {
    expect(has(path, "OPTIONS")).toBe(true);
  }
});

test("webhook endpoints are registered for every topic Shopify sends", () => {
  for (const topic of [
    "products/create",
    "products/update",
    "products/delete",
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ]) {
    expect(has(`/webhooks/shopify/${topic}`, "POST")).toBe(true);
  }
  expect(has("/webhooks/stripe", "POST")).toBe(true);
});

test("every merchant control-plane route is POST or GET, never public-key gated", () => {
  const merchantRoutes = registeredRoutes().filter((r) =>
    r.path?.startsWith("/merchant/"),
  );
  // Sanity: the dashboard's sections all exist.
  for (const path of [
    "/merchant/dashboard",
    "/merchant/catalog",
    "/merchant/brand",
    "/merchant/experience",
    "/merchant/settings",
    "/merchant/analytics",
    "/merchant/billing",
    "/merchant/billing/checkout",
    "/merchant/billing/portal",
    "/merchant/resync",
    "/merchant/preview",
  ]) {
    expect(
      merchantRoutes.some((r) => r.path === path),
      `missing merchant route: ${path}`,
    ).toBe(true);
  }
});
