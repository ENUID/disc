"use client";

import { useActionState } from "react";
import { correctBrand, type ActionResult } from "@/app/actions";
import { Result, Submit } from "@/components/actions";
import type { BrandBrain } from "@/lib/types";

/**
 * Merchant correction (spec §138).
 *
 * Deliberately four fields, not a form for every facet Disc infers.
 * §17 says the merchant should primarily *correct* Disc rather than
 * teach it everything, and §19 says not to make them configure fifty
 * variables. These are the four a merchant actually disagrees with: how
 * their brand reads, how it speaks, what words it uses, and what colours
 * it is known for.
 *
 * Each field is prefilled with what Disc currently believes, so the
 * merchant is editing a claim rather than filling in a blank — and can
 * see at a glance whether Disc got it wrong at all.
 */
export function BrandCorrectionForm({ brand }: { brand: NonNullable<BrandBrain> }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    correctBrand,
    null,
  );

  return (
    <form action={action}>
      <label className="field">
        <span className="lab">How your brand reads</span>
        <span className="help">
          One or two sentences. This is what Disc uses to judge whether a product
          belongs in your world.
        </span>
        <textarea
          name="summary"
          defaultValue={brand.summary ?? ""}
          maxLength={400}
          placeholder="Quiet, tailored pieces in natural fabrics for people who dress deliberately."
        />
      </label>

      <label className="field">
        <span className="lab">Tone</span>
        <span className="help">
          Comma-separated. How Disc talks to your shoppers.
        </span>
        <input
          type="text"
          name="tone"
          defaultValue={(brand.voice?.tone ?? []).join(", ")}
          placeholder="understated, warm, precise"
        />
      </label>

      <label className="field">
        <span className="lab">Vocabulary</span>
        <span className="help">
          Words your brand uses — and that Disc should use back.
        </span>
        <input
          type="text"
          name="vocabulary"
          defaultValue={(brand.voice?.vocabulary ?? []).join(", ")}
          placeholder="considered, tailored, weightless"
        />
      </label>

      <label className="field">
        <span className="lab">Signature colours</span>
        <span className="help">
          The colours you are known for, whatever your catalog happens to be
          heaviest in this season.
        </span>
        <input
          type="text"
          name="dominant"
          defaultValue={(brand.palette?.dominant ?? []).join(", ")}
          placeholder="cream, charcoal, olive"
        />
      </label>

      <div className="actions">
        <Submit pending={pending} pendingLabel="Saving…">
          Save correction
        </Submit>
        <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
          Creates version {brand.version + 1}. Nothing already recommended
          changes.
        </span>
      </div>

      <Result result={state} />
    </form>
  );
}
