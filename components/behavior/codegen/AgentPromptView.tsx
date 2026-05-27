"use client";

// AgentPromptView — editable review panel for the PromptGen-produced AgentPrompt.
//
// Renders each section (intent/role/trigger/inputs/steps/tools/emits/
// constraints/acceptance) in collapsible editable form. Provenance badges
// show fieldOrigin. The confirm gate requires trigger.confirmed === true AND
// a non-empty slug before enabling [Accept & Generate Code].

import React from "react";
import { useApp } from "@/lib/i18n";
import type { AgentPrompt, FieldOrigin } from "@/lib/agent-codegen/prompt-gen/prompt-types";
import type { AgentFormFields } from "@/lib/agent-codegen/spec-types";

type Props = {
  prompt: AgentPrompt;
  onChange: (p: AgentPrompt) => void;
  missingTools: string[];
  onRegenerate: () => void;
  form: AgentFormFields;
  onFormChange: (f: AgentFormFields) => void;
  onAccept: () => void;
  busy: boolean;
};

export function AgentPromptView({
  prompt,
  onChange,
  missingTools,
  onRegenerate,
  form,
  onFormChange,
  onAccept,
  busy,
}: Props) {
  const { t } = useApp();

  // Slug regex mirrors AgentFormFieldsSchema / AgentConfigForm.formIsValid
  const SLUG_RE = /^[a-z][a-z0-9-]*-agent$/;

  // Confirm gate: trigger confirmed, slug confirmed + valid, displayName, ownerTeam
  const slugOk = SLUG_RE.test(form.slug ?? "");
  const slugConfirmed = prompt.fieldOrigin["slug"] === "confirmed";
  const displayNameOk = !!form.displayName?.trim();
  const ownerTeamOk = !!form.ownerTeam?.trim();
  const canAccept =
    !busy &&
    prompt.trigger.confirmed &&
    slugConfirmed &&
    slugOk &&
    displayNameOk &&
    ownerTeamOk;

  function setPromptField<K extends keyof AgentPrompt>(key: K, val: AgentPrompt[K]) {
    onChange({ ...prompt, [key]: val });
  }

  function confirmTrigger() {
    onChange({
      ...prompt,
      trigger: { ...prompt.trigger, confirmed: true },
      fieldOrigin: { ...prompt.fieldOrigin, triggerEvent: "confirmed" },
    });
  }

  function confirmSlug() {
    onChange({
      ...prompt,
      fieldOrigin: { ...prompt.fieldOrigin, slug: "confirmed" },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tool-gap banner */}
      {missingTools.length > 0 && (
        <div
          className="px-3 py-2.5 rounded-md border text-[11.5px]"
          style={{
            background: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 8%, var(--c-panel))",
            borderColor: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 35%, var(--c-line))",
            color: "oklch(0.5 0.14 75)",
          }}
        >
          <div className="font-semibold mb-1">{t("pg_toolgap_title")}</div>
          <div className="text-[11px] mb-2">{t("pg_toolgap_hint")}</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {missingTools.map((tool) => (
              <span
                key={tool}
                className="px-1.5 py-0.5 rounded mono text-[10.5px] border"
                style={{
                  background: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 12%, var(--c-panel))",
                  borderColor: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 30%, var(--c-line))",
                }}
              >
                {tool}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/behavior/codegen/library"
              className="text-[11.5px] underline"
              style={{ color: "oklch(0.5 0.14 75)" }}
            >
              {t("pg_toolgap_cta")}
            </a>
            <button
              onClick={onRegenerate}
              className="h-6 px-2.5 rounded text-[11px] font-medium border-0 cursor-pointer"
              style={{ background: "oklch(0.5 0.14 75)", color: "white" }}
            >
              {t("pg_regenerate")}
            </button>
          </div>
        </div>
      )}

      {/* Prompt sections */}
      <Section title="Intent / Role">
        <FieldRow label="Intent" origin={prompt.fieldOrigin["intent"]}>
          <textarea
            value={prompt.intent}
            onChange={(e) => setPromptField("intent", e.target.value)}
            rows={2}
            className="w-full p-1.5 bg-bg border border-line rounded text-[11.5px] leading-[1.5] resize-vertical"
            style={{ color: "var(--c-ink-1)" }}
          />
        </FieldRow>
        <FieldRow label="Role" origin={prompt.fieldOrigin["role"]}>
          <textarea
            value={prompt.role}
            onChange={(e) => setPromptField("role", e.target.value)}
            rows={2}
            className="w-full p-1.5 bg-bg border border-line rounded text-[11.5px] leading-[1.5] resize-vertical"
            style={{ color: "var(--c-ink-1)" }}
          />
        </FieldRow>
      </Section>

      {/* Trigger */}
      <Section title="Trigger">
        <FieldRow label="Event" origin={prompt.fieldOrigin["triggerEvent"]}>
          <div className="flex items-center gap-2">
            <span
              className="flex-1 px-2 py-1 rounded border border-line bg-bg mono text-[11.5px]"
              style={{ color: "var(--c-ink-1)" }}
            >
              {prompt.trigger.event}
            </span>
            {!prompt.trigger.confirmed ? (
              <button
                onClick={confirmTrigger}
                className="h-6 px-2 rounded text-[10.5px] font-medium border-0 cursor-pointer whitespace-nowrap"
                style={{ background: "var(--c-accent)", color: "white" }}
              >
                {t("pg_confirm_trigger")}
              </button>
            ) : (
              <OriginBadge origin="confirmed" />
            )}
          </div>
        </FieldRow>
        <FieldRow label="Payload expectations" origin={undefined}>
          <textarea
            value={prompt.trigger.payloadExpectations}
            onChange={(e) =>
              onChange({
                ...prompt,
                trigger: { ...prompt.trigger, payloadExpectations: e.target.value },
              })
            }
            rows={2}
            className="w-full p-1.5 bg-bg border border-line rounded text-[11.5px] leading-[1.5] resize-vertical"
            style={{ color: "var(--c-ink-1)" }}
          />
        </FieldRow>
        {/* Additional trigger events (read-only chips) */}
        {prompt.additionalTriggerEvents && prompt.additionalTriggerEvents.length > 0 && (
          <FieldRow label="Additional triggers (hand-finish)" origin={undefined}>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {prompt.additionalTriggerEvents.map((ev) => (
                <span
                  key={ev}
                  className="px-1.5 py-0.5 rounded border border-line bg-panel mono text-[10.5px] text-ink-3"
                >
                  {ev}
                </span>
              ))}
            </div>
          </FieldRow>
        )}
      </Section>

      {/* Slug (lives in form, not prompt) */}
      <Section title="Slug">
        <FieldRow label="slug" origin={prompt.fieldOrigin["slug"]}>
          <div className="flex items-center gap-2">
            <input
              value={form.slug ?? ""}
              onChange={(e) => onFormChange({ ...form, slug: e.target.value })}
              className="flex-1 px-2 py-1 rounded border border-line bg-bg mono text-[11.5px]"
              style={{ color: "var(--c-ink-1)" }}
              placeholder="my-agent-slug"
            />
            {prompt.fieldOrigin["slug"] !== "confirmed" ? (
              <button
                onClick={confirmSlug}
                disabled={!form.slug?.trim()}
                className="h-6 px-2 rounded text-[10.5px] font-medium border-0 cursor-pointer whitespace-nowrap"
                style={{
                  background: "var(--c-accent)",
                  color: "white",
                  opacity: form.slug?.trim() ? 1 : 0.45,
                }}
              >
                {t("pg_confirm_slug")}
              </button>
            ) : (
              <OriginBadge origin="confirmed" />
            )}
          </div>
        </FieldRow>
      </Section>

      {/* Steps */}
      <CollapsibleSection title={`Steps (${prompt.steps.length})`}>
        {prompt.steps.map((step, i) => (
          <div
            key={step.id}
            className="flex flex-col gap-1 px-2 py-1.5 rounded border border-line bg-bg mb-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] mono text-ink-4 w-4">{i + 1}.</span>
              <span className="mono text-[11px] text-ink-2">{step.id}</span>
            </div>
            <textarea
              value={step.description}
              onChange={(e) => {
                const next = [...prompt.steps];
                next[i] = { ...step, description: e.target.value };
                setPromptField("steps", next);
              }}
              rows={2}
              className="w-full p-1.5 bg-panel border border-line rounded text-[11px] leading-[1.5] resize-vertical"
              style={{ color: "var(--c-ink-1)" }}
            />
            {step.usesTools && step.usesTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {step.usesTools.map((tool) => (
                  <span
                    key={tool}
                    className="px-1.5 py-0.5 rounded border border-line bg-panel mono text-[10px] text-ink-3"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </CollapsibleSection>

      {/* Tools */}
      <CollapsibleSection title={`Tools (${prompt.tools.length})`}>
        <StringListEditor
          items={prompt.tools}
          onChange={(v) => setPromptField("tools", v)}
        />
      </CollapsibleSection>

      {/* Emits */}
      <CollapsibleSection title={`Emits (${prompt.emits.length})`}>
        <StringListEditor
          items={prompt.emits}
          onChange={(v) => setPromptField("emits", v)}
        />
      </CollapsibleSection>

      {/* Inputs */}
      <CollapsibleSection title={`Inputs (${prompt.inputs.length})`}>
        <StringListEditor
          items={prompt.inputs}
          onChange={(v) => setPromptField("inputs", v)}
        />
      </CollapsibleSection>

      {/* Constraints */}
      <CollapsibleSection title={`Constraints (${prompt.constraints.length})`}>
        <StringListEditor
          items={prompt.constraints}
          onChange={(v) => setPromptField("constraints", v)}
        />
      </CollapsibleSection>

      {/* Acceptance */}
      <CollapsibleSection title={`Acceptance (${prompt.acceptance.length})`}>
        <StringListEditor
          items={prompt.acceptance}
          onChange={(v) => setPromptField("acceptance", v)}
        />
      </CollapsibleSection>

      {/* Error handling */}
      <Section title="Error handling">
        <select
          value={prompt.errorHandling}
          onChange={(e) =>
            setPromptField("errorHandling", e.target.value as AgentPrompt["errorHandling"])
          }
          className="w-full px-2 py-1 bg-panel border border-line rounded text-[11.5px]"
          style={{ color: "var(--c-ink-1)" }}
        >
          <option value="retry">retry</option>
          <option value="dlq">dlq</option>
          <option value="hitl-fallback">hitl-fallback</option>
        </select>
      </Section>

      {/* Accept & Generate Code */}
      <div className="flex flex-col gap-1.5 pt-1">
        {!prompt.trigger.confirmed && (
          <p className="text-[10.5px] text-ink-4 m-0">
            Confirm the trigger event above to enable code generation.
          </p>
        )}
        {(!form.slug?.trim() || !slugOk) && (
          <p className="text-[10.5px] text-ink-4 m-0">
            Slug must be kebab-case ending in <span className="mono">-agent</span> (e.g. <span className="mono">my-thing-agent</span>).
          </p>
        )}
        {form.slug?.trim() && slugOk && !slugConfirmed && (
          <p className="text-[10.5px] text-ink-4 m-0">
            Click "Confirm slug" above to lock the slug before generating code.
          </p>
        )}
        {!displayNameOk && (
          <p className="text-[10.5px] text-ink-4 m-0">
            A display name is required (set it in the form below).
          </p>
        )}
        {!ownerTeamOk && (
          <p className="text-[10.5px] text-ink-4 m-0">
            An owner team is required (set it in the form below).
          </p>
        )}
        <button
          onClick={onAccept}
          disabled={!canAccept}
          className="h-8 px-4 rounded-md text-[12.5px] font-medium border-0 cursor-pointer self-start"
          style={{
            background: "var(--c-ok)",
            color: "white",
            opacity: canAccept ? 1 : 0.4,
          }}
        >
          {busy ? "Generating…" : t("pg_accept_generate")}
        </button>
      </div>
    </div>
  );
}

// ── Internal atoms ────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4">{title}</div>
      {children}
    </div>
  );
}

function CollapsibleSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.06em] text-ink-4 border-0 bg-transparent cursor-pointer p-0 text-left"
      >
        <span style={{ fontSize: 9 }}>{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="flex flex-col gap-0.5 pl-1">{children}</div>}
    </div>
  );
}

function FieldRow({
  label,
  origin,
  children,
}: {
  label: string;
  origin: FieldOrigin | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-ink-4">{label}</span>
        {origin && <OriginBadge origin={origin} />}
      </div>
      {children}
    </div>
  );
}

function OriginBadge({ origin }: { origin: FieldOrigin }) {
  const { t } = useApp();
  const label =
    origin === "inferred"
      ? t("pg_origin_inferred")
      : origin === "locked"
      ? t("pg_origin_locked")
      : t("pg_origin_confirmed");

  const color =
    origin === "confirmed"
      ? "var(--c-ok)"
      : origin === "locked"
      ? "var(--c-accent)"
      : "var(--c-ink-4)";

  return (
    <span
      className="px-1 py-px rounded text-[9px] font-medium"
      style={{
        background: `color-mix(in oklab, ${color} 12%, var(--c-panel))`,
        color,
        border: `1px solid color-mix(in oklab, ${color} 30%, var(--c-line))`,
      }}
    >
      {label}
    </span>
  );
}

function StringListEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={item}
            onChange={(e) => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
            className="flex-1 px-2 py-0.5 bg-bg border border-line rounded text-[11px] mono"
            style={{ color: "var(--c-ink-1)" }}
          />
          <button
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="w-5 h-5 rounded border-0 cursor-pointer text-[10px] flex items-center justify-center"
            style={{ background: "var(--c-panel)", color: "var(--c-ink-4)" }}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...items, ""])}
        className="h-5 px-2 rounded border-0 cursor-pointer text-[10px] self-start"
        style={{ background: "var(--c-panel)", color: "var(--c-ink-3)" }}
      >
        + add
      </button>
    </div>
  );
}
