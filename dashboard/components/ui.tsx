import type { ReactNode } from "react";
import type {
  BrandBrainStatus,
  CatalogStatus,
  OnboardingStage,
  WidgetStatus,
} from "@/lib/types";

/**
 * Presentation primitives.
 *
 * The status mapping below is the one piece here that is not cosmetic.
 * §18 says "Do not fake progress" — so `pending` renders as "Not started"
 * rather than a hopeful spinner, and `error` is never softened into a
 * neutral grey. A merchant who cannot tell a stalled sync from a running
 * one will conclude Disc is broken and be right to.
 */

export type Tone = "ok" | "warn" | "bad" | "busy" | "idle";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" aria-hidden />
      {children}
    </span>
  );
}

const CATALOG: Record<CatalogStatus, { tone: Tone; label: string }> = {
  ready: { tone: "ok", label: "Ready" },
  syncing: { tone: "busy", label: "Syncing" },
  pending: { tone: "idle", label: "Not started" },
  error: { tone: "bad", label: "Failed" },
  unknown: { tone: "idle", label: "Unknown" },
};

const BRAIN: Record<BrandBrainStatus, { tone: Tone; label: string }> = {
  ready: { tone: "ok", label: "Ready" },
  building: { tone: "busy", label: "Building" },
  pending: { tone: "idle", label: "Not started" },
  error: { tone: "bad", label: "Failed" },
};

const WIDGET: Record<WidgetStatus, { tone: Tone; label: string }> = {
  live: { tone: "ok", label: "Live" },
  previewing: { tone: "busy", label: "Preview only" },
  inactive: { tone: "idle", label: "Off" },
};

export function CatalogPill({ status }: { status: CatalogStatus }) {
  const s = CATALOG[status] ?? CATALOG.unknown;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function BrainPill({ status }: { status: BrandBrainStatus }) {
  const s = BRAIN[status] ?? BRAIN.pending;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function WidgetPill({ status }: { status: WidgetStatus }) {
  const s = WIDGET[status] ?? WIDGET.inactive;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

/**
 * Subscription state in the merchant's language, not Stripe's.
 *
 * "past_due" is a real thing a merchant needs to act on, but reading it
 * as raw Stripe vocabulary in an admin panel is unkind.
 */
export function SubscriptionPill({
  status,
  enabled,
}: {
  status: string;
  enabled: boolean;
}) {
  if (!enabled) return <Pill tone="idle">Billing not enabled</Pill>;
  const map: Record<string, { tone: Tone; label: string }> = {
    active: { tone: "ok", label: "Active" },
    trialing: { tone: "ok", label: "Free trial" },
    past_due: { tone: "warn", label: "Payment failed" },
    unpaid: { tone: "bad", label: "Unpaid" },
    canceled: { tone: "bad", label: "Cancelled" },
    pending: { tone: "busy", label: "Checkout started" },
    none: { tone: "idle", label: "No subscription" },
  };
  const s = map[status] ?? { tone: "idle" as Tone, label: status };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function Card({
  title,
  hint,
  aside,
  children,
}: {
  title?: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || aside) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {hint && <p>{hint}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A single number.
 *
 * `null` renders as "—", never as 0. A rate with no denominator yet is
 * not zero percent; showing it as 0% reads as "nothing works" rather
 * than "nothing has happened yet", which is the same distinction the
 * backend makes when it returns null for these.
 */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <div className={`value${empty ? " none" : ""}`}>
        {empty ? "—" : typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Meter({
  label,
  count,
  total,
  tone = "ok",
}: {
  label: string;
  count: number;
  total: number;
  tone?: "ok" | "warn";
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="meter-group">
      <div className="meter-row">
        <span>{label}</span>
        <span className="n">
          {count.toLocaleString()} / {total.toLocaleString()} · {pct}%
        </span>
      </div>
      <div className="bar">
        <span
          className={tone === "warn" ? "warn" : undefined}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Stages({ stages }: { stages: OnboardingStage[] }) {
  return (
    <ul className="stages">
      {stages.map((stage) => (
        <li key={stage.key} className={stage.done || stage.failed ? "" : "pending"}>
          <span
            className={`stage-mark${stage.done ? " done" : ""}${stage.failed ? " failed" : ""}`}
            aria-hidden
          >
            {stage.failed ? "!" : stage.done ? "✓" : ""}
          </span>
          <span className="stage-label">{stage.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function PageHead({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return "Never";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

export function percent(rate: number | null): string | null {
  return rate === null || rate === undefined ? null : `${Math.round(rate * 100)}%`;
}
