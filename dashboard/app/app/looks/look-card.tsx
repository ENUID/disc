"use client";

import { useState, useTransition } from "react";
import { deleteLook, setLookStatus } from "@/app/actions";
import type { LookSummary } from "@/lib/looks-types";
import { Pill } from "@/components/ui";

/**
 * One look in the library.
 *
 * The approve control is the only thing here that changes what shoppers
 * see, so it says so. A merchant should never have to guess whether a
 * look is live — that ambiguity is what makes people distrust a tool
 * like this and stop using it.
 */
export function LookCard({ look }: { look: LookSummary }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function change(status: "draft" | "approved" | "archived") {
    setError(null);
    start(async () => {
      const result = await setLookStatus(look.id, status);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{look.title}</h3>
          <p>
            {look.itemCount} pieces
            {look.occasion ? ` · ${look.occasion.replace(/_/g, " ")}` : ""}
            {look.style ? ` · ${look.style.replace(/_/g, " ")}` : ""}
          </p>
        </div>
        {look.status === "approved" ? (
          <Pill tone="ok">In use</Pill>
        ) : look.status === "draft" ? (
          <Pill tone="idle">Draft</Pill>
        ) : (
          <Pill tone="idle">Archived</Pill>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {look.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={look.imageUrl}
            alt={look.title}
            style={{
              width: 96,
              height: 128,
              objectFit: "cover",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              flex: "none",
            }}
          />
        )}

        <ul style={{ margin: 0, padding: 0, listStyle: "none", minWidth: 0, flex: 1 }}>
          {look.products.map((product) => (
            <li
              key={product.productId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                padding: "4px 0",
                fontSize: 13.5,
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {product.title}
              </span>
              <span style={{ color: "var(--ink-faint)", flex: "none" }}>
                {product.slot}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="actions" style={{ marginTop: 14 }}>
        {look.status === "approved" ? (
          <button
            className="btn secondary small"
            disabled={pending}
            onClick={() => change("archived")}
          >
            {pending ? "…" : "Stop using"}
          </button>
        ) : (
          <button className="btn small" disabled={pending} onClick={() => change("approved")}>
            {pending ? "…" : "Approve"}
          </button>
        )}

        {confirmingDelete ? (
          <>
            <button
              className="btn secondary small"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await deleteLook(look.id);
                  if (!result.ok) setError(result.error);
                })
              }
            >
              Delete for good
            </button>
            <button
              className="btn quiet small"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <button className="btn quiet small" onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        )}

        {look.status === "draft" && (
          <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
            Not influencing recommendations yet.
          </span>
        )}
      </div>

      {error && (
        <div className="note bad" style={{ marginTop: 12, marginBottom: 0 }}>
          {error}
        </div>
      )}
    </section>
  );
}
