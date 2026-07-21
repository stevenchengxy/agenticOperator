import { describe, it, expect } from "vitest";
import {
  extractErrorMessage,
  isInfraFailureMessage,
  classifyStep,
  isTerminalFailure,
} from "./step-classify";

describe("extractErrorMessage", () => {
  it("returns null for null/empty", () => {
    expect(extractErrorMessage(null)).toBeNull();
    expect(extractErrorMessage("")).toBeNull();
    expect(extractErrorMessage("   ")).toBeNull();
  });

  it("returns a plain string unchanged", () => {
    expect(extractErrorMessage("boom")).toBe("boom");
  });

  it("decodes the message field of a JSON {name,message,stack} error (Inngest archive shape)", () => {
    const raw = JSON.stringify({
      name: "Error",
      message: "rule-check infra failure (reason=llm-call-error) — retrying; candidate NOT rejected",
      stack: "Error: ...\n  at ...",
    });
    expect(extractErrorMessage(raw)).toBe(
      "rule-check infra failure (reason=llm-call-error) — retrying; candidate NOT rejected",
    );
  });

  it("falls back to name when message is absent", () => {
    expect(extractErrorMessage(JSON.stringify({ name: "TimeoutError" }))).toBe(
      "TimeoutError",
    );
  });

  it("returns the raw string when it looks like JSON but does not parse", () => {
    expect(extractErrorMessage("{not json")).toBe("{not json");
  });
});

describe("isInfraFailureMessage", () => {
  it("flags canonical rule-check infra fail_reason tokens", () => {
    expect(isInfraFailureMessage("...reason=llm-call-error...")).toBe(true);
    expect(isInfraFailureMessage("ontology-graph-unavailable")).toBe(true);
    expect(isInfraFailureMessage("tool-use-loop-exceeded")).toBe(true);
    expect(isInfraFailureMessage("parse-error in output")).toBe(true);
  });

  it("flags generic gateway/network outage phrases", () => {
    expect(isInfraFailureMessage("LLM gateway unavailable (503)")).toBe(true);
    expect(isInfraFailureMessage("request timed out")).toBe(true);
    expect(isInfraFailureMessage("fetch failed: ECONNREFUSED")).toBe(true);
    expect(isInfraFailureMessage("retrying; candidate NOT rejected")).toBe(true);
  });

  it("does NOT flag a real business failure message", () => {
    expect(isInfraFailureMessage("候选人学历不符合岗位硬性要求")).toBe(false);
    expect(isInfraFailureMessage(null)).toBe(false);
  });
});

describe("classifyStep", () => {
  it("completed first try → ok", () => {
    expect(classifyStep({ status: "completed", attempts: 1 }).outcome).toBe("ok");
    expect(classifyStep({ status: "Completed" }).outcome).toBe("ok");
  });

  it("completed after >1 attempt → recovered (NOT a failure)", () => {
    const c = classifyStep({ status: "Completed", attempts: 2 });
    expect(c.outcome).toBe("recovered");
    expect(c.attempts).toBe(2);
    expect(isTerminalFailure(c.outcome)).toBe(false);
  });

  it("failed step with infra error → infra-failed", () => {
    const c = classifyStep({
      status: "Failed",
      attempts: 2,
      error: JSON.stringify({
        message:
          "[Rule Check Agent] rule-check infra failure (jr=JR1, reason=gateway-unavailable) — retrying; candidate NOT rejected",
      }),
    });
    expect(c.outcome).toBe("infra-failed");
    expect(isTerminalFailure(c.outcome)).toBe(true);
    expect(c.message).toContain("infra failure");
  });

  it("failed step with a business reason → business-failed", () => {
    const c = classifyStep({
      status: "failed",
      error: "候选人不满足岗位硬性规则：学历",
    });
    expect(c.outcome).toBe("business-failed");
    expect(isTerminalFailure(c.outcome)).toBe(true);
  });

  it("running / pending → ok (nothing to flag yet)", () => {
    expect(classifyStep({ status: "running" }).outcome).toBe("ok");
    expect(classifyStep({ status: "pending" }).outcome).toBe("ok");
  });
});
