// Persisted (AI-fillable) tool library: the declarative HTTP spec is run by ONE
// fixed executor (no code-eval), dry-run aware, and round-trips through disk.

import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  runHttpTool, toolFromPersisted, mockFromSchema, saveTool, loadPersistedTools, readPersistedTool,
  toolsLibraryRoot, slugifyTool, type PersistedToolSpec,
} from "./persisted-tools";

const SPEC: PersistedToolSpec = {
  name: "demo.matchScore", title: "匹配评分", description: "demo external API", domain: "Agents-generation",
  sideEffect: "read",
  parameters: { type: "object", properties: { resume: { type: "string" }, jd: { type: "string" } }, required: ["resume", "jd"] },
  returns: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
  requiredEnv: ["DEMO_API_KEY"],
  http: { method: "POST", url: "https://demo.test/match?k=${DEMO_API_KEY}", headers: { authorization: "Bearer ${DEMO_API_KEY}" }, body: { resume: "{resume}", jd: "{jd}" }, responsePath: "data" },
  version: "v1", approved: true, sourceDoc: "upload", createdAt: "2026-06-25T00:00:00Z",
};

describe("runHttpTool — the one fixed executor (no code-eval)", () => {
  it("interpolates {args} + ${ENV} into url/headers/body and extracts responsePath", async () => {
    process.env.DEMO_API_KEY = "secret123";
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ data: { score: 88, reason: "ok" } }) } as Response;
    }) as unknown as typeof fetch;
    const out = await runHttpTool(SPEC.http, { resume: "R", jd: "J" }, { fetch: fakeFetch });
    expect(seen!.url).toBe("https://demo.test/match?k=secret123");       // ${ENV} resolved
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer secret123");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ resume: "R", jd: "J" }); // {args} resolved
    expect(out).toEqual({ score: 88, reason: "ok" });                   // responsePath "data"
  });
  it("throws on non-2xx (so the agent sees the failure)", async () => {
    const f = (async () => ({ ok: false, status: 502, json: async () => ({}) } as Response)) as unknown as typeof fetch;
    await expect(runHttpTool(SPEC.http, { resume: "R", jd: "J" }, { fetch: f })).rejects.toThrow(/502/);
  });
});

describe("toolFromPersisted — dry-run aware ToolDescriptor", () => {
  it("dry-run returns a schema-shaped mock, never hits the network", async () => {
    const tool = toolFromPersisted(SPEC);
    const out = (await tool.execute!({ resume: "R", jd: "J" }, { dryRun: true })) as Record<string, unknown>;
    expect(out.__mock).toBe(true);
    expect(out).toHaveProperty("score");
    expect(out).toHaveProperty("reason");
  });
});

describe("mockFromSchema", () => {
  it("builds a mock matching the schema shape", () => {
    expect(mockFromSchema({ type: "object", properties: { a: { type: "number" }, b: { type: "array", items: { type: "string" } } } }))
      .toEqual({ a: 0, b: ["(mock)"] });
  });
});

describe("persistence round-trip", () => {
  const slug = slugifyTool("demo.roundtrip-tool");
  afterAll(async () => { await fs.rm(path.join(toolsLibraryRoot(), slug), { recursive: true, force: true }); });

  it("save → readPersistedTool → loadPersistedTools(approved filter)", async () => {
    const saved = { ...SPEC, name: "demo.roundtrip-tool" };
    const s = await saveTool(saved);
    expect(s).toBe(slug);
    const back = await readPersistedTool(slug);
    expect(back?.name).toBe("demo.roundtrip-tool");
    const loaded = await loadPersistedTools("Agents-generation");
    expect(loaded.some((t) => t.name === "demo.roundtrip-tool")).toBe(true);
  });

  it("unapproved tools do NOT load (human-approval gate)", async () => {
    const slug2 = slugifyTool("demo.pending-tool");
    await saveTool({ ...SPEC, name: "demo.pending-tool", approved: false });
    const loaded = await loadPersistedTools("Agents-generation"); // onlyApproved defaults true
    expect(loaded.some((t) => t.name === "demo.pending-tool")).toBe(false);
    await fs.rm(path.join(toolsLibraryRoot(), slug2), { recursive: true, force: true });
  });
});
