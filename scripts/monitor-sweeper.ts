// Monitor sweeper — standalone long-lived poller (mirrors scripts/inngest-
// archiver.ts) that runs the deterministic monitors every
// MONITOR_SWEEP_INTERVAL_MS, emits notifications via recordNotification, and
// resolves stale alerts. Off-Inngest by design (observability runs as a plain
// process + Postgres, never on the agent runtime). Single instance is enforced
// by dev-bootstrap's pgrep guard; gated by MONITOR_SWEEP.
//
//   npm run monitor:sweep
//
// Env:
//   MONITOR_SWEEP                1 (default) | 0 to no-op
//   MONITOR_SWEEP_INTERVAL_MS    sweep period (default 60000)
//
// See docs/superpowers/specs/2026-06-04-multi-agent-monitor-architecture-design.md
import { recordNotification } from "../server/notifications/ingest";
import { prisma } from "../server/db";
import { DEFAULT_THRESHOLDS } from "../lib/monitor/monitor-types";
import { createPgReadPort, createPgResolveDeps } from "../lib/monitor/pg-read-port";
import { resolveStale } from "../lib/monitor/resolve";
import { runSweep, type Monitor } from "../lib/monitor/sweep";
import { healthMonitor } from "../lib/monitor/health";
import { slaMonitor } from "../lib/monitor/sla";
import { costMonitor } from "../lib/monitor/cost";
import { errorRateMonitor } from "../lib/monitor/error-rate";
import { dependencyMonitor } from "../lib/monitor/dependency";
import { infraMonitor } from "../lib/monitor/infra";
import { hitlStaleMonitor } from "../lib/monitor/hitl";
import { runEvalSample } from "../lib/monitor/run-eval";
import { resolveMonitorConfig } from "../lib/monitor/monitor-config";
import { makeLlmJudge, makeJury } from "../lib/monitor/llm-judge";
import { createPgEvalStore, getMonitorConfig, recentAuditSamples } from "../lib/monitor/pg-eval-store";
import { RECRUITMENT_DOMAIN_ID } from "../lib/domain-ids";

const ENABLED = process.env.MONITOR_SWEEP !== "0";
const EVAL_ENABLED = process.env.MONITOR_EVAL !== "0";
const INTERVAL_MS = Number(process.env.MONITOR_SWEEP_INTERVAL_MS) || 60_000;
const EVAL_WINDOW_MS = 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 保留策略(每小时跑一次,挂在 sweep tick 上)──────────────────────────
// 监控、告警、评估和日志默认全部永久保留。只有运维显式把对应天数
// 配置为 > 0 时才会清理，避免长期运行后页面历史悄悄出现断层。
const NOTIFICATION_RETENTION_DAYS = Number(process.env.NOTIFICATION_RETENTION_DAYS) || 0;
const MONITOR_EVAL_RETENTION_DAYS = Number(process.env.MONITOR_EVAL_RETENTION_DAYS) || 0;
const LOG_EVENT_RETENTION_DAYS = Number(process.env.LOG_EVENT_RETENTION_DAYS) || 0;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPruneAt = 0;

async function pruneTick(now = Date.now()): Promise<void> {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  const cut = (days: number) => new Date(now - days * 86_400_000);
  try {
    let msgs = 0;
    let alerts = 0;
    let evals = 0;
    let logs = 0;
    if (NOTIFICATION_RETENTION_DAYS > 0) {
      const ntf = cut(NOTIFICATION_RETENTION_DAYS);
      msgs = (await prisma.notification.deleteMany({
        where: { kind: "message", readAt: { not: null }, ts: { lt: ntf } },
      })).count;
      alerts = (await prisma.notification.deleteMany({
        where: { kind: "alert", status: { in: ["resolved", "ack"] }, lastSeenAt: { lt: ntf } },
      })).count;
    }
    if (MONITOR_EVAL_RETENTION_DAYS > 0) {
      evals = (await prisma.monitorEval.deleteMany({
        where: { ts: { lt: cut(MONITOR_EVAL_RETENTION_DAYS) } },
      })).count;
    }
    if (LOG_EVENT_RETENTION_DAYS > 0) {
      logs = (await prisma.logEvent.deleteMany({ where: { ts: { lt: cut(LOG_EVENT_RETENTION_DAYS) } } })).count;
    }
    if (msgs + alerts + evals + logs > 0) {
      console.log(
        `[monitor] prune — messages-${msgs} alerts-${alerts} evals-${evals} logs-${logs}`,
      );
    }
  } catch (e) {
    console.warn(`[monitor] prune failed: ${(e as Error).message}`);
  }
}

// ── 自身心跳 — watchdog 据此判定 sweeper 死活(监控骨干自身无人监控,
//    2026-06-11 审计)。复用 ServiceHeartbeat 表,行 id='monitor-sweeper'。
async function beatHeartbeat(): Promise<void> {
  const now = new Date();
  await prisma.serviceHeartbeat
    .upsert({
      where: { id: "monitor-sweeper" },
      create: { id: "monitor-sweeper", lastBootAt: now, lastHeartbeatAt: now, pid: process.pid },
      update: { lastHeartbeatAt: now, pid: process.pid },
    })
    .catch(() => {});
}

const monitors: Monitor[] = [healthMonitor, slaMonitor, costMonitor, errorRateMonitor, dependencyMonitor, infraMonitor, hitlStaleMonitor];

// AI fact-monitor — sampled groundedness eval over recent rule-check audits.
// Fire-and-forget so it NEVER blocks or breaks the deterministic sweep; judges
// degrade to a skip when the gateway is down. Each audit is judged at most once.
async function runEvalTick(): Promise<void> {
  const domain = RECRUITMENT_DOMAIN_ID;
  const config = resolveMonitorConfig(await getMonitorConfig(domain), domain);
  const samples = await recentAuditSamples(EVAL_WINDOW_MS);
  if (samples.length === 0) return;
  const primaryModel = process.env.AI_MODEL || "openai/gpt-5.4";
  const r = await runEvalSample({
    samples,
    config,
    primaryJudge: makeLlmJudge(),
    juryJudges: makeJury(primaryModel, 2),
    store: createPgEvalStore(),
    record: (f) => recordNotification(f),
    sweepWindow: new Date().toISOString().slice(0, 13),
  });
  if (r.evaluated > 0 || r.skipped > 0) {
    console.log(
      `[monitor] eval — evaluated=${r.evaluated} contested=${r.contested} ` +
        `flagged=${r.flagged} skipped=${r.skipped}`,
    );
  }
}

let stopping = false;

async function loop(): Promise<void> {
  const port = createPgReadPort();
  const resolveDeps = createPgResolveDeps();
  console.log(`[monitor] starting — interval=${INTERVAL_MS}ms monitors=${monitors.length}`);
  while (!stopping) {
    const t0 = Date.now();
    try {
      const r = await runSweep({
        port,
        thresholds: DEFAULT_THRESHOLDS,
        monitors,
        record: (f) => recordNotification(f),
        resolve: (prefix, keys) => resolveStale(prefix, keys, resolveDeps),
      });
      console.log(
        `[monitor] tick ok — recorded=${r.recorded} resolved=${r.resolved} errors=${r.errors} ` +
          `(${Date.now() - t0}ms)`,
      );
    } catch (e) {
      console.error(`[monitor] tick FAILED: ${(e as Error).message}`);
    }
    await beatHeartbeat();
    await pruneTick();
    // fire-and-forget AI eval — must not block or break the deterministic sweep
    if (EVAL_ENABLED) {
      void runEvalTick().catch((e) =>
        console.error(`[monitor] eval FAILED: ${(e as Error).message}`),
      );
    }
    if (stopping) break;
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[monitor] ${signal} — shutting down…`);
  stopping = true;
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (!ENABLED) {
  console.log("[monitor] MONITOR_SWEEP=0 — sweeper disabled, exiting.");
  process.exit(0);
}

loop().catch(async (e) => {
  console.error("[monitor] fatal:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
