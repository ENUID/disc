"use client";

import { useActionState } from "react";
import { saveExperience, type ActionResult } from "@/app/actions";
import { Result, Submit } from "@/components/actions";
import type { WidgetConfig } from "@/lib/types";

/**
 * The experience controls.
 *
 * Every option here maps to a closed vocabulary the backend re-validates
 * — a select with fixed options rather than a text field is the point,
 * not a convenience. §65: merchant styling resolves to known design
 * tokens, never arbitrary CSS.
 */

const WORKFLOWS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "PRODUCT_SEARCH",
    label: "Find a product",
    hint: "Describe what you want in your own words",
  },
  { value: "SIMILAR", label: "Show similar", hint: "More like this one" },
  {
    value: "STYLE_PRODUCT",
    label: "Style this piece",
    hint: "How to wear something they are looking at",
  },
  {
    value: "COMPLETE_LOOK",
    label: "Complete the look",
    hint: "What goes with it",
  },
  {
    value: "OUTFIT",
    label: "Build an outfit",
    hint: "A whole look for an occasion",
  },
];

const PLACEMENTS = [
  { value: "bottom_bar", label: "Bar along the bottom" },
  { value: "floating_button", label: "Floating button" },
];

const DENSITIES = [
  { value: "airy", label: "Airy" },
  { value: "balanced", label: "Balanced" },
  { value: "dense", label: "Dense" },
];

const MOTIONS = [
  { value: "subtle", label: "Subtle" },
  { value: "standard", label: "Standard" },
  { value: "none", label: "None" },
];

const CARD_STYLES = [
  { value: "editorial", label: "Editorial" },
  { value: "clean", label: "Clean" },
  { value: "bold", label: "Bold" },
];

const RADII = [
  { value: "none", label: "Square" },
  { value: "small", label: "Slightly rounded" },
  { value: "medium", label: "Rounded" },
  { value: "large", label: "Very rounded" },
];

export function ExperienceForm({ config }: { config: WidgetConfig }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveExperience,
    null,
  );

  return (
    <form action={action}>
      <label className="toggle-row">
        <input type="checkbox" name="enabled" defaultChecked={config.enabled} />
        <span>
          <span className="lab">Show Disc to shoppers</span>
          <span className="help">
            While this is on, Disc replaces your theme&rsquo;s search box. Turn it
            off and your own search comes back — nothing is uninstalled.
          </span>
        </span>
      </label>

      <label className="field">
        <span className="lab">Greeting</span>
        <span className="help">The first thing a shopper reads in the bar.</span>
        <input
          type="text"
          name="greeting"
          defaultValue={config.greeting}
          maxLength={120}
          placeholder="What are you looking for?"
        />
      </label>

      <Select
        name="placement"
        label="Placement"
        help="Where Disc sits on the page."
        options={PLACEMENTS}
        value={config.placement}
      />

      <div className="field">
        <span className="lab">What shoppers can ask for</span>
        <span className="help">
          Turn off anything that does not suit your catalog. A store with one
          category rarely wants outfit building.
        </span>
        <div className="checks">
          {WORKFLOWS.map((workflow) => (
            <label className="check" key={workflow.value} title={workflow.hint}>
              <input
                type="checkbox"
                name="workflows"
                value={workflow.value}
                defaultChecked={config.workflows.includes(workflow.value)}
              />
              {workflow.label}
            </label>
          ))}
        </div>
      </div>

      <h3
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--ink-faint)",
          margin: "26px 0 12px",
        }}
      >
        Look and feel
      </h3>

      <div className="grid-2">
        <Select
          name="cardStyle"
          label="Product cards"
          options={CARD_STYLES}
          value={config.design.cardStyle}
        />
        <Select
          name="density"
          label="Spacing"
          options={DENSITIES}
          value={config.design.density}
        />
        <Select
          name="cornerRadius"
          label="Corners"
          options={RADII}
          value={config.design.cornerRadius}
        />
        <Select
          name="motion"
          label="Motion"
          options={MOTIONS}
          value={config.design.motion}
        />
      </div>

      <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
        Colours and type come from your Brand Brain, not from here — Disc matches
        your store rather than asking you to describe it twice.
      </p>

      <div className="actions">
        <Submit pending={pending} pendingLabel="Saving…">
          Save
        </Submit>
      </div>

      <Result result={state} />
    </form>
  );
}

function Select({
  name,
  label,
  help,
  options,
  value,
}: {
  name: string;
  label: string;
  help?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <label className="field">
      <span className="lab">{label}</span>
      {help && <span className="help">{help}</span>}
      <select name={name} defaultValue={value}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
