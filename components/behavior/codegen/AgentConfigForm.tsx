"use client";

// AgentConfigForm — the left-rail input surface for Codegen v2.
//
// Replaces the v1 free-form prompt. The operator picks identity / wire-up /
// behavior here (human decisions); the textarea at the bottom is the
// "what the steps should do" prose that feeds the LLM.
//
// Two modes:
//   🔁 Regenerate existing  — pick from AGENT_MAP; form prefills.
//                             Stage / Owner / Slug stay editable but you
//                             can tell at a glance you're regenerating
//                             a known agent (badge in the header).
//   ✨ New agent             — all fields editable from scratch; required
//                             marker on every field; client-side validates
//                             slug shape + event-name membership.

import React from "react";
import { useApp } from "@/lib/i18n";
import { AGENT_MAP, byShort, type AgentMeta, type Stage } from "@/lib/agent-mapping";
import { useDomain } from "@/lib/domains";
import { getEventRegistry } from "@/lib/agent-codegen/registries";
import type { AgentFormFields } from "@/lib/agent-codegen/spec-types";

const STAGES: Stage[] = [
  "system",
  "requirement",
  "jd",
  "resume",
  "match",
  "interview",
  "eval",
  "package",
  "submit",
];

const ERROR_HANDLINGS = ["retry", "dlq", "hitl-fallback"] as const;

export type FormMode = "regenerate" | "new";

export type AgentConfigFormState = AgentFormFields & {
  mode: FormMode;
  /** When mode='regenerate', the AGENT_MAP short the form was prefilled from. */
  regenerateFromShort: string | null;
};

export function emptyFormState(): AgentConfigFormState {
  return {
    mode: "new",
    regenerateFromShort: null,
    slug: "",
    displayName: "",
    stage: "system",
    ownerTeam: "",
    triggerEvent: "",
    emitEvents: [],
    retries: 2,
    errorHandling: "retry",
  };
}

export function stateFromAgentMeta(meta: AgentMeta): AgentConfigFormState {
  const slug =
    meta.inngestId ??
    meta.short.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() + "-agent";
  return {
    mode: "regenerate",
    regenerateFromShort: meta.short,
    slug,
    displayName: meta.inngestName ?? meta.short,
    stage: meta.stage,
    ownerTeam: meta.ownerTeam,
    triggerEvent: meta.triggersEvents[0] ?? "",
    emitEvents: [...meta.emitsEvents],
    retries: 2,
    errorHandling: "retry",
  };
}

/** Strip the mode/regenerate metadata before sending to the API. */
export function toApiPayload(s: AgentConfigFormState): AgentFormFields {
  return {
    slug: s.slug,
    displayName: s.displayName,
    stage: s.stage,
    ownerTeam: s.ownerTeam,
    triggerEvent: s.triggerEvent,
    emitEvents: s.emitEvents,
    retries: s.retries,
    errorHandling: s.errorHandling,
  };
}

export function formIsValid(s: AgentConfigFormState, knownEvents: Set<string>): string[] {
  const errs: string[] = [];
  if (!/^[a-z][a-z0-9-]*-agent$/.test(s.slug))
    errs.push("slug 必须是 kebab-case 且以 -agent 结尾");
  if (!s.displayName.trim()) errs.push("Display name 不能为空");
  if (!s.ownerTeam.trim()) errs.push("Owner team 不能为空");
  if (!s.triggerEvent || !knownEvents.has(s.triggerEvent))
    errs.push("Trigger event 必须从事件注册表选");
  for (const e of s.emitEvents) {
    if (!knownEvents.has(e)) {
      errs.push(`Emit event "${e}" 不在事件注册表`);
    }
  }
  return errs;
}

// ────────────────────────────────────────────────────────────────────────

export function AgentConfigForm({
  state,
  setState,
  businessLogic,
  setBusinessLogic,
  onGenerate,
  busy,
}: {
  state: AgentConfigFormState;
  setState: React.Dispatch<React.SetStateAction<AgentConfigFormState>>;
  businessLogic: string;
  setBusinessLogic: (v: string) => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const { t, lang } = useApp();
  const { domain } = useDomain();
  const eventRegistry = React.useMemo(() => getEventRegistry(domain), [domain]);
  const knownEventNames = React.useMemo(
    () => new Set(eventRegistry.map((e) => e.name)),
    [eventRegistry],
  );

  // Owner teams: derive from AGENT_MAP so the dropdown reflects real teams.
  const ownerTeams = React.useMemo(() => {
    const set = new Set<string>();
    for (const m of AGENT_MAP) set.add(m.ownerTeam);
    return [...set].sort();
  }, []);

  // Validation errors (purely advisory — the button just disables on any).
  const errors = React.useMemo(
    () => formIsValid(state, knownEventNames),
    [state, knownEventNames],
  );
  const canGenerate = errors.length === 0 && businessLogic.trim().length >= 8 && !busy;

  return (
    <div className="flex flex-col gap-4">
      {/* Mode switcher */}
      <div>
        <Label>{t("codegen_form_mode")}</Label>
        <ModeSwitcher state={state} setState={setState} />
      </div>

      {/* Identity */}
      <Section title={t("codegen_form_section_identity")}>
        <Field label={t("codegen_form_slug")}>
          <input
            value={state.slug}
            onChange={(e) => setState((s) => ({ ...s, slug: e.target.value }))}
            spellCheck={false}
            className={inputClass}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}
            placeholder="my-thing-agent"
          />
        </Field>
        <Field label={t("codegen_form_name")}>
          <input
            value={state.displayName}
            onChange={(e) => setState((s) => ({ ...s, displayName: e.target.value }))}
            spellCheck={false}
            className={inputClass}
            placeholder="My Thing Agent"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("codegen_form_stage")}>
            <select
              value={state.stage}
              onChange={(e) =>
                setState((s) => ({ ...s, stage: e.target.value as Stage }))
              }
              className={inputClass}
            >
              {STAGES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("codegen_form_owner")}>
            <select
              value={state.ownerTeam}
              onChange={(e) => setState((s) => ({ ...s, ownerTeam: e.target.value }))}
              className={inputClass}
            >
              <option value="">—</option>
              {ownerTeams.map((tm) => (
                <option key={tm} value={tm}>
                  {tm}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      {/* Wire-up */}
      <Section title={t("codegen_form_section_wireup")}>
        <Field label={t("codegen_form_trigger")}>
          <select
            value={state.triggerEvent}
            onChange={(e) =>
              setState((s) => ({ ...s, triggerEvent: e.target.value }))
            }
            className={inputClass}
          >
            <option value="">—</option>
            {eventRegistry.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("codegen_form_emits")}>
          <EmitEventEditor
            value={state.emitEvents}
            onChange={(next) => setState((s) => ({ ...s, emitEvents: next }))}
            knownEvents={eventRegistry.map((e) => e.name)}
          />
        </Field>
      </Section>

      {/* Behavior */}
      <Section title={t("codegen_form_section_behavior")}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("codegen_form_retries")}>
            <input
              type="number"
              min={0}
              max={5}
              value={state.retries}
              onChange={(e) =>
                setState((s) => ({ ...s, retries: Number(e.target.value) || 0 }))
              }
              className={inputClass}
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
          </Field>
          <Field label={t("codegen_form_error_handling")}>
            <select
              value={state.errorHandling}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  errorHandling: e.target.value as AgentFormFields["errorHandling"],
                }))
              }
              className={inputClass}
            >
              {ERROR_HANDLINGS.map((eh) => (
                <option key={eh} value={eh}>
                  {eh}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      {/* Business logic */}
      <Section
        title={t("codegen_form_section_logic")}
        hint={t("codegen_form_logic_hint")}
      >
        <textarea
          value={businessLogic}
          onChange={(e) => setBusinessLogic(e.target.value)}
          rows={9}
          spellCheck={false}
          placeholder={t("codegen_form_logic_placeholder")}
          disabled={busy}
          className="w-full p-2 bg-panel border border-line rounded-md text-[12px] leading-[1.55] resize-vertical"
        />
      </Section>

      {/* Validation summary (advisory) */}
      {errors.length > 0 && (
        <div
          className="px-3 py-2 rounded-md border text-[10.5px] leading-snug"
          style={{
            background: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 8%, var(--c-panel))",
            borderColor: "color-mix(in oklab, var(--c-warn, oklch(0.65 0.14 75)) 30%, var(--c-line))",
            color: "var(--c-ink-2)",
          }}
        >
          <div className="font-medium text-[10px] uppercase tracking-[0.06em] mb-1 text-ink-3">
            {t("codegen_form_validation")}
          </div>
          <ul className="m-0 pl-3.5 flex flex-col gap-0.5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={onGenerate}
        disabled={!canGenerate}
        className="h-9 px-3 rounded-md text-[12.5px] font-medium border-0 cursor-pointer w-full"
        style={{
          background: canGenerate ? "var(--c-accent)" : "var(--c-panel)",
          color: canGenerate ? "white" : "var(--c-ink-4)",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? t("codegen_generating") : t("codegen_generate_v2")}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

function ModeSwitcher({
  state,
  setState,
}: {
  state: AgentConfigFormState;
  setState: React.Dispatch<React.SetStateAction<AgentConfigFormState>>;
}) {
  const { t } = useApp();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <ModePill
          label={t("codegen_form_mode_regenerate")}
          icon="🔁"
          active={state.mode === "regenerate"}
          onClick={() => {
            if (state.mode === "regenerate") return;
            setState((s) => ({ ...s, mode: "regenerate" }));
          }}
        />
        <ModePill
          label={t("codegen_form_mode_new")}
          icon="✨"
          active={state.mode === "new"}
          onClick={() => {
            if (state.mode === "new") return;
            setState(() => ({ ...emptyFormState(), mode: "new" }));
          }}
        />
      </div>
      {state.mode === "regenerate" && (
        <select
          value={state.regenerateFromShort ?? ""}
          onChange={(e) => {
            const short = e.target.value;
            if (!short) {
              setState((s) => ({ ...s, regenerateFromShort: null }));
              return;
            }
            const meta = byShort(short);
            if (meta) setState(stateFromAgentMeta(meta));
          }}
          className={inputClass}
        >
          <option value="">{t("codegen_form_pick_agent")}</option>
          {AGENT_MAP.map((m) => (
            <option key={m.short} value={m.short}>
              {m.short} · {m.stage} · {m.ownerTeam}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ModePill({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 h-8 px-2 rounded-md border text-[11.5px] cursor-pointer transition-colors"
      style={{
        background: active ? "var(--c-accent-bg)" : "var(--c-panel)",
        color: active ? "var(--c-accent)" : "var(--c-ink-3)",
        borderColor: active ? "color-mix(in oklab, var(--c-accent) 30%, transparent)" : "var(--c-line)",
        fontWeight: active ? 600 : 400,
      }}
    >
      <span className="mr-1">{icon}</span>
      {label}
    </button>
  );
}

function EmitEventEditor({
  value,
  onChange,
  knownEvents,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  knownEvents: string[];
}) {
  const remaining = React.useMemo(
    () => knownEvents.filter((e) => !value.includes(e)),
    [knownEvents, value],
  );
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((e) => (
            <span
              key={e}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] mono"
              style={{
                background: "var(--c-panel)",
                border: "1px solid var(--c-line)",
                color: "var(--c-ink-2)",
              }}
            >
              {e}
              <button
                onClick={() => onChange(value.filter((x) => x !== e))}
                className="text-ink-4 hover:text-ink-1 border-0 bg-transparent cursor-pointer"
                style={{ padding: 0, lineHeight: 1 }}
                title="remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {remaining.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onChange([...value, e.target.value]);
          }}
          className={inputClass}
        >
          <option value="">+ add emit event…</option>
          {remaining.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 font-medium">
          {title}
        </span>
        {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 font-medium mb-1.5">
      {children}
    </div>
  );
}

const inputClass =
  "h-7 px-2 bg-panel border border-line rounded-md text-[11.5px] text-ink-1 focus:outline-none focus:border-line-strong";
