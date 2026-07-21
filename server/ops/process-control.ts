import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { getInngestUrl } from "@/lib/inngest-url";

const execFileAsync = promisify(execFile);

export type ManagedProcessId = "inngest" | "archiver" | "monitor-sweeper";
export type ManagedProcessState = "running" | "stopped" | "unavailable";
export type ManagedProcessAction = "start" | "restart";
export type ManagedProcessHealthState = "healthy" | "unhealthy" | "unknown";

export type ManagedProcessHealth = {
  state: ManagedProcessHealthState;
  message: string;
  endpoint: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
};

export type ManagedProcessDetail = {
  label: string;
  value: string;
};

export type ManagedProcessStatus = {
  id: ManagedProcessId;
  label: string;
  description: string;
  state: ManagedProcessState;
  pids: number[];
  logFile: string;
  available: boolean;
  unavailableReason: string | null;
  health: ManagedProcessHealth;
  details: ManagedProcessDetail[];
};

export type ProcessControlResult = {
  id: ManagedProcessId;
  action: ManagedProcessAction;
  ok: boolean;
  message: string;
  status: ManagedProcessStatus;
};

type ProcRow = {
  pid: number;
  stat: string;
  command: string;
};

type ProcessDef = {
  id: ManagedProcessId;
  label: string;
  description: string;
  logFile: string;
  available: () => { ok: true } | { ok: false; reason: string };
  matches: (command: string, root: string) => boolean;
  start: (root: string) => void;
  details?: (root: string) => ManagedProcessDetail[];
  probe?: (status: ManagedProcessStatus) => Promise<ManagedProcessHealth>;
};

const PROCESS_IDS: ManagedProcessId[] = ["inngest", "archiver", "monitor-sweeper"];

export function isProcessControlEnabled(): boolean {
  return process.env.AO_PROCESS_CONTROL === "1" || process.env.NODE_ENV !== "production";
}

export async function getManagedProcessSnapshot(): Promise<{
  enabled: boolean;
  processes: ManagedProcessStatus[];
  generatedAt: string;
}> {
  const root = process.cwd();
  const rows = await readProcessRows();
  const defs = makeDefs(root);
  return {
    enabled: isProcessControlEnabled(),
    processes: await Promise.all(PROCESS_IDS.map((id) => enrichStatus(defs[id], statusFor(defs[id], rows, root)))),
    generatedAt: new Date().toISOString(),
  };
}

export async function controlManagedProcess(
  id: ManagedProcessId,
  action: ManagedProcessAction,
): Promise<ProcessControlResult> {
  const root = process.cwd();
  const defs = makeDefs(root);
  const def = defs[id];
  const availability = def.available();
  if (!availability.ok) {
    const status = await enrichStatus(def, statusFor(def, await readProcessRows(), root));
    return {
      id,
      action,
      ok: false,
      message: availability.reason,
      status,
    };
  }

  if (action === "restart") {
    const before = statusFor(def, await readProcessRows(), root);
    if (before.pids.length > 0) {
      await terminatePids(before.pids, "SIGTERM");
      const stopped = await waitForStop(def, root, 2_500);
      if (!stopped) {
        await terminatePids(before.pids, "SIGKILL");
        await waitForStop(def, root, 1_500);
      }
    }
  }

  const current = statusFor(def, await readProcessRows(), root);
  if (action === "restart" && current.pids.length > 0) {
    return {
      id,
      action,
      ok: false,
      message: "previous process did not stop",
      status: await enrichStatus(def, current),
    };
  }
  if (current.pids.length === 0) {
    def.start(root);
    await sleep(id === "inngest" ? 1_400 : 800);
  }

  const status = await enrichStatus(def, statusFor(def, await readProcessRows(), root));
  const processRunning = status.pids.length > 0;
  const ok = processRunning && status.health.state !== "unhealthy";
  return {
    id,
    action,
    ok,
    message: ok
      ? status.health.state === "healthy"
        ? "process running and healthy"
        : "process running"
      : processRunning
        ? `process unhealthy: ${status.health.message}`
        : "process did not start",
    status,
  };
}

export function isManagedProcessId(value: unknown): value is ManagedProcessId {
  return typeof value === "string" && PROCESS_IDS.includes(value as ManagedProcessId);
}

export function managedProcessIds(): ManagedProcessId[] {
  return [...PROCESS_IDS];
}

function makeDefs(root: string): Record<ManagedProcessId, ProcessDef> {
  return {
    inngest: {
      id: "inngest",
      label: "Inngest",
      description: "Local Inngest event engine on the configured INNGEST_BASE_URL.",
      logFile: "logs/inngest.log",
      available: () => {
        const base = getInngestUrl();
        if (!isLocalUrl(base)) return { ok: false, reason: `INNGEST_BASE_URL is not local: ${base}` };
        if (!existsSync(resolve(root, "node_modules/.bin/inngest-cli"))) {
          return { ok: false, reason: "node_modules/.bin/inngest-cli was not found" };
        }
        return { ok: true };
      },
      matches: (command, cwd) => (
        command.includes(cwd) &&
        command.includes("inngest") &&
        command.includes(" dev") &&
        command.includes(`-p ${inngestPort()}`)
      ),
      start: startInngest,
      details: () => [
        { label: "URL", value: getInngestUrl() },
        { label: "Port", value: String(inngestPort()) },
      ],
      probe: probeInngest,
    },
    archiver: {
      id: "archiver",
      label: "Inngest Archiver",
      description: "Polls Inngest and mirrors events, runs, and steps into Postgres.",
      logFile: "logs/inngest-archiver.log",
      available: () => {
        if (!existsSync(resolve(root, "scripts/inngest-archiver.ts"))) {
          return { ok: false, reason: "scripts/inngest-archiver.ts was not found" };
        }
        if (!existsSync(resolve(root, "node_modules/.bin/tsx"))) {
          return { ok: false, reason: "node_modules/.bin/tsx was not found" };
        }
        return { ok: true };
      },
      matches: (command, cwd) => command.includes(cwd) && command.includes("scripts/inngest-archiver.ts"),
      start: (cwd) => startTsxWorker(cwd, "scripts/inngest-archiver.ts", "logs/inngest-archiver.log"),
      details: () => [{ label: "Mode", value: process.env.MONITOR_READ_SOURCE || "auto" }],
    },
    "monitor-sweeper": {
      id: "monitor-sweeper",
      label: "Monitor Sweeper",
      description: "Runs deterministic health, SLA, cost, and error monitors off-Inngest.",
      logFile: "logs/monitor-sweeper.log",
      available: () => {
        if (!existsSync(resolve(root, "scripts/monitor-sweeper.ts"))) {
          return { ok: false, reason: "scripts/monitor-sweeper.ts was not found" };
        }
        if (!existsSync(resolve(root, "node_modules/.bin/tsx"))) {
          return { ok: false, reason: "node_modules/.bin/tsx was not found" };
        }
        return { ok: true };
      },
      matches: (command, cwd) => command.includes(cwd) && command.includes("scripts/monitor-sweeper.ts"),
      start: (cwd) => startTsxWorker(cwd, "scripts/monitor-sweeper.ts", "logs/monitor-sweeper.log"),
      details: () => [{ label: "Sweep", value: process.env.MONITOR_SWEEP === "0" ? "disabled" : "enabled" }],
    },
  };
}

function statusFor(def: ProcessDef, rows: ProcRow[], root: string): ManagedProcessStatus {
  const availability = def.available();
  const pids = rows
    .filter((row) => row.pid !== process.pid && isLiveProcessStat(row.stat) && def.matches(row.command, root))
    .map((row) => row.pid)
    .sort((a, b) => a - b);

  return {
    id: def.id,
    label: def.label,
    description: def.description,
    state: !availability.ok ? "unavailable" : pids.length > 0 ? "running" : "stopped",
    pids,
    logFile: def.logFile,
    available: availability.ok,
    unavailableReason: availability.ok ? null : availability.reason,
    health: defaultHealth(availability.ok, pids.length > 0),
    details: def.details?.(root) ?? [],
  };
}

async function enrichStatus(def: ProcessDef, status: ManagedProcessStatus): Promise<ManagedProcessStatus> {
  if (!def.probe) return status;
  return { ...status, health: await def.probe(status) };
}

async function readProcessRows(): Promise<ProcRow[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,stat=,command="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        if (!match) return null;
        return { pid: Number(match[1]), stat: match[2], command: match[3] };
      })
      .filter((row): row is ProcRow => !!row && Number.isFinite(row.pid));
  } catch {
    return [];
  }
}

function startInngest(root: string): void {
  const bin = resolve(root, "node_modules/.bin/inngest-cli");
  const base = getInngestUrl();
  const serveUrl = joinUrl(
    process.env.INNGEST_SERVE_ORIGIN || "http://localhost:3002",
    process.env.INNGEST_SERVE_PATH || "/api/inngest",
  );
  startDetached(
    root,
    bin,
    ["dev", "--host", "0.0.0.0", "-p", String(inngestPort(base)), "-u", serveUrl],
    "logs/inngest.log",
  );
}

function startTsxWorker(root: string, script: string, logFile: string): void {
  startDetached(root, resolve(root, "node_modules/.bin/tsx"), ["--env-file=.env.local", script], logFile);
}

function startDetached(root: string, command: string, args: string[], logFile: string): void {
  mkdirSync(resolve(root, "logs"), { recursive: true });
  const out = openSync(resolve(root, logFile), "a");
  const child = execSpawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}`,
    },
  });
  child.unref();
}

function execSpawn(command: string, args: string[], options: SpawnOptions) {
  // Keep spawn in a tiny wrapper so tests can mock this module without shelling out.
  return spawn(command, args, options);
}

async function terminatePids(pids: number[], signal: NodeJS.Signals): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // The process may have exited between ps and signal delivery.
      }
    }
  }
}

async function waitForStop(def: ProcessDef, root: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = statusFor(def, await readProcessRows(), root);
    if (current.pids.length === 0) return true;
    await sleep(200);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isLiveProcessStat(stat: string): boolean {
  return !stat.includes("T") && !stat.includes("Z") && !stat.includes("X");
}

function defaultHealth(available: boolean, running: boolean): ManagedProcessHealth {
  if (!available) {
    return {
      state: "unknown",
      message: "process is unavailable",
      endpoint: null,
      latencyMs: null,
      checkedAt: null,
    };
  }
  if (!running) {
    return {
      state: "unknown",
      message: "process is not running",
      endpoint: null,
      latencyMs: null,
      checkedAt: null,
    };
  }
  return {
    state: "unknown",
    message: "no active health probe",
    endpoint: null,
    latencyMs: null,
    checkedAt: null,
  };
}

async function probeInngest(status: ManagedProcessStatus): Promise<ManagedProcessHealth> {
  const endpoint = joinUrl(getInngestUrl(), "/v1/events?limit=1");
  if (!status.available || status.state !== "running") {
    return { ...status.health, endpoint };
  }
  return probeHttp(endpoint);
}

async function probeHttp(endpoint: string): Promise<ManagedProcessHealth> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(endpoint, {
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    return {
      state: res.ok ? "healthy" : "unhealthy",
      message: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${res.statusText}`.trim(),
      endpoint,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      state: "unhealthy",
      message: (e as Error).name === "AbortError" ? "health probe timed out" : (e as Error).message,
      endpoint,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isLocalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function inngestPort(raw = getInngestUrl()): number {
  try {
    const url = new URL(raw);
    const parsed = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isFinite(parsed) ? parsed : 8288;
  } catch {
    return 8288;
  }
}

function joinUrl(origin: string, path: string): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanOrigin}${cleanPath}`;
}
