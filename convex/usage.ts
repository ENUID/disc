import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ActionCtx } from "./_generated/server";
import {
  estimateCostUsd,
  isPriced,
  isShopperDriven,
  type Operation,
} from "./lib/model-pricing";

/**
 * AI usage accounting.
 *
 * One question this exists to answer: what does an AI shopping session
 * cost? Everything about Disc's pricing depends on it, and until now
 * nothing recorded the inputs — `providers.ts` read the token counts off
 * every response and discarded them.
 *
 * Two rules shape the design:
 *
 *   1. Merchants never see any of this (§79 — do not expose token
 *      pricing to merchants). The merchant-facing number is "AI shopping
 *      sessions used", which is derived here but carries no tokens and
 *      no dollars. Cost per session is operator-only.
 *
 *   2. Recording usage must never fail the request that generated it.
 *      A dropped accounting row costs us a data point; an exception
 *      thrown from the accounting path costs a shopper their answer.
 */

/** UTC day bucket. UTC rather than local so buckets never overlap or gap. */
export function dayKey(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export const record = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    operation: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    calls: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const day = dayKey();
    const cost = estimateCostUsd(args.model, args.inputTokens, args.outputTokens);

    // Loud, once per unpriced model. Its spend is still recorded — at
    // the deliberately alarming unknown rate — so it cannot vanish from
    // a report just because nobody updated the price table.
    if (!isPriced(args.model)) {
      console.warn(
        `modelUsage: no price configured for "${args.model}" — costed at the unknown-model rate`,
      );
    }

    const existing = await ctx.db
      .query("modelUsage")
      .withIndex("by_key", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("day", day)
          .eq("operation", args.operation)
          .eq("model", args.model),
      )
      .unique();

    const calls = args.calls ?? 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        calls: existing.calls + calls,
        inputTokens: existing.inputTokens + args.inputTokens,
        outputTokens: existing.outputTokens + args.outputTokens,
        estimatedCostUsd: existing.estimatedCostUsd + cost,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("modelUsage", {
        tenantId: args.tenantId,
        day,
        operation: args.operation,
        model: args.model,
        calls,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        estimatedCostUsd: cost,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * The sink handed to a model provider.
 *
 * Deliberately swallows its own failures. This runs inside the request
 * that made the model call, and the accounting must never be the reason
 * a shopper gets an error — losing a usage row is a worse report, losing
 * the response is a worse product.
 */
export function usageSink(ctx: ActionCtx, tenantId: Id<"tenants">, operation: Operation) {
  return async (usage: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> => {
    try {
      await ctx.runMutation(internal.usage.record, {
        tenantId,
        operation,
        model: usage.model,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    } catch (error) {
      console.warn(`modelUsage: failed to record ${operation}`, error);
    }
  };
}

/**
 * Everything spent by one tenant over a window.
 *
 * Operator-facing. Splits shopper-driven from catalog-driven spend,
 * because that split is what decides whether a catalog-size price tier
 * is adequate: catalog spend is one-time per product and a size tier
 * covers it; shopper spend scales with traffic and a size tier does not
 * cover it at all.
 */
export const tenantUsage = internalQuery({
  args: { tenantId: v.id("tenants"), sinceDay: v.string() },
  handler: async (ctx, { tenantId, sinceDay }) => {
    const rows = await ctx.db
      .query("modelUsage")
      .withIndex("by_tenant_and_day", (q) =>
        q.eq("tenantId", tenantId).gte("day", sinceDay),
      )
      .take(5000);

    return summarise(rows);
  },
});

type UsageRow = {
  operation: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export function summarise(rows: UsageRow[]) {
  let totalCost = 0;
  let shopperCost = 0;
  let catalogCost = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const byOperation: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
  > = {};
  const byModel: Record<string, { calls: number; costUsd: number }> = {};

  for (const row of rows) {
    totalCost += row.estimatedCostUsd;
    calls += row.calls;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;

    if (isShopperDriven(row.operation)) shopperCost += row.estimatedCostUsd;
    else catalogCost += row.estimatedCostUsd;

    const op = (byOperation[row.operation] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    op.calls += row.calls;
    op.inputTokens += row.inputTokens;
    op.outputTokens += row.outputTokens;
    op.costUsd += row.estimatedCostUsd;

    const model = (byModel[row.model] ??= { calls: 0, costUsd: 0 });
    model.calls += row.calls;
    model.costUsd += row.estimatedCostUsd;
  }

  return {
    totalCostUsd: totalCost,
    shopperCostUsd: shopperCost,
    catalogCostUsd: catalogCost,
    calls,
    inputTokens,
    outputTokens,
    byOperation,
    byModel,
  };
}

/**
 * Sessions used in a window — the ONE number a merchant may see.
 *
 * No tokens, no models, no dollars (§79). An "AI shopping session" is a
 * distinct shopper session that reached Disc, which is the unit a
 * merchant is actually buying and the unit the plan limits should be
 * written in.
 */
export const sessionsUsed = internalQuery({
  args: { tenantId: v.id("tenants"), since: v.number() },
  returns: v.number(),
  handler: async (ctx, { tenantId, since }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_tenant_and_at", (q) => q.eq("tenantId", tenantId).gte("at", since))
      .take(20000);

    const sessions = new Set<string>();
    for (const event of events) {
      if (event.sessionKey) sessions.add(event.sessionKey);
    }
    return sessions.size;
  },
});

/**
 * Unit economics, per tenant. OPERATOR ONLY.
 *
 * This is the report that decides pricing: revenue per merchant against
 * what that merchant actually costs, and the cost of a single AI
 * shopping session. Never reachable with a merchant token — see the
 * admin-key gate on the HTTP route.
 */
export const economics = internalQuery({
  args: { sinceDay: v.string(), since: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { sinceDay, since, limit }) => {
    const rows = await ctx.db
      .query("modelUsage")
      .withIndex("by_day", (q) => q.gte("day", sinceDay))
      .take(20000);

    const byTenant = new Map<string, UsageRow[]>();
    for (const row of rows) {
      const key = row.tenantId as string;
      const list = byTenant.get(key) ?? [];
      list.push(row);
      byTenant.set(key, list);
    }

    const tenants = [];
    for (const [tenantId, tenantRows] of byTenant) {
      const tenant = await ctx.db.get(tenantId as Id<"tenants">);
      if (!tenant) continue;

      const usage = summarise(tenantRows);
      const sessions: number = await ctx.runQuery(internal.usage.sessionsUsed, {
        tenantId: tenant._id,
        since,
      });

      tenants.push({
        tenantId,
        shopDomain: tenant.shopDomain,
        plan: tenant.plan ?? null,
        subscriptionStatus: tenant.subscriptionStatus,
        productCount: tenant.productCount,
        sessions,
        ...usage,
        // The number the whole exercise is for. Null rather than zero
        // when there are no sessions — a cost with no sessions to divide
        // by is undefined, not free, and rendering it as $0.00 would be
        // the most flattering possible lie.
        costPerSessionUsd: sessions > 0 ? usage.shopperCostUsd / sessions : null,
      });
    }

    tenants.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    const totals = {
      tenants: tenants.length,
      sessions: tenants.reduce((sum, t) => sum + t.sessions, 0),
      totalCostUsd: tenants.reduce((sum, t) => sum + t.totalCostUsd, 0),
      shopperCostUsd: tenants.reduce((sum, t) => sum + t.shopperCostUsd, 0),
      catalogCostUsd: tenants.reduce((sum, t) => sum + t.catalogCostUsd, 0),
    };

    return {
      sinceDay,
      totals: {
        ...totals,
        costPerSessionUsd:
          totals.sessions > 0 ? totals.shopperCostUsd / totals.sessions : null,
      },
      tenants: tenants.slice(0, limit ?? 100),
      truncated: rows.length >= 20000,
    };
  },
});

/**
 * Retention.
 *
 * Longer than events, because this is the record that justifies a price
 * and a year-over-year comparison is worth having. Small enough that it
 * costs nothing to keep: one row per tenant per day per operation per
 * model.
 */
export const purgeOldUsage = internalMutation({
  args: { beforeDay: v.string(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, { beforeDay, limit }) => {
    const stale = await ctx.db
      .query("modelUsage")
      .withIndex("by_day", (q) => q.lt("day", beforeDay))
      .take(limit ?? 1000);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
