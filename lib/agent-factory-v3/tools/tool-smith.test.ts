// Tool-Smith + Doc-Fetcher: the AI-builds-tools capability. Deterministic coverage of
// the SSRF guard + create_tool validation/persistence (no LLM, no real network).

import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetch_doc, create_tool } from "./tool-smith";
import { ToolRegistry } from "@/lib/tools/registry";
import { toolsLibraryRoot, slugifyTool, readPersistedTool } from "@/lib/tools/persisted-tools";
import type { BrainCtx } from "../brain/types";

function ctx(registry = new ToolRegistry()): { ctx: BrainCtx; events: unknown[] } {
  const events: unknown[] = [];
  return { ctx: { domain: "Agents-generation", emit: (e: unknown) => events.push(e), registry } as unknown as BrainCtx, events };
}

describe("fetch_doc — SSRF guard + scheme check", () => {
  it("rejects loopback / private hosts WITHOUT fetching", async () => {
    for (const url of ["http://localhost:8288/x", "http://127.0.0.1/y", "http://10.0.0.5/z", "http://169.254.169.254/meta"]) {
      const r = await fetch_doc.execute({ reasoning: "x", url }, ctx().ctx);
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/SSRF|内网|本机/);
    }
  });
  it("rejects non-http(s) schemes", async () => {
    const r = await fetch_doc.execute({ reasoning: "x", url: "file:///etc/passwd" }, ctx().ctx);
    expect(r.ok).toBe(false);
  });
});

describe("create_tool — validation + declarative persistence", () => {
  const slug = slugifyTool("demo.smithMade");
  afterAll(async () => { await fs.rm(path.join(toolsLibraryRoot(), slug), { recursive: true, force: true }); });

  it("rejects a name without a namespace + an http spec without method/url", async () => {
    expect((await create_tool.execute({ reasoning: "x", name: "noNamespace", http: { method: "GET", url: "https://x" }, parameters: {}, returns: {}, description: "d" }, ctx().ctx)).ok).toBe(false);
    expect((await create_tool.execute({ reasoning: "x", name: "ns.ok", http: {}, parameters: {}, returns: {}, description: "d" }, ctx().ctx)).ok).toBe(false);
  });

  it("saves a declarative tool (unapproved) + registers it into THIS run's registry + emits tool.created", async () => {
    const { ctx: c, events } = ctx();
    const r = await create_tool.execute({
      reasoning: "造一个匹配工具", name: "demo.smithMade", title: "匹配", description: "demo",
      sideEffect: "read", parameters: { type: "object", properties: { q: { type: "string" } } }, returns: { type: "object", properties: { score: { type: "number" } } },
      requiredEnv: ["DEMO_KEY"], http: { method: "POST", url: "https://demo.test/match", headers: { authorization: "Bearer ${DEMO_KEY}" }, body: { q: "{q}" }, responsePath: "data" },
      sourceDoc: "https://demo.test/docs",
    }, c);
    expect(r.ok).toBe(true);
    // persisted UNAPPROVED (human gate for global use)
    const saved = await readPersistedTool(slug);
    expect(saved?.approved).toBe(false);
    expect(saved?.http.method).toBe("POST");
    // usable THIS run: registered into the live registry
    expect(c.registry!.has("demo.smithMade")).toBe(true);
    // surfaced to the UI
    expect(events.some((e) => (e as { t: string }).t === "tool.created")).toBe(true);
  });
});
