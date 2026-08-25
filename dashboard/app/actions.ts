"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiPost } from "@/lib/api";
import { clearToken } from "@/lib/session";
import type { WidgetConfig } from "@/lib/types";

/**
 * Every state change the dashboard can make.
 *
 * Server actions rather than client fetches, for the same reason every
 * page is a server component: the merchant token stays on the server. A
 * client-side `fetch` would need the token in the browser, and this one
 * authorises resync and billing for the merchant's whole store.
 *
 * Each returns a small result object rather than throwing, because these
 * are driven by forms and a thrown error in a server action reaches the
 * merchant as an error page rather than an explanation.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function failed(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : "Something went wrong";
  return { ok: false, error: message };
}

export async function resyncCatalog(): Promise<ActionResult> {
  try {
    await apiPost("/merchant/resync");
    revalidatePath("/app/catalog");
    revalidatePath("/app/overview");
    return { ok: true, message: "Resync queued. This takes a few minutes." };
  } catch (error) {
    return failed(error);
  }
}

export async function startPreview(): Promise<ActionResult> {
  try {
    await apiPost("/merchant/preview");
    revalidatePath("/app/experience");
    revalidatePath("/app/overview");
    return { ok: true, message: "Preview mode on." };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Save the experience controls (spec §74).
 *
 * Reads the form rather than taking a typed object, because it is wired
 * straight to a `<form action>`. The backend re-validates everything
 * against closed vocabularies — this value ends up rendered into a
 * storefront, so nothing here is trusted on the way in.
 */
export async function saveExperience(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const config: WidgetConfig = {
    enabled: form.get("enabled") === "on",
    placement: form.get("placement") as WidgetConfig["placement"],
    greeting: String(form.get("greeting") ?? "").slice(0, 120),
    workflows: form.getAll("workflows").map(String),
    design: {
      density: form.get("density") as WidgetConfig["design"]["density"],
      motion: form.get("motion") as WidgetConfig["design"]["motion"],
      cardStyle: form.get("cardStyle") as WidgetConfig["design"]["cardStyle"],
      cornerRadius: form.get("cornerRadius") as WidgetConfig["design"]["cornerRadius"],
    },
  };

  try {
    await apiPost("/merchant/experience", config);
    revalidatePath("/app/experience");
    revalidatePath("/app/overview");
    return {
      ok: true,
      message: config.enabled
        ? "Saved. Disc is live on your storefront."
        : "Saved. Disc is switched off for shoppers.",
    };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Correct the Brand Brain (spec §138).
 *
 * Creates a new version rather than editing the current one, so past
 * recommendations still resolve against the brain that produced them.
 * Only the four correctable facets are sent; provenance and confidence
 * describe how the brain was derived and are not the merchant's to set.
 */
export async function correctBrand(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const summary = String(form.get("summary") ?? "").trim();
  const tone = splitList(form.get("tone"));
  const vocabulary = splitList(form.get("vocabulary"));
  const dominant = splitList(form.get("dominant"));

  if (!summary && !tone.length && !vocabulary.length && !dominant.length) {
    return { ok: false, error: "Nothing to change." };
  }

  try {
    const result = await apiPost<{ version: number }>("/merchant/brand/correct", {
      summary: summary || undefined,
      voice: tone.length || vocabulary.length ? { tone, vocabulary } : undefined,
      palette: dominant.length ? { dominant } : undefined,
    });
    revalidatePath("/app/brand");
    return {
      ok: true,
      message: `Saved as version ${result.version}. Past recommendations still show what produced them.`,
    };
  } catch (error) {
    return failed(error);
  }
}

function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * Billing. Both of these hand off to a Stripe-hosted page, so the
 * dashboard never sees a card number.
 */
export async function openCheckout(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let destination: string;
  try {
    const result = await apiPost<{ url?: string; error?: string }>(
      "/merchant/billing/checkout",
      { plan: form.get("plan") ? String(form.get("plan")) : undefined },
    );
    if (!result.url) return { ok: false, error: result.error ?? "Could not start checkout" };
    destination = result.url;
  } catch (error) {
    return failed(error);
  }
  // Outside the try: `redirect` signals by throwing, and catching it
  // here would turn a successful hand-off into a reported failure.
  redirect(destination);
}

export async function openPortal(): Promise<ActionResult> {
  let destination: string;
  try {
    const result = await apiPost<{ url?: string; error?: string }>(
      "/merchant/billing/portal",
    );
    if (!result.url) return { ok: false, error: result.error ?? "Could not open billing" };
    destination = result.url;
  } catch (error) {
    return failed(error);
  }
  redirect(destination);
}

export async function signOut(): Promise<void> {
  await clearToken();
  redirect("/");
}
