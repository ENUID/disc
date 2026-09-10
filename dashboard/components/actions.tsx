"use client";

import { useActionState, useTransition } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "@/app/actions";
import { resyncCatalog, signOut, startPreview, openPortal } from "@/app/actions";

/**
 * Buttons and forms that call server actions.
 *
 * These are the only client components in the dashboard, and they hold
 * no data — they call a server action and render what it returns. The
 * merchant token is never in this bundle.
 *
 * Every one of them reports its outcome. A button that silently does
 * nothing on failure is how a merchant ends up believing a resync ran
 * when it was rate-limited.
 */

export function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <div className={`note ${result.ok ? "ok" : "bad"}`} role="status">
      {result.ok ? result.message : result.error}
    </div>
  );
}

/** A button wired to a no-argument server action. */
function ActionButton({
  action,
  children,
  pendingLabel,
  className = "btn secondary",
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null>(
    async () => await action(),
    null,
  );

  return (
    <form action={formAction}>
      <button className={className} type="submit" disabled={pending}>
        {pending ? pendingLabel : children}
      </button>
      <Result result={state} />
    </form>
  );
}

export function ResyncButton() {
  return (
    <ActionButton action={resyncCatalog} pendingLabel="Queueing…">
      Resync catalog
    </ActionButton>
  );
}

export function PreviewButton() {
  return (
    <ActionButton action={startPreview} pendingLabel="Starting…">
      Preview on my store
    </ActionButton>
  );
}

export function ManageBillingButton() {
  return (
    <ActionButton action={openPortal} pendingLabel="Opening Stripe…">
      Manage subscription
    </ActionButton>
  );
}

export function SignOut() {
  const [pending, start] = useTransition();
  return (
    <button
      className="btn quiet small"
      style={{ alignSelf: "flex-start" }}
      disabled={pending}
      onClick={() => start(() => void signOut())}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

/** Submit button that knows when its parent form is in flight. */
export function Submit({
  children,
  pendingLabel,
  pending,
}: {
  children: ReactNode;
  pendingLabel: string;
  pending: boolean;
}) {
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export { useActionState };
