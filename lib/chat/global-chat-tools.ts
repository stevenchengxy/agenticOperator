// Read-only tool layer for the global tracing chatbot.
//
// Each tool is { name, schema, execute }. The schema is the OpenAI
// tool-format definition exposed to the LLM. execute() takes the LLM-supplied
// args and returns { result, sources? }. Tools are READ-ONLY by contract —
// any future write operation should NOT be added here; it belongs in the
// Manage axis.
//
// Schema notes (adapted from real prisma/schema.prisma):
// - WorkflowRun: no agentName / durationMs / eventName / error fields;
//   triggerEvent is the trigger field; durationMs is computed from startedAt + completedAt.
// - WorkflowStep: field is stepName (not name); no idx field.
// - AgentEpisode: no stepIdx; tokenUsage stored as JSON string.
// - EventInstance: timestamp field is `ts` (not emittedAt); payload stored as
//   payloadSummary (truncated JSON string). SQLite: no JSON path queries.
// - RuleCheckAudit: all fields are snake_case (audit_id, client_name, etc.).

import { prisma } from "@/server/db";
import { searchEntitiesNeo4j } from "@/lib/allmeta-client";
import type { ToolDef, ChatSource } from "./types";

// ---------- helpers ----------

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function resolveSince(since: unknown): Date | undefined {
  if (typeof since !== "string") return undefined;
  // relative form: "-24h" / "-7d"
  const m = since.match(/^-(\d+)([hd])$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const dt = new Date(since);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// ---------- 1. searchRuns ----------
// WorkflowRun fields: id, triggerEvent, status, startedAt, completedAt,
//   lastActivityAt, suspendedReason. No agentName/durationMs/error/eventName.

const searchRuns: ToolDef = {
  name: "searchRuns",
  schema: {
    type: "function",
    function: {
      name: "searchRuns",
      description:
        "List Inngest workflow runs. Filter by status, time window, or trigger event name. Returns run id + status + timing.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Canonical agent short name (e.g. 'JDGenerator', 'Matcher'). Joins via AgentEpisode.agentName.",
          },
          status: {
            type: "string",
            description: "running | suspended | timed_out | completed | failed | paused | interrupted",
          },
          since: {
            type: "string",
            description: "ISO timestamp or relative like '-24h' / '-7d'",
          },
          eventName: {
            type: "string",
            description: "Exact trigger event name to filter by",
          },
          limit: { type: "number", description: "Max rows (default 20, max 50)" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const since = resolveSince(i.since);

    // Agent filter: WorkflowRun has no agentName. Find run IDs via AgentEpisode.agentName.
    const where: Record<string, unknown> = {};
    if (typeof i.agent === "string" && i.agent.trim().length > 0) {
      const episodes = await prisma.agentEpisode.findMany({
        where: { agentName: i.agent },
        select: { runId: true },
        distinct: ["runId"],
        take: 200, // upper bound; matches realistic run volume per agent
      });
      const runIds = episodes.map((e) => e.runId).filter((x): x is string => !!x);
      if (runIds.length === 0) {
        // No runs for this agent → return empty without doing a runs query
        return {
          result: { runs: [], total: 0 },
          sources: [],
        };
      }
      where.id = { in: runIds };
    }

    if (typeof i.status === "string") where.status = i.status;
    if (typeof i.eventName === "string") where.triggerEvent = i.eventName;
    if (since) where.startedAt = { gte: since };

    const runs = await prisma.workflowRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take,
    });

    // If asking for failed runs, fetch their first failed step's error message in one query
    let errorByRunId: Map<string, string> = new Map();
    if (i.status === "failed" && runs.length > 0) {
      const failedSteps = await prisma.workflowStep.findMany({
        where: { runId: { in: runs.map((r) => r.id) }, status: "failed" },
        select: { runId: true, error: true, startedAt: true },
        orderBy: { startedAt: "asc" },
      });
      for (const s of failedSteps) {
        if (!errorByRunId.has(s.runId) && s.error) errorByRunId.set(s.runId, s.error);
      }
    }

    const sources: ChatSource[] = runs.slice(0, 5).map((r) => ({
      tool: "searchRuns",
      label: `${r.triggerEvent} · ${r.status}`,
      ref: r.id,
      url: `/monitor?run=${encodeURIComponent(r.id)}`,
    }));
    return {
      result: {
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          triggerEvent: r.triggerEvent,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          durationMs:
            r.completedAt
              ? r.completedAt.getTime() - r.startedAt.getTime()
              : null,
          error: errorByRunId.get(r.id),
        })),
        total: runs.length,
      },
      sources,
    };
  },
};

// ---------- 2. getRunDetail ----------
// WorkflowStep fields: id, runId, nodeId, stepName, status, durationMs, error.
// AgentEpisode fields: id, agentName, runId, modelUsed, tokenUsage (JSON string), durationMs.

const getRunDetail: ToolDef = {
  name: "getRunDetail",
  schema: {
    type: "function",
    function: {
      name: "getRunDetail",
      description:
        "Get one workflow run with its steps (WorkflowStep) and agent episodes (AgentEpisode / LLM token usage).",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "WorkflowRun id" },
        },
        required: ["runId"],
      },
    },
  },
  execute: async (input) => {
    const runId = String((input as Record<string, unknown>)?.runId ?? "");
    if (!runId) {
      return {
        result: { run: null, steps: [], episodes: [] },
      };
    }
    const [runs, steps, episodes] = await Promise.all([
      prisma.workflowRun.findMany({ where: { id: runId }, take: 1 }),
      prisma.workflowStep.findMany({ where: { runId }, orderBy: { startedAt: "asc" } }),
      prisma.agentEpisode.findMany({ where: { runId } }),
    ]);
    const run = runs[0] ?? null;
    return {
      result: {
        run: run
          ? {
              id: run.id,
              status: run.status,
              triggerEvent: run.triggerEvent,
              startedAt: run.startedAt.toISOString(),
              completedAt: run.completedAt?.toISOString() ?? null,
              durationMs:
                run.completedAt
                  ? run.completedAt.getTime() - run.startedAt.getTime()
                  : null,
            }
          : null,
        steps: steps.map((s) => ({
          id: s.id,
          nodeId: s.nodeId,
          stepName: s.stepName,
          status: s.status,
          durationMs: s.durationMs ?? null,
          error: s.error ?? null,
        })),
        episodes: episodes.map((e) => {
          let tokenUsage: unknown = null;
          if (e.tokenUsage) {
            try { tokenUsage = JSON.parse(e.tokenUsage); } catch { tokenUsage = null; }
          }
          return {
            id: e.id,
            agentName: e.agentName,
            modelUsed: e.modelUsed ?? null,
            tokenUsage,
            durationMs: e.durationMs,
          };
        }),
      },
      sources: run
        ? [
            {
              tool: "getRunDetail",
              label: `run ${run.id.slice(0, 8)}`,
              ref: run.id,
              url: `/monitor?run=${encodeURIComponent(run.id)}`,
            },
          ]
        : [],
    };
  },
};

// ---------- 3. searchEvents ----------
// EventInstance fields: id, name, source, status, ts (DateTime), payloadSummary.
// NOTE: SQLite/Prisma has no JSON path queries; payloadSummary is a truncated
// JSON string — payloadContains filter does string contains on payloadSummary.

const searchEvents: ToolDef = {
  name: "searchEvents",
  schema: {
    type: "function",
    function: {
      name: "searchEvents",
      description:
        "Search EventInstance log. Supports name wildcards ('MATCH_*') and time window. Returns event id + name + ts + payload snippet.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Event name; supports trailing wildcard 'MATCH_*'",
          },
          since: { type: "string", description: "ISO or '-24h' / '-7d'" },
          limit: { type: "number", description: "Default 30, max 100" },
          payloadContains: {
            type: "object",
            description: "Best-effort string search in payloadSummary",
            properties: {
              jrId: { type: "string" },
              candidateId: { type: "string" },
              clientId: { type: "string" },
              uploadId: { type: "string" },
            },
          },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 100, 30);
    const since = resolveSince(i.since);
    const where: Record<string, unknown> = {};
    if (typeof i.name === "string") {
      if (i.name.endsWith("*")) {
        where.name = { startsWith: i.name.slice(0, -1) };
      } else {
        where.name = i.name;
      }
    }
    if (since) where.ts = { gte: since };
    // payloadContains: search in payloadSummary string (SQLite-safe)
    const pc = i.payloadContains as Record<string, string> | undefined;
    if (pc) {
      const searchVal =
        pc.uploadId ?? pc.candidateId ?? pc.jrId ?? pc.clientId ?? null;
      if (searchVal) {
        where.payloadSummary = { contains: searchVal };
      }
    }
    const rows = await prisma.eventInstance.findMany({
      where,
      orderBy: { ts: "desc" },
      take,
    });
    return {
      result: {
        events: rows.map((r) => ({
          id: r.id,
          name: r.name,
          source: r.source,
          status: r.status,
          ts: r.ts.toISOString(),
          payloadSummary: r.payloadSummary ?? null,
        })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({
        tool: "searchEvents",
        label: `${r.name} ${r.id.slice(0, 6)}`,
        ref: r.id,
        url: `/events?id=${encodeURIComponent(r.id)}`,
      })),
    };
  },
};

// ---------- 4. searchAudits ----------
// RuleCheckAudit fields: all snake_case — audit_id, decision, client_name,
//   job_requisition_id, candidate_id, failure_reasons (JSON string), rules_evaluated,
//   created_at (mapped from DateTime field).

const searchAudits: ToolDef = {
  name: "searchAudits",
  schema: {
    type: "function",
    function: {
      name: "searchAudits",
      description:
        "Search RuleCheckAudit table. Filter by decision, ruleId, client, JR id, candidate id, or time window.",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", description: "PASS | FAIL" },
          ruleId: {
            type: "string",
            description: "Rule id substring to match in failure_reasons JSON",
          },
          client: { type: "string", description: "client_name exact match" },
          jrId: { type: "string", description: "job_requisition_id exact match" },
          candidateId: { type: "string", description: "candidate_id exact match" },
          since: { type: "string", description: "ISO or '-24h'" },
          limit: { type: "number", description: "Default 20, max 50" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const since = resolveSince(i.since);
    // RuleCheckAudit uses snake_case field names in Prisma
    const where: Record<string, unknown> = {};
    if (typeof i.decision === "string") where.decision = i.decision;
    if (typeof i.client === "string") where.client_name = i.client;
    if (typeof i.jrId === "string") where.job_requisition_id = i.jrId;
    if (typeof i.candidateId === "string") where.candidate_id = i.candidateId;
    if (since) where.created_at = { gte: since };
    // ruleId: SQLite-safe string contains in failure_reasons JSON string
    if (typeof i.ruleId === "string") {
      where.failure_reasons = { contains: i.ruleId };
    }
    const rows = await prisma.ruleCheckAudit.findMany({
      where,
      orderBy: { created_at: "desc" },
      take,
    });
    return {
      result: {
        audits: rows.map((r) => ({
          audit_id: r.audit_id,
          decision: r.decision,
          client_name: r.client_name ?? null,
          job_requisition_id: r.job_requisition_id,
          candidate_id: r.candidate_id,
          rules_evaluated: r.rules_evaluated,
          failure_reasons: r.failure_reasons,
          created_at: r.created_at.toISOString(),
        })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({
        tool: "searchAudits",
        label: `${r.decision} · ${r.client_name ?? "?"}`,
        ref: r.audit_id,
        url: `/rule-check?view=audits&auditId=${encodeURIComponent(r.audit_id)}`,
      })),
    };
  },
};

// ---------- 5. searchEntities ----------
// Uses lib/allmeta-client.searchEntitiesNeo4j (thin helper added for this tool).

const searchEntities: ToolDef = {
  name: "searchEntities",
  schema: {
    type: "function",
    function: {
      name: "searchEntities",
      description:
        "Free-text search over Neo4j ontology entities (candidate / jd / requisition / client). Matches name / id / aliases.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "candidate | jd | requisition | client",
          },
          q: { type: "string", description: "Free-text query" },
          limit: { type: "number", description: "Default 10, max 30" },
        },
        required: ["type", "q"],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const type = String(i.type ?? "");
    const q = String(i.q ?? "");
    const take = clamp(i.limit, 1, 30, 10);
    const rows = await searchEntitiesNeo4j({ type, q, limit: take }).catch(
      () => [],
    );
    return {
      result: {
        entities: rows.map((r) => ({
          id: r.id,
          type,
          displayName: r.displayName,
          url: `/entities/${type}/${encodeURIComponent(r.id)}`,
        })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({
        tool: "searchEntities",
        label: `${type} ${r.displayName}`,
        ref: r.id,
        url: `/entities/${type}/${encodeURIComponent(r.id)}`,
      })),
    };
  },
};

// ---------- 6. searchDLQ ----------
// Calls GET /api/inngest-admin/dlq (internal HTTP). Read-only.

const searchDLQ: ToolDef = {
  name: "searchDLQ",
  schema: {
    type: "function",
    function: {
      name: "searchDLQ",
      description:
        "List failed/cancelled Inngest runs from the dead-letter queue via /api/inngest-admin/dlq.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "ISO or '-24h'" },
          limit: { type: "number", description: "Default 20, max 50" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const base =
      process.env.AO_INTERNAL_BASE_URL ?? "http://localhost:3002";
    let res: Response;
    try {
      res = await fetch(`${base}/api/inngest-admin/dlq`);
    } catch (e) {
      return { result: { items: [], total: 0, error: "DLQ endpoint unreachable" }, sources: [] };
    }
    if (!res.ok) return { result: { items: [], total: 0, error: `DLQ endpoint returned ${res.status}` }, sources: [] };
    const body = await res.json();
    const items = ((body.dlq ?? []) as unknown[]).slice(0, take);
    return {
      result: { items, total: items.length },
      sources: items.slice(0, 3).map((d) => {
        const entry = d as Record<string, unknown>;
        const fn = entry.function as Record<string, unknown> | undefined;
        return {
          tool: "searchDLQ",
          label: `${fn?.slug ?? "?"} · ${entry.status ?? "?"}`,
          ref: String(entry.id ?? ""),
          url: `/monitor?tab=dlq`,
        };
      }),
    };
  },
};

// ---------- 7. getEventChain ----------
// EventInstance: uses `ts` (not emittedAt). payloadSummary is a JSON snippet
// string — used for string-contains anchor matching (SQLite-safe).
// Note: JSON path queries (payload.path) are NOT available in SQLite Prisma.

const getEventChain: ToolDef = {
  name: "getEventChain",
  schema: {
    type: "function",
    function: {
      name: "getEventChain",
      description:
        "Build a causal chain of events for a given anchor (candidate id / jrId / uploadId / eventId). Returns chronological event list sorted by ts.",
      parameters: {
        type: "object",
        properties: {
          anchor: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "candidate | jrId | uploadId | eventId",
              },
              value: {
                type: "string",
                description: "Entity id for substring match against payloadSummary (best-effort; short ids like '001' may produce false positives)",
              },
            },
            required: ["type", "value"],
          },
          windowHours: { type: "number", description: "Default 24, max 168" },
        },
        required: ["anchor"],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const anchor = i.anchor as { type?: string; value?: string } | undefined;
    if (!anchor?.type || !anchor.value) return { result: { chain: [] } };
    const windowMs = clamp(i.windowHours, 1, 168, 24) * 3_600_000;
    const since = new Date(Date.now() - windowMs);

    // Build where clause — SQLite/Prisma: no JSON path queries.
    // For candidate/jrId/uploadId anchors, use string contains on payloadSummary.
    // For eventId, use exact id match.
    let where: Record<string, unknown>;
    switch (anchor.type) {
      case "candidate":
        where = { payloadSummary: { contains: anchor.value }, ts: { gte: since } };
        break;
      case "jrId":
        where = { payloadSummary: { contains: anchor.value }, ts: { gte: since } };
        break;
      case "uploadId":
        where = { payloadSummary: { contains: anchor.value }, ts: { gte: since } };
        break;
      case "eventId":
        where = { id: anchor.value };
        break;
      default:
        return { result: { chain: [] } };
    }

    const events = await prisma.eventInstance.findMany({
      where,
      orderBy: { ts: "asc" },
      take: 50,
    });

    const chain = events.map((e) => ({
      timestamp: e.ts.toISOString(),
      kind: "event" as const,
      name: e.name,
      summary: e.name,
      refId: e.id,
      url: `/events?id=${encodeURIComponent(e.id)}`,
    }));

    return {
      result: { chain },
      sources: chain.slice(0, 5).map((c) => ({
        tool: "getEventChain",
        label: c.name,
        ref: c.refId,
        url: c.url,
      })),
    };
  },
};

// ---------- Export the registry ----------

export const TOOLS: ToolDef[] = [
  searchRuns,
  getRunDetail,
  searchEvents,
  searchAudits,
  searchEntities,
  searchDLQ,
  getEventChain,
];

export const TOOL_SCHEMAS = TOOLS.map((t) => t.schema);

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
