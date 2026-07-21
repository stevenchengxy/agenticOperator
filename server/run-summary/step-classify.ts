// Step outcome classification for run summaries.
//
// WHY this exists — the run-AI-summary used to read any failed step + its raw
// error text and feed it to the LLM, which then reported "候选人规则校验未通过"
// even when the failure was a transient infrastructure hiccup that retried and
// recovered. Two facts make this a systematic misread:
//
//   1. A *business* rule-check FAIL never throws — the step returns the FAIL
//      decision in its output and completes normally. Only an *infrastructure*
//      failure (LLM gateway down, graph unavailable, tool-loop, parse, timeout)
//      throws (see server/inngest/agents/rule-check-agent.ts) → so practically
//      EVERY failed step in a rule-check run is infra, NOT a candidate rejection.
//   2. A step that failed then succeeded on retry shows up in the Inngest trace
//      as status=Completed with attempts>1 — it must read as "重试后成功", not
//      as a failure.
//
// This module is the single place that turns a raw step into one of four
// outcomes so the prompt builder + deterministic fallback describe failures
// honestly (infra-vs-business, recovered-vs-terminal).

import { INFRA_FAIL_REASONS } from "@/lib/rule-check/infra-failure";

export type StepOutcome =
  | "ok" // completed first try (or non-terminal) — nothing to flag
  | "recovered" // completed, but only after >1 attempt (transient blip, recovered)
  | "infra-failed" // terminal failure caused by infrastructure (NOT a candidate result)
  | "business-failed"; // terminal failure that reflects a real business decision

export type StepClassification = {
  outcome: StepOutcome;
  /** Clean, human-readable failure message (decoded from JSON if needed). */
  message: string | null;
  /** Inngest attempt count when known (archive runs); null for native runs. */
  attempts: number | null;
};

/** A step has a real failure when its outcome is terminal-failed. */
export function isTerminalFailure(o: StepOutcome): boolean {
  return o === "infra-failed" || o === "business-failed";
}

// Extract a human message from a step.error that may be a raw string OR a
// JSON-encoded {name,message,stack} object (the Inngest archive stores the
// latter). We never surface the stack — only the message (or name as a
// fallback) so the prompt stays small and readable.
export function extractErrorMessage(
  error: string | null | undefined,
): string | null {
  if (error == null) return null;
  const raw = String(error).trim();
  if (!raw) return null;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as { message?: unknown; name?: unknown };
        if (typeof obj.message === "string" && obj.message.trim()) {
          return obj.message.trim();
        }
        if (typeof obj.name === "string" && obj.name.trim()) {
          return obj.name.trim();
        }
      }
    } catch {
      // Not valid JSON — fall through and return the raw string.
    }
  }
  return raw;
}

// Markers that identify a transient / infrastructure failure (NOT a candidate
// business rejection): the canonical rule-check infra fail_reason tokens, the
// agent's explicit throw text, and generic gateway/network outage phrases.
const INFRA_PHRASES = [
  "infra failure",
  "candidate not rejected",
  "retry", // covers "retrying" / "will retry"
  "gateway",
  "unavailable",
  "timeout",
  "timed out",
  "econnrefused",
  "econnreset",
  "fetch failed",
  "network",
  "503",
  "502",
  "429",
] as const;

export function isInfraFailureMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if ((INFRA_FAIL_REASONS as readonly string[]).some((r) => m.includes(r))) {
    return true;
  }
  return INFRA_PHRASES.some((p) => m.includes(p));
}

function isOkStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s === "completed" || s === "success" || s === "succeeded" || s === "ok"
  );
}

function isFailedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s === "failed" ||
    s === "errored" ||
    s === "error" ||
    s === "cancelled" ||
    s === "canceled" ||
    s === "timed_out"
  );
}

export function classifyStep(step: {
  status: string;
  error?: string | null;
  attempts?: number | null;
}): StepClassification {
  const attempts = step.attempts ?? null;
  const message = extractErrorMessage(step.error);
  const status = step.status ?? "";

  // Succeeded — but flag a retry-then-recovery so the summary doesn't read it
  // as a failure. A clean first-try success carries no message.
  if (isOkStatus(status)) {
    if (attempts != null && attempts > 1) {
      return { outcome: "recovered", message, attempts };
    }
    return { outcome: "ok", message: null, attempts };
  }

  // Terminal failure (explicit failed status, or a non-ok status that carried
  // an error). Infra failures throw and so are the only thing that surfaces as
  // a failed step for rule-check; business decisions complete normally.
  if (isFailedStatus(status) || message) {
    return {
      outcome: isInfraFailureMessage(message) ? "infra-failed" : "business-failed",
      message,
      attempts,
    };
  }

  // running / pending / queued / unknown — nothing to flag yet.
  return { outcome: "ok", message: null, attempts };
}
