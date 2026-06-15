import { describe, it, expect } from "vitest";
import { describeLogKind, describeStep } from "./monitor-step-descriptor";

// These helpers translate Inngest step names / file-log `kind` values into
// human labels. Their inputs come from JSONL log lines parsed with an unchecked
// `as AgentLogEvent` cast (app/api/inngest-admin/runs/[runId]/agent-log), so a
// line missing the field yields `undefined` at runtime despite the `string`
// type. They must not crash on that.
describe("describeLogKind", () => {
  it("does not throw on undefined / null / empty (the reported crash)", () => {
    expect(() => describeLogKind(undefined as unknown as string)).not.toThrow();
    expect(() => describeLogKind(null as unknown as string)).not.toThrow();
    expect(() => describeLogKind("")).not.toThrow();
    // returns a non-empty human-readable fallback rather than crashing
    expect(typeof describeLogKind(undefined as unknown as string)).toBe("string");
    expect(describeLogKind(undefined as unknown as string).length).toBeGreaterThan(0);
  });

  it("maps known kinds to their label", () => {
    expect(describeLogKind("handler.start")).toBe("▶ 开始处理");
    expect(describeLogKind("llm.request")).toBe("🧠 大模型入参 (prompt)");
  });

  it("falls back by prefix for unknown kinds", () => {
    expect(describeLogKind("api.RoboHire.parseResume")).toBe(
      "🌐 调用外部面试/解析服务",
    );
    expect(describeLogKind("api.lookup-candidate")).toBe("🔎 查询实例库");
    expect(describeLogKind("pg.write-something")).toBe("💾 数据库操作");
  });

  it("returns the raw kind when nothing matches", () => {
    expect(describeLogKind("totally.unknown.kind")).toBe("totally.unknown.kind");
  });
});

describe("describeStep", () => {
  it("does not throw on undefined / null / empty", () => {
    expect(() => describeStep(undefined as unknown as string)).not.toThrow();
    expect(() => describeStep(null as unknown as string)).not.toThrow();
    expect(() => describeStep("")).not.toThrow();
    expect(typeof describeStep(undefined as unknown as string).label).toBe("string");
  });

  it("still maps known steps", () => {
    expect(describeStep("backfill-resume-abc").label).toBe("回查候选人简历正文");
    expect(describeStep("rule-check-xyz").label).toBe("运行规则检查 (AI)");
  });
});
