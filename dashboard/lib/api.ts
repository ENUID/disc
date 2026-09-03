import { redirect } from "next/navigation";
import { readToken } from "./session";

/**
 * The Convex HTTP router, called server-side with the merchant's bearer
 * token.
 *
 * Every merchant route on the backend requires that token; the public
 * key cannot reach any of them. That boundary is the point of the whole
 * migration, so nothing here should ever gain a "just use the site key"
 * shortcut.
 */

export function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_DISC_API_URL ?? process.env.DISC_API_URL ?? "";
  if (!base) {
    throw new Error(
      "DISC_API_URL is not set. Point it at the Convex deployment's HTTP router " +
        "(e.g. https://your-deployment.convex.site).",
    );
  }
  return base.replace(/\/$/, "");
}

export class Unauthorized extends Error {
  constructor() {
    super("Merchant session is not valid");
    this.name = "Unauthorized";
  }
}

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  /** Seconds to cache. 0 disables. Merchant data is per-request by default. */
  revalidate?: number;
};

async function call<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const token = await readToken();
  if (!token) throw new Unauthorized();

  const response = await fetch(`${apiBase()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    // Merchant state changes while they watch it — a catalog syncing, a
    // Brand Brain building. Caching those would show stale progress,
    // which §18 explicitly forbids.
    cache: options.revalidate ? "force-cache" : "no-store",
    next: options.revalidate ? { revalidate: options.revalidate } : undefined,
  });

  if (response.status === 401) throw new Unauthorized();
  if (response.status === 429) {
    const retry = response.headers.get("Retry-After") ?? "60";
    throw new Error(`Rate limited. Try again in ${retry}s.`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Disc API ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as T;
}

/**
 * Fetch for a page render. An invalid or expired session sends the
 * merchant to the sign-in page rather than rendering an error — an
 * expired token is a routine event after fourteen days, not a fault.
 */
export async function apiGet<T>(path: string): Promise<T> {
  try {
    return await call<T>(path);
  } catch (error) {
    if (error instanceof Unauthorized) redirect("/?expired=1");
    throw error;
  }
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await call<T>(path, { method: "POST", body });
  } catch (error) {
    if (error instanceof Unauthorized) redirect("/?expired=1");
    throw error;
  }
}

/** True when a session cookie exists at all. Does not prove it is valid. */
export async function hasSession(): Promise<boolean> {
  return (await readToken()) !== null;
}
