import { NextResponse } from "next/server";

import {
  controlManagedProcess,
  getManagedProcessSnapshot,
  isManagedProcessId,
  isProcessControlEnabled,
  managedProcessIds,
  type ManagedProcessAction,
  type ManagedProcessId,
  type ManagedProcessStatus,
  type ProcessControlResult,
} from "@/server/ops/process-control";
import { applyRuntimeConfigToEnv } from "@/server/ops/runtime-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type SystemProcessesResponse = {
  ok: true;
  enabled: boolean;
  processes: ManagedProcessStatus[];
  generatedAt: string;
};

export type SystemProcessesActionResponse =
  | {
      ok: true;
      enabled: true;
      results: ProcessControlResult[];
      processes: ManagedProcessStatus[];
      generatedAt: string;
    }
  | {
      ok: false;
      enabled: boolean;
      error: string;
      processes?: ManagedProcessStatus[];
      generatedAt: string;
    };

export async function GET(): Promise<Response> {
  await applyRuntimeConfigToEnv();
  const snapshot = await getManagedProcessSnapshot();
  return NextResponse.json<SystemProcessesResponse>({ ok: true, ...snapshot });
}

export async function POST(req: Request): Promise<Response> {
  await applyRuntimeConfigToEnv();
  const generatedAt = new Date().toISOString();
  if (!isProcessControlEnabled()) {
    const snapshot = await getManagedProcessSnapshot();
    return NextResponse.json<SystemProcessesActionResponse>(
      {
        ok: false,
        enabled: false,
        error: "PROCESS_CONTROL_DISABLED",
        processes: snapshot.processes,
        generatedAt,
      },
      { status: 403 },
    );
  }

  let payload: { action?: unknown; process?: unknown };
  try {
    payload = (await req.json()) as { action?: unknown; process?: unknown };
  } catch {
    return NextResponse.json<SystemProcessesActionResponse>(
      { ok: false, enabled: true, error: "INVALID_JSON", generatedAt },
      { status: 400 },
    );
  }

  const action = payload.action === "restart" ? "restart" : payload.action === "start" ? "start" : null;
  if (!action) {
    return NextResponse.json<SystemProcessesActionResponse>(
      { ok: false, enabled: true, error: "INVALID_ACTION", generatedAt },
      { status: 400 },
    );
  }

  const target = payload.process;
  const ids: ManagedProcessId[] =
    target === "all"
      ? managedProcessIds()
      : isManagedProcessId(target)
        ? [target]
        : [];

  if (ids.length === 0) {
    return NextResponse.json<SystemProcessesActionResponse>(
      { ok: false, enabled: true, error: "INVALID_PROCESS", generatedAt },
      { status: 400 },
    );
  }

  const results: ProcessControlResult[] = [];
  for (const id of ids) {
    try {
      results.push(await controlManagedProcess(id, action as ManagedProcessAction));
    } catch (e) {
      const snapshot = await getManagedProcessSnapshot();
      const fallback = snapshot.processes.find((p) => p.id === id);
      results.push({
        id,
        action: action as ManagedProcessAction,
        ok: false,
        message: (e as Error).message,
        status: fallback ?? {
          id,
          label: id,
          description: "",
          state: "unavailable",
          pids: [],
          logFile: "",
          available: false,
          unavailableReason: (e as Error).message,
          health: {
            state: "unknown",
            message: "process status unavailable",
            endpoint: null,
            latencyMs: null,
            checkedAt: null,
          },
          details: [],
        },
      });
    }
  }

  const snapshot = await getManagedProcessSnapshot();
  return NextResponse.json<SystemProcessesActionResponse>({
    ok: true,
    enabled: true,
    results,
    processes: snapshot.processes,
    generatedAt: snapshot.generatedAt,
  });
}
