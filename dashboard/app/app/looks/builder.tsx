"use client";

import { useRef, useState, useTransition } from "react";
import {
  analyseImage,
  getUploadUrl,
  saveLook,
  suggestProducts,
} from "@/app/actions";
import type { AnalyseResult, DetectedGarment, Suggestion } from "@/lib/looks-types";

/**
 * Upload an image, map its garments to real products, save a look.
 *
 * The mapping step is the product, and the shape of it is the whole
 * argument: Disc says what it *thinks* each garment is and the merchant
 * decides. A model can see "a white shirt" and have no idea which of
 * fourteen white shirts it is, so nothing is ever auto-assigned — an
 * unconfirmed row is simply left out of the look rather than guessed at.
 *
 * The one concession to not making this a chore (§8: do not ask a
 * merchant to tag 500 outfits): the top suggestion is pre-selected when
 * the model is confident, visibly, and one click clears it.
 */

/** Above this retrieval score, the top match is pre-selected. */
const PRESELECT_THRESHOLD = 0.62;

type Row = {
  detected: DetectedGarment;
  suggestions: Suggestion[];
  /** null means "not part of this look" — a real, chosen outcome. */
  selected: string | null;
};

export function LookBuilder() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [stage, setStage] = useState<"idle" | "uploading" | "analysing" | "mapping">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [storageId, setStorageId] = useState<string | null>(null);
  const [detected, setDetected] = useState<AnalyseResult["detected"]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [title, setTitle] = useState("");

  function reset() {
    setStage("idle");
    setPreview(null);
    setStorageId(null);
    setDetected([]);
    setRows([]);
    setTitle("");
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onFile(file: File) {
    setError(null);
    setMessage(null);

    if (!file.type.startsWith("image/")) {
      setError("That is not an image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Images need to be under 10MB.");
      return;
    }

    setPreview(URL.createObjectURL(file));
    setStage("uploading");

    const urlResult = await getUploadUrl();
    if (!urlResult.ok) {
      setError(urlResult.error);
      setStage("idle");
      return;
    }

    // Straight from the browser to storage. Routing multi-megabyte
    // photography through a serverless function would be slower and buy
    // nothing.
    const upload = await fetch(urlResult.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!upload.ok) {
      setError("Upload failed. Try again.");
      setStage("idle");
      return;
    }
    const { storageId: id } = await upload.json();
    setStorageId(id);

    setStage("analysing");
    const analysis = await analyseImage(id);
    if (!analysis.ok) {
      setError(analysis.error);
      setStage("idle");
      return;
    }

    setDetected(analysis.result.detected);
    setRows(
      analysis.result.detected.map((garment, i) => {
        const suggestions = analysis.result.suggestions[i] ?? [];
        const top = suggestions[0];
        return {
          detected: garment,
          suggestions,
          // Pre-selected only when the match is strong. A weak guess
          // pre-selected is worse than no guess: it invites a merchant
          // to click through and teach Disc something untrue.
          selected:
            top && top.score >= PRESELECT_THRESHOLD ? top.productId : null,
        };
      }),
    );
    setTitle(defaultTitle(analysis.result.detected));
    setStage("mapping");

    if (analysis.result.detected.length === 0) {
      setError(
        "Disc could not make out any garments in that image. A photograph of the pieces being worn works best.",
      );
    }
  }

  function onSave() {
    const items = rows
      .filter((row) => row.selected)
      .map((row) => ({
        productId: row.selected!,
        detectedLabel: row.detected.label,
        confidence: row.suggestions.find((s) => s.productId === row.selected)?.score,
      }));

    if (items.length < 2) {
      setError("Map at least two products — a look is an outfit, not one piece.");
      return;
    }

    start(async () => {
      const result = await saveLook({
        title: title.trim() || "Untitled look",
        imageStorageId: storageId ?? undefined,
        detected,
        items,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(
        `Saved as a draft with ${items.length} products. Approve it below and Disc starts styling with it.`,
      );
      reset();
    });
  }

  if (stage === "idle") {
    return (
      <>
        <p style={{ marginTop: 0, color: "var(--ink-muted)" }}>
          A campaign shot, a lookbook page, an outfit photo — anything where
          your pieces are worn together. Disc will pick out the garments and ask
          you which products they are.
        </p>
        <div className="actions">
          <button
            className="btn"
            onClick={() => fileInput.current?.click()}
            disabled={pending}
          >
            Choose an image
          </button>
          <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
            JPEG or PNG, up to 10MB.
          </span>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
        {error && <div className="note bad" style={{ marginTop: 14 }}>{error}</div>}
        {message && <div className="note ok" style={{ marginTop: 14 }}>{message}</div>}
      </>
    );
  }

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="The look being mapped"
            style={{
              width: "100%",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
            }}
          />
        )}

        <div style={{ minWidth: 0 }}>
          {stage === "uploading" && <p>Uploading…</p>}
          {stage === "analysing" && (
            <p>
              Looking at the image… <br />
              <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>
                Disc is picking out the garments. This takes a few seconds.
              </span>
            </p>
          )}

          {stage === "mapping" && (
            <>
              <label className="field">
                <span className="lab">Name this look</span>
                <input
                  type="text"
                  value={title}
                  maxLength={120}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Autumn campaign 01"
                />
              </label>

              <div className="field">
                <span className="lab">What Disc found</span>
                <span className="help">
                  Pick the real product for each garment. Disc suggests, you
                  decide — anything you leave unmatched is simply left out.
                </span>
              </div>

              {rows.map((row, index) => (
                <GarmentRow
                  key={index}
                  row={row}
                  onSelect={(productId) =>
                    setRows((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, selected: productId } : r,
                      ),
                    )
                  }
                  onSearch={async (query) => {
                    const result = await suggestProducts(
                      query,
                      row.detected.slot ?? undefined,
                    );
                    if (!result.ok) return [];
                    setRows((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, suggestions: result.suggestions } : r,
                      ),
                    );
                    return result.suggestions;
                  }}
                />
              ))}

              <div className="actions" style={{ marginTop: 18 }}>
                <button className="btn" onClick={onSave} disabled={pending}>
                  {pending ? "Saving…" : "Save as draft"}
                </button>
                <button className="btn secondary" onClick={reset} disabled={pending}>
                  Cancel
                </button>
                <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
                  {rows.filter((r) => r.selected).length} of {rows.length} mapped
                </span>
              </div>
            </>
          )}

          {error && <div className="note bad" style={{ marginTop: 14 }}>{error}</div>}
        </div>
      </div>
    </>
  );
}

function GarmentRow({
  row,
  onSelect,
  onSearch,
}: {
  row: Row;
  onSelect: (productId: string | null) => void;
  onSearch: (query: string) => Promise<Suggestion[]>;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: 12,
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <strong style={{ textTransform: "capitalize" }}>{row.detected.label}</strong>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
          {row.detected.slot ?? "unrecognised"}
        </span>
      </div>

      {row.suggestions.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "0 0 8px" }}>
          No catalog matches. Search for it below.
        </p>
      ) : (
        <div className="checks" style={{ marginBottom: 8 }}>
          {row.suggestions.map((suggestion) => (
            <label className="check" key={suggestion.productId}>
              <input
                type="radio"
                name={`garment-${row.detected.label}`}
                checked={row.selected === suggestion.productId}
                onChange={() => onSelect(suggestion.productId)}
              />
              {suggestion.title}
            </label>
          ))}
          {/* Not part of this look is a real answer, not an absence of one. */}
          <label className="check">
            <input
              type="radio"
              name={`garment-${row.detected.label}`}
              checked={row.selected === null}
              onChange={() => onSelect(null)}
            />
            Not in my catalog
          </label>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={query}
          placeholder="Search your catalog…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            setSearching(true);
            void onSearch(query).finally(() => setSearching(false));
          }}
        />
        <button
          className="btn secondary small"
          disabled={searching || !query.trim()}
          onClick={() => {
            setSearching(true);
            void onSearch(query).finally(() => setSearching(false));
          }}
        >
          {searching ? "…" : "Search"}
        </button>
      </div>
    </div>
  );
}

function defaultTitle(detected: DetectedGarment[]): string {
  const named = detected.map((d) => d.garment).filter(Boolean);
  if (named.length === 0) return "";
  return named.slice(0, 3).join(" + ");
}
