"use client";

import { useActionState } from "react";
import { openCheckout, type ActionResult } from "@/app/actions";
import { Result } from "@/components/actions";
import type { Plan } from "@/lib/types";

/**
 * Plan selection.
 *
 * Each plan is its own form so the submitted plan is unambiguous — a
 * single form with a hidden field that several buttons mutate is how a
 * merchant ends up subscribed to the wrong tier.
 *
 * A merchant who already has a subscription is sent to Stripe's portal
 * rather than through checkout again: starting a second checkout would
 * create a second subscription rather than change the existing one.
 */
export function PlanPicker({
  plans,
  currentPlan,
  suggested,
  trialDays,
  hasSubscription,
}: {
  plans: Plan[];
  currentPlan: string | null;
  suggested: string;
  trialDays: number;
  hasSubscription: boolean;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    openCheckout,
    null,
  );

  return (
    <>
      <div className="plans">
        {plans.map((plan) => {
          const isCurrent = plan.key === currentPlan;
          return (
            <div className={`plan${isCurrent ? " current" : ""}`} key={plan.key}>
              <div>
                <strong>{plan.name}</strong>
                {plan.key === suggested && !isCurrent && (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    Your size
                  </span>
                )}
              </div>
              <div className="price">
                ${plan.price}
                <span> /month</span>
              </div>
              <div className="cap">
                {plan.catalogLimit === null
                  ? "Any catalog size"
                  : `Up to ${plan.catalogLimit.toLocaleString()} products`}
              </div>

              {isCurrent ? (
                <button className="btn secondary" disabled>
                  Current plan
                </button>
              ) : hasSubscription ? (
                // Changing an existing subscription belongs in the portal.
                <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
                  Switch to this in Manage subscription above.
                </span>
              ) : (
                <form action={action}>
                  <input type="hidden" name="plan" value={plan.key} />
                  <button
                    className="btn"
                    type="submit"
                    disabled={pending}
                    style={{ width: "100%" }}
                  >
                    {pending ? "Opening…" : `Start ${trialDays}-day trial`}
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      <Result result={state} />
    </>
  );
}
