"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The seven sections §70 requires, in that order.
 *
 * A client component only so it can mark the current page. It is given
 * three booleans and no data — nothing here can leak a credential
 * because nothing here has one.
 *
 * The dots are the one piece of judgement: a merchant landing on this
 * dashboard should be able to see, without clicking, that their catalog
 * failed or that Disc is not actually on their storefront yet. Those are
 * the two states where Disc looks broken and the merchant cannot tell
 * why.
 */

const SECTIONS = [
  // `/app` itself is the OAuth token handoff (a route handler, not a
  // page), so the overview lives one level down.
  { href: "/app/overview", label: "Overview" },
  { href: "/app/brand", label: "Brand" },
  { href: "/app/catalog", label: "Catalog" },
  { href: "/app/looks", label: "Looks" },
  { href: "/app/experience", label: "Experience" },
  { href: "/app/analytics", label: "Analytics" },
  { href: "/app/billing", label: "Billing" },
  { href: "/app/settings", label: "Settings" },
] as const;

export function Nav({
  needsActivation,
  catalogFailed,
  inactive,
}: {
  needsActivation: boolean;
  catalogFailed: boolean;
  inactive: boolean;
}) {
  const pathname = usePathname();

  function dotFor(href: string): string | null {
    if (href === "/app/catalog" && catalogFailed) return "var(--bad)";
    if (href === "/app/experience" && needsActivation) return "var(--warn)";
    if (href === "/app/billing" && inactive) return "var(--warn)";
    return null;
  }

  return (
    <nav className="nav">
      {SECTIONS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const dot = dotFor(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}>
            {label}
            {dot && (
              <span
                className="nav-dot"
                style={{ background: dot }}
                aria-label="Needs attention"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
