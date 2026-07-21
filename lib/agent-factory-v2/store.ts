import { prisma } from "@/server/db";
import type { BuildStore } from "./conductor";
import type { BuildEvent } from "./types";
import type { LlmCallRow } from "./ledger";

/** Prisma-backed BuildStore — the real implementation used by the SSE route. */
export const prismaStore: BuildStore = {
  async createRun(domain: string): Promise<string> {
    const run = await prisma.factoryBuildRun.create({ data: { domain } });
    return run.id;
  },

  async appendEvent(runId: string, seq: number, e: BuildEvent): Promise<void> {
    await prisma.factoryBuildEvent.create({
      data: {
        runId,
        seq,
        type: e.t,
        payload: JSON.stringify(e).slice(0, 200_000),
      },
    });
  },

  async appendLlmCall(row: LlmCallRow): Promise<void> {
    await prisma.factoryLlmCall.create({
      data: {
        runId: row.runId,
        builder: row.builder,
        target: row.target,
        purpose: row.purpose,
        systemPrompt: row.systemPrompt.slice(0, 200_000),
        userPrompt: row.userPrompt.slice(0, 200_000),
        responseText: row.responseText.slice(0, 200_000),
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        latencyMs: row.latencyMs,
        degraded: row.degraded,
      },
    });
  },

  async finishRun(runId: string, status: "done" | "failed", tokensUsed: number): Promise<void> {
    await prisma.factoryBuildRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date(), tokensUsed },
    });
  },
};
