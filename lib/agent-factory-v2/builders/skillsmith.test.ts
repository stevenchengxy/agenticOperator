import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { buildSkills } from "./skillsmith";
import type { BuilderCtx } from "../types";
import type { PersistLlmCall } from "../ledger";
import type { DomainOntology } from "@/lib/ontology-generator/ontology-source";

/** Minimal BuilderCtx for hermetic tests (no gateway, no registry). */
function makeCtx(): BuilderCtx & { emitted: unknown[] } {
  const emitted: unknown[] = [];
  const ontology: DomainOntology = {
    domainId: "test",
    source: "snapshot",
    actions: [],
    events: [],
    rules: [],
    objects: [],
    workflow: [],
  };
  return {
    runId: "run-test",
    domain: "test",
    ontology,
    registry: undefined,
    emit: (e) => emitted.push(e),
    budget: { maxTokens: 100_000, maxLlmCalls: 100 },
    spent: { tokens: 0, calls: 0 },
    emitted,
  };
}

const noop: PersistLlmCall = async () => {};

describe("buildSkills (hermetic, LLM mocked)", () => {
  it("preserves brief name in returned SkillSpec[]", async () => {
    const ctx = makeCtx();
    const briefs = [{ name: "简历去重", purpose: "检测并合并重复的候选人简历记录" }];

    const skills = await buildSkills(ctx, briefs, noop);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("简历去重");
  });

  it("builds a SkillSpec per brief from the (mocked) LLM", async () => {
    const ctx = makeCtx();
    const briefs = [
      { name: "资质核验", purpose: "验证候选人学历和资质的真实性" },
      { name: "岗位匹配", purpose: "计算候选人与岗位的匹配度分数" },
    ];

    const skills = await buildSkills(ctx, briefs, noop);

    expect(skills).toHaveLength(2);
    // Real (mocked) LLM authors a non-empty promptFragment.
    expect(skills[0].promptFragment.length).toBeGreaterThan(0);
    expect(skills[1].promptFragment.length).toBeGreaterThan(0);
    // Mock proposes no tools; this ctx has an empty registry anyway.
    expect(skills[0].tools).toEqual([]);
    expect(skills[1].tools).toEqual([]);
  });

  it("emits skill.built event for each brief", async () => {
    const ctx = makeCtx();
    const briefs = [
      { name: "简历去重", purpose: "检测并合并重复的候选人简历记录" },
      { name: "岗位匹配", purpose: "计算候选人与岗位的匹配度分数" },
    ];

    await buildSkills(ctx, briefs, noop);

    const skillBuiltEvents = ctx.emitted.filter(
      (e): e is { t: "skill.built"; name: string; tools: string[] } =>
        typeof e === "object" && e !== null && (e as { t: string }).t === "skill.built",
    );
    expect(skillBuiltEvents).toHaveLength(2);
    expect(skillBuiltEvents[0].name).toBe("简历去重");
    expect(skillBuiltEvents[1].name).toBe("岗位匹配");
  });

  it("returns empty array when briefs is empty", async () => {
    const ctx = makeCtx();
    const skills = await buildSkills(ctx, [], noop);
    expect(skills).toEqual([]);
  });

  it("returns SkillSpec with all required fields", async () => {
    const ctx = makeCtx();
    const briefs = [{ name: "技能名称", purpose: "技能目的描述" }];

    const skills = await buildSkills(ctx, briefs, noop);

    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(typeof skill.name).toBe("string");
    expect(typeof skill.purpose).toBe("string");
    expect(typeof skill.promptFragment).toBe("string");
    expect(Array.isArray(skill.tools)).toBe(true);
    expect(typeof skill.decisionRule).toBe("string");
  });
});
