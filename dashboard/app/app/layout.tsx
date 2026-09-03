import { redirect } from "next/navigation";
import { apiGet, hasSession } from "@/lib/api";
import type { Overview } from "@/lib/types";
import { Nav } from "@/components/nav";
import { SignOut } from "@/components/actions";

/**
 * Authenticated shell.
 *
 * The token is read here, server-side, and never handed to a client
 * component. The nav is a client component only because it needs the
 * current pathname to mark the active link; it receives labels and
 * counts, never credentials.
 */

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await hasSession())) redirect("/");

  // One cheap call for the chrome: the shop name and the two badges the
  // nav shows. Each page fetches its own section separately.
  const overview = await apiGet<Overview | null>("/merchant/overview");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark">
          <span className="disc" aria-hidden />
          Disc
        </div>
        {overview && <div className="shop-chip">{overview.shopDomain}</div>}

        <Nav
          needsActivation={overview?.needsActivation ?? false}
          catalogFailed={overview?.status.catalog === "error"}
          inactive={overview ? !overview.status.active : false}
        />

        <div className="sidebar-foot">
          <SignOut />
          <span>Disc by Enuid Labs</span>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
