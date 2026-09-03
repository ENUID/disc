import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  DEFAULT_ENTRY_LABEL,
  ENTRY_LABEL_MAX,
  defaultWidgetConfig,
} from "./lib/widget-config";

/**
 * What a storefront is actually told, over the wire.
 *
 * `widget-config.test.ts` proves the validation. This proves delivery:
 * that a merchant's saved placement and label reach the shop they were
 * saved for, reach it through both boot paths, and reach nobody else.
 *
 * The bug behind this phase was not a validation bug — `placement` was
 * validated correctly the whole time. It was a delivery bug: the value
 * was stored, served, and then read by nothing. So the assertions that
 * matter here are about what crosses the boundary.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  slug: string,
  over: Partial<{ widgetStatus: "inactive" | "previewing" | "live" }> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      // Hyphens, not underscores: `isValidShopDomain` rejects an
      // underscore, and a domain that fails validation would make these
      // tests pass for the wrong reason.
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      accessTokenCipher: "cipher-should-never-be-exposed",
      scopes: "read_products",
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: over.widgetStatus ?? "live",
      subscriptionStatus: "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function configFor(t: ReturnType<typeof convexTest>, slug: string) {
  const res = await t.fetch(
    `/storefront/config?shop=${encodeURIComponent(`${slug}.myshopify.com`)}`,
  );
  expect(res.status).toBe(200);
  return await res.json();
}

describe("the storefront config endpoint", () => {
  test("serves the placement and label the merchant actually chose", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-a");

    await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: {
        ...defaultWidgetConfig(),
        enabled: true,
        placement: "floating_button",
        entryLabel: "Your Style",
        greeting: "Tell us the occasion",
      },
    });

    const body = await configFor(t, "brand-a");
    expect(body.active).toBe(true);
    expect(body.widget_status).toBe("live");
    // The two fields the runtime needs to render an entry point at all.
    expect(body.widget_config.placement).toBe("floating_button");
    expect(body.widget_config.entryLabel).toBe("Your Style");
    // And the greeting stays the greeting: separate field, separate
    // moment, still delivered.
    expect(body.widget_config.greeting).toBe("Tell us the occasion");
  });

  test("a tenant who never opened Experience still gets a complete config", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "brand-fresh");

    // This route used to hand back the stored value verbatim, which for
    // a tenant with nothing stored was `null` — leaving the storefront
    // to invent its own defaults, i.e. a second source of truth for what
    // Disc looks like. Every field must arrive, from the same function
    // the dashboard reads.
    const body = await configFor(t, "brand-fresh");
    expect(body.widget_config).not.toBeNull();
    expect(body.widget_config.placement).toBe("bottom_bar");
    expect(body.widget_config.entryLabel).toBe(DEFAULT_ENTRY_LABEL);
    expect(typeof body.widget_config.greeting).toBe("string");
  });

  test("a config stored before a field existed is completed, not passed through", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-old");

    // Written straight to the row, the way a config saved by an earlier
    // version of this code would look: no `entryLabel`, because the
    // field did not exist yet. Without parsing on read, every merchant
    // installed before today would render a blank entry control.
    await t.run(async (ctx) => {
      await ctx.db.patch(tenantId, {
        widgetConfig: { enabled: true, placement: "floating_button", greeting: "Hello" },
      });
    });

    const body = await configFor(t, "brand-old");
    expect(body.widget_config.placement).toBe("floating_button");
    expect(body.widget_config.entryLabel).toBe(DEFAULT_ENTRY_LABEL);
  });

  test("a corrupted stored config degrades to the bar rather than to nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-broken");

    await t.run(async (ctx) => {
      await ctx.db.patch(tenantId, {
        widgetConfig: { placement: "javascript:alert(1)", entryLabel: { nope: true } },
      });
    });

    const body = await configFor(t, "brand-broken");
    // The safe direction: the presentation every install already had.
    expect(body.widget_config.placement).toBe("bottom_bar");
    expect(typeof body.widget_config.entryLabel).toBe("string");
    expect(body.widget_config.entryLabel).toBe(DEFAULT_ENTRY_LABEL);

    // And a config nobody can read must not read as "switched on". The
    // fallback for every unparseable field points at off, because the
    // alternative is a storefront being taken over on the strength of a
    // config that was never understood.
    expect(body.widget_config.enabled).toBe(false);
  });

  test("a stored label is bounded on the way out, not only on the way in", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-unbounded");

    // Patched straight onto the row, so it never went through
    // `saveExperience`. That is the realistic case: a config written by
    // an earlier version, by a migration, or by any future code path
    // that forgets to parse. The read path has to be the one that makes
    // this safe, because it is the only one every storefront goes
    // through.
    await t.run(async (ctx) => {
      await ctx.db.patch(tenantId, {
        widgetConfig: {
          enabled: true,
          placement: "floating_button",
          entryLabel: "Shop\nthe\tcollection " + "x".repeat(500),
        },
      });
    });

    const body = await configFor(t, "brand-unbounded");
    const label = body.widget_config.entryLabel;
    expect(label.length).toBeLessThanOrEqual(ENTRY_LABEL_MAX);
    expect(label).not.toMatch(/[\n\r\t]/);
  });

  test("both boot paths serve the same config", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-both");
    await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: {
        ...defaultWidgetConfig(),
        enabled: true,
        placement: "floating_button",
        entryLabel: "Personal Stylist",
      },
    });

    // The app embed resolves by domain; a key-carrying install resolves
    // by public key. If only one of them carried the config, where Disc
    // appears would depend on which install path a merchant happened to
    // use — and they would have no way to find out why.
    const byDomain = await configFor(t, "brand-both");
    const byKey = await (await t.fetch("/sites/disc_brand-both/status")).json();

    expect(byKey.widget_config).toEqual(byDomain.widget_config);
    expect(byKey.widget_config.placement).toBe("floating_button");
    expect(byKey.widget_config.entryLabel).toBe("Personal Stylist");
  });

  test("one brand's entry point cannot appear on another's storefront", async () => {
    const t = convexTest(schema, modules);
    const a = await seedTenant(t, "brand-a");
    const b = await seedTenant(t, "brand-b");

    await t.mutation(internal.merchant.saveExperience, {
      tenantId: a,
      config: {
        ...defaultWidgetConfig(),
        enabled: true,
        placement: "floating_button",
        entryLabel: "A's Own Words",
        greeting: "A's greeting",
      },
    });
    await t.mutation(internal.merchant.saveExperience, {
      tenantId: b,
      config: { ...defaultWidgetConfig(), enabled: true, placement: "bottom_bar" },
    });

    const brandA = await configFor(t, "brand-a");
    const brandB = await configFor(t, "brand-b");

    expect(brandA.widget_config.placement).toBe("floating_button");
    expect(brandB.widget_config.placement).toBe("bottom_bar");
    expect(brandA.widget_config.entryLabel).toBe("A's Own Words");
    expect(brandB.widget_config.entryLabel).toBe(DEFAULT_ENTRY_LABEL);
    expect(brandB.widget_config.greeting).not.toBe("A's greeting");

    // And saving again on A must not move B — the failure mode here is a
    // shared default or a cached config, not a broken query.
    await t.mutation(internal.merchant.saveExperience, {
      tenantId: a,
      config: { ...defaultWidgetConfig(), enabled: true, entryLabel: "Changed Again" },
    });
    const brandBAfter = await configFor(t, "brand-b");
    expect(brandBAfter.widget_config.entryLabel).toBe(DEFAULT_ENTRY_LABEL);
    expect(brandBAfter.widget_config.placement).toBe("bottom_bar");
  });

  test("an unknown shop is told to stay dormant, and told nothing else", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "brand-a");

    const res = await t.fetch("/storefront/config?shop=not-a-tenant.myshopify.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Inactive rather than 404: the widget reads this as "stay out of
    // the way", which is the direction that leaves a storefront its own
    // search box (P0.1).
    expect(body.active).toBe(false);
    expect(body.public_key).toBeUndefined();
    expect(body.widget_config).toBeUndefined();
  });

  test("the config a storefront receives carries no credential", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-a");
    await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: { ...defaultWidgetConfig(), enabled: true, placement: "floating_button" },
    });

    // This response is served to anyone who can load the shop's pages,
    // so adding a field to it is a disclosure decision. The entry point
    // added two display strings and must not have widened it further.
    const raw = JSON.stringify(await configFor(t, "brand-a"));
    expect(raw).not.toContain("cipher-should-never-be-exposed");
    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("subscriptionStatus");
    expect(raw).not.toContain("email");
  });
});
