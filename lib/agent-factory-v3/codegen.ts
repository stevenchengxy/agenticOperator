// Agent code generator — render a generated SPEC into a readable Inngest agent
// `.ts` file that mirrors the hand-written agents (server/inngest/agents/*.ts).
//
// Why: the factory produces a declarative spec (prompt + tools + events +
// decision logic) that a generic executor runs. That's great for running, but
// the user wants to SEE + own + edit each agent as real code — like
// match-resume-agent.ts. This renders the spec into that shape:
//   · native imports of the real clients each bound tool wraps (via tool.impl)
//   · the LLM-authored system prompt embedded verbatim
//   · one step.run() per tool, a reasoning step, and emit branches
//
// Honest boundary ("忠实渲染" / faithful render): the tool ARG wiring is
// generic (passes the event payload) because the precise per-client signature
// isn't in the spec — so this is a high-quality, readable scaffold a human can
// finish, not a guaranteed-runnable drop-in. The deployed path still runs the
// spec via the generic executor; this code is the viewable/ownable rendering.

import type { GeneratedAgentSpec, IoField } from "@/lib/agent-factory-gen/types";
import type { ToolRegistry } from "@/lib/tools/registry";

/** PascalCase short name → camelCase export id ("MatchResumeAgent" → "matchResumeAgent"). */
function camel(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : "agent";
}

/** Ontology field type → TS type. */
function tsType(t: string): string {
  const x = (t || "").toLowerCase();
  if (x.startsWith("str")) return "string";
  if (x.startsWith("num") || x === "int" || x === "integer" || x === "float" || x === "double") return "number";
  if (x.startsWith("bool")) return "boolean";
  if (x.startsWith("arr") || x.endsWith("[]")) return "unknown[]";
  if (x.startsWith("obj") || x.startsWith("map") || x.startsWith("json")) return "Record<string, unknown>";
  return "unknown";
}

/** Render an AI-authored IoField[] as a TS interface (empty string if none). */
function ioInterface(name: string, fields: IoField[] | undefined): string {
  if (!fields?.length) return "";
  const lines = fields.map((f) => {
    const key = /^[a-zA-Z_$][\w$]*$/.test(f.field) ? f.field : JSON.stringify(f.field);
    const note = f.description ? ` // ${f.description.replace(/\s+/g, " ").trim()}${f.source ? ` (源: ${f.source})` : ""}` : f.source ? ` // 源: ${f.source}` : "";
    return `  ${key}: ${tsType(f.type)};${note}`;
  });
  return `interface ${name} {\n${lines.join("\n")}\n}`;
}

/**
 * Validate AI-written agent code. Uses the real TS compiler for syntax
 * diagnostics when available; falls back to structural checks. Returns the
 * concrete errors so the LLM can fix them (codegen_agent retry loop).
 */
export async function validateAgentCode(code: string): Promise<{ ok: boolean; errors: string[] }> {
  try {
    const ts = await import("typescript");
    const out = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, isolatedModules: true },
      reportDiagnostics: true,
    });
    const errors = (out.diagnostics ?? [])
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => `${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    return { ok: errors.length === 0, errors };
  } catch {
    // structural fallback (no TS compiler at runtime): balance + anchors
    const errors: string[] = [];
    const count = (s: string) => code.split(s).length - 1;
    if (count("{") !== count("}")) errors.push("花括号 { } 不配对");
    if (count("(") !== count(")")) errors.push("圆括号 ( ) 不配对");
    if (count("`") % 2 !== 0) errors.push("反引号 ` 不配对");
    if (!/inngest\.createFunction/.test(code)) errors.push("缺少 inngest.createFunction(...)");
    if (!/export\s+(const|default)/.test(code)) errors.push("缺少 export const / export default");
    return { ok: errors.length === 0, errors };
  }
}

/** Escape a string for safe embedding inside a `template literal`. */
function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** A step var name from a tool name ("robohire.matchResume" → "matchResumeResult"). */
function stepVar(tool: string): string {
  const tail = tool.includes(".") ? tool.slice(tool.indexOf(".") + 1) : tool;
  return `${tail}Result`;
}

/**
 * Render a runnable-looking Inngest agent .ts file from a generated spec.
 */
export function specToAgentCode(spec: GeneratedAgentSpec, registry: ToolRegistry): string {
  const exportName = camel(spec.short || "agent") + (/(agent)$/i.test(spec.short || "") ? "" : "Agent");
  const tools = spec.tools ?? [];

  // ── imports: group exports by module (one import line per module) ──
  const byModule = new Map<string, Set<string>>();
  const RULE_FETCH = "ontology.fetchActionRules";
  for (const t of tools) {
    const d = registry.get(t);
    if (d?.impl) {
      if (!byModule.has(d.impl.module)) byModule.set(d.impl.module, new Set());
      byModule.get(d.impl.module)!.add(d.impl.export);
    }
  }
  // the reasoning step always calls the LLM gateway's chatComplete
  {
    const m = "@/server/llm/gateway";
    if (!byModule.has(m)) byModule.set(m, new Set());
    byModule.get(m)!.add("chatComplete");
  }
  const importLines = [`import { inngest } from '@/server/inngest/client';`];
  for (const [mod, exps] of [...byModule.entries()].sort()) {
    importLines.push(`import { ${[...exps].sort().join(", ")} } from '${mod}';`);
  }

  // ── per-tool step.run() lines ──
  const stepLines: string[] = [];
  for (const t of tools) {
    const d = registry.get(t);
    const fn = d?.impl?.export;
    if (!fn) continue;
    if (t === RULE_FETCH) {
      stepLines.push(
        `    // 动态抓取本动作的业务规则(实时,不写死) — tool: ${t}`,
        `    const rules = await step.run('fetch-rules', () => ${fn}('${spec.actionName}', '${spec.domainId}'));`,
      );
    } else {
      stepLines.push(
        `    // tool: ${t}`,
        `    const ${stepVar(t)} = await step.run('${(t.split(".").pop() || "step")}', () => ${fn}(input));`,
      );
    }
  }

  // ── reasoning + emit ──
  const emits = spec.emit ?? [];
  const triggers = (spec.trigger ?? []).map((e) => `{ event: '${e}' }`).join(", ");
  let emitBlockArr: string[];
  if (emits.length <= 1) {
    emitBlockArr = [
      `    await step.sendEvent('emit', { name: '${emits[0] ?? "DONE"}', data: { ...input, decision } });`,
    ];
  } else {
    // multi-branch: scaffold from the emit list; the decision logic lives in the
    // authored prompt, so the LLM's `decision` drives which branch fires.
    const [pass, ...rest] = emits;
    const fail = rest[rest.length - 1];
    emitBlockArr = [
      `    // 决策分支(逻辑见 SYSTEM_PROMPT) — decision.pass 由上面的推理给出`,
      `    if (decision.pass) {`,
      `      await step.sendEvent('emit', { name: '${pass}', data: { ...input, decision } });`,
      `    } else {`,
      `      await step.sendEvent('emit', { name: '${fail}', data: { ...input, decision } });`,
      `    }`,
      rest.length > 1
        ? `    // 其它分支: ${rest.slice(0, -1).join(", ")} — 按 SYSTEM_PROMPT 的条件补充`
        : "",
    ].filter(Boolean);
  }

  const header = [
    `// ${spec.nameZh} — generated by the Agent Factory from ontology action \`${spec.actionName}\` (${spec.domainId}).`,
    `// trigger: ${(spec.trigger ?? []).join(" / ") || "(entry)"} → emit: ${emits.join(" | ") || "(terminal)"}`,
    `// NOTE: faithful render of the generated spec. Tool args are passed the event`,
    `// payload generically — review + tighten per client signature before going live.`,
  ].join("\n");

  // AI-authored I/O interfaces (grounded in the DataObjects). Empty when the
  // brain didn't author schemas for this agent.
  const inName = `${spec.short || "Agent"}Input`;
  const outName = `${spec.short || "Agent"}Output`;
  const ifaces = [ioInterface(inName, spec.inputSchema), ioInterface(outName, spec.outputSchema)].filter(Boolean);
  const inputType = spec.inputSchema?.length ? ` as ${inName}` : "";

  return [
    header,
    "",
    importLines.join("\n"),
    "",
    ...(ifaces.length ? [`/** Input/Output schema — authored from the ontology DataObjects. */`, ifaces.join("\n\n"), ""] : []),
    `/** System prompt — authored by the factory's reasoning for THIS agent. */`,
    "const SYSTEM_PROMPT = `" + escapeTemplate(spec.systemPrompt ?? "") + "`;",
    "",
    `export const ${exportName} = inngest.createFunction(`,
    `  {`,
    `    id: '${spec.slug}',`,
    `    name: '${(spec.short || spec.nameZh).replace(/'/g, "\\'")}',`,
    `    retries: ${spec.retries ?? 1},`,
    `    triggers: [${triggers}],`,
    `  },`,
    `  async ({ event, step }) => {`,
    `    const input = event.data${inputType};`,
    ...stepLines,
    `    // 用本 agent 专属的 system prompt 推理(决策核心)`,
    `    const decision = await step.run('reason', () =>`,
    `      chatComplete({ system: SYSTEM_PROMPT, user: JSON.stringify(input) }));`,
    ...emitBlockArr,
    `    return { ok: true };`,
    `  },`,
    `);`,
    "",
  ].join("\n");
}
