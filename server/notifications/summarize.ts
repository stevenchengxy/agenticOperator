// AI alert manager — enriches firing alerts with a Chinese summary + triage,
// cached on the Notification row (mirrors server/run-summary/synthesize.ts).
//
// Off Inngest by design (observability/synthesis is a plain module + Postgres
// cache). Triggered lazily when the center is viewed (summarizePendingAlerts)
// and eagerly when a new critical alert lands. CRITICAL invariant: when the LLM
// gateway is unavailable (itself a top alert source) this degrades to the pure
// fallbackSummary and only-important notification still holds — the AI layer is
// never a dependency of the alert pipeline working.

import { prisma } from '@/server/db';
import { chatComplete, isGatewayConfigured } from '@/server/llm/gateway';

export interface TriageRow {
  source: string;
  severity: string;
  category: string;
  count: number;
  body: string;
}

const SEV_ZH: Record<string, string> = { critical: '严重', warning: '提醒', info: '信息' };

/** Pure deterministic summary — used as the fallback when the gateway is down. */
export function fallbackSummary(n: TriageRow): string {
  const sev = SEV_ZH[n.severity] ?? n.severity;
  const times = n.count > 1 ? ` · 近期 ${n.count} 次` : '';
  const head = n.body.split('\n')[0].slice(0, 120);
  return `${n.source} · ${sev}${times}:${head}`;
}

export interface Triage {
  summary?: string;
  severity?: string;
  shouldNotify?: boolean;
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return m ? m[1].trim() : t;
}

/** Parse the LLM triage JSON. Returns null unless a usable `summary` is present. */
export function parseTriage(text: string): Triage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== 'string' || o.summary.trim().length === 0) return null;
  return {
    summary: o.summary.trim(),
    severity: typeof o.severity === 'string' ? o.severity : undefined,
    shouldNotify: typeof o.should_notify === 'boolean' ? o.should_notify : undefined,
  };
}

const SYSTEM_PROMPT =
  '你是招聘运营平台的告警分诊助手。给运营人员用一句中文业务语言总结这条告警:发生了什么、影响什么、是否需要人处理。' +
  '只输出 JSON: {"summary": "一句话中文总结(≤80字, 不要出现事件名/函数名/英文枚举值)", ' +
  '"severity": "critical|warning|info", "should_notify": true|false}。' +
  'should_notify=true 仅当确实需要人工介入或影响面广。';

function buildUserPrompt(n: TriageRow): string {
  return [
    `来源: ${n.source}`,
    `当前严重度: ${n.severity}`,
    `分类: ${n.category}`,
    `近期发生次数: ${n.count}`,
    `原始信息: ${n.body.slice(0, 600)}`,
  ].join('\n');
}

async function applyFallback(id: string, row: TriageRow): Promise<void> {
  await prisma.notification.update({
    where: { id },
    data: { aiSummary: fallbackSummary(row), aiSource: 'fallback', aiGeneratedAt: new Date() },
  });
}

/** Enrich one alert. Never throws — falls back deterministically on any error. */
export async function summarizeAlert(id: string): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n || n.kind !== 'alert') return;
  const row: TriageRow = {
    source: n.source,
    severity: n.severity,
    category: n.category,
    count: n.count,
    body: n.body,
  };
  if (!isGatewayConfigured()) {
    await applyFallback(id, row);
    return;
  }
  try {
    const res = await chatComplete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(row),
      temperature: 0.2,
      maxTokens: 400,
      toolName: 'alert-triage',
    });
    const parsed = parseTriage(res.text);
    if (!parsed) {
      await applyFallback(id, row);
      return;
    }
    await prisma.notification.update({
      where: { id },
      data: {
        aiSummary: parsed.summary,
        aiSeverity: parsed.severity ?? n.severity,
        aiShouldNotify: parsed.shouldNotify ?? null,
        aiSource: 'llm',
        llmModel: res.modelUsed,
        aiGeneratedAt: new Date(),
      },
    });
  } catch {
    // Gateway down / parse failure — degrade, never block.
    await applyFallback(id, row).catch(() => {});
  }
}

/**
 * Lazy-on-view: enrich up to `limit` firing alerts that have no AI summary yet.
 * Returns how many were processed. Safe to fire-and-forget from the list route.
 */
export async function summarizePendingAlerts(limit = 10): Promise<number> {
  let pending: Array<{ id: string }> = [];
  try {
    pending = await prisma.notification.findMany({
      where: { kind: 'alert', status: 'firing', aiGeneratedAt: null },
      take: limit,
      orderBy: { ts: 'desc' },
      select: { id: true },
    });
  } catch {
    return 0;
  }
  for (const p of pending) {
    await summarizeAlert(p.id).catch(() => {});
  }
  return pending.length;
}
