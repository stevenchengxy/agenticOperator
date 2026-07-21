import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { critique } from "./critic";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BuilderCtx, TargetAgentBrief } from "../types";
import type { PromptWriterResult } from "./prompt-writer";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const registry = resolveRegistry("recruit-gen-v1", ontology);
  return {
    runId: "critic-test",
    domain: "recruit-gen-v1",
    ontology,
    registry,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

const PARSE_BRIEF: TargetAgentBrief = {
  name: "parseResume",
  trigger: ["recruitment/RESUME_RECEIVED"],
  emit: ["recruitment/RESUME_PARSED", "recruitment/RESUME_PARSE_FAILED"],
  objects: ["Resume", "Candidate"],
  ruleRefs: [],
  rationale: "Parse incoming resume and extract candidate data",
};

const MOCK_PROMPT: PromptWriterResult = {
  system: "你是 parseResume agent,负责解析简历。调用 robohire.parseResume 解析简历。返回 {\"decision\":\"recruitment/RESUME_PARSED\",\"reason\":...}。",
  user: "请按步骤处理。",
  source: "ontology",
};

const MOCK_TOOLS = ["robohire.parseResume"];

describe("critique (hermetic, LLM mocked)", () => {
  it("returns the (mocked) critic score and approval", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };

    const result = await critique(ctx, PARSE_BRIEF, MOCK_PROMPT, MOCK_TOOLS, persist);

    // Mocked critic returns score 0.9 with no issues → approved
    expect(result.approved).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);

    // LLM call persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string; target: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("critic");
    expect(row.target).toBe("parseResume");
  });

  it("emits prompt.critique event", async () => {
    const ctx = await hermeticCtx();
    const events: unknown[] = [];
    ctx.emit = (e) => events.push(e);
    const persist = async () => {};

    await critique(ctx, PARSE_BRIEF, MOCK_PROMPT, MOCK_TOOLS, persist);

    const critiqueEvent = events.find((e) => (e as { t: string }).t === "prompt.critique");
    expect(critiqueEvent).toBeTruthy();
    const ev = critiqueEvent as { t: string; name: string; score: number; approved: boolean };
    expect(ev.name).toBe("parseResume");
    expect(ev.approved).toBe(true);
  });
});
