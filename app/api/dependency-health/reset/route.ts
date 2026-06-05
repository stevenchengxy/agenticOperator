// POST /api/dependency-health/reset  { provider: 'robohire' | 'llm' }
//
// Operator "I topped up" action. Drops a dependency_reset marker (degraded-call
// signals at/before it are ignored) AND immediately resolves the firing
// dep_down.<provider>.* alert so the card/notification update without waiting for
// the next sweep. If the dependency is still dead, the next failed call re-raises
// it within a minute — so this can clear a stale alarm but not hide a real outage.

import { NextResponse } from 'next/server';
import { recordLogEvent } from '@/server/log/log-event';
import { createPgResolveDeps } from '@/lib/monitor/pg-read-port';

const PROVIDERS = new Set(['robohire', 'llm']);

export async function POST(req: Request): Promise<Response> {
  let provider: unknown;
  try {
    provider = (await req.json())?.provider;
  } catch {
    provider = undefined;
  }
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) {
    return NextResponse.json({ ok: false, error: 'invalid provider' }, { status: 400 });
  }

  // 1. Marker — ignores every degraded signal at/before now for this provider.
  await recordLogEvent({
    type: 'dependency_reset',
    message: `已标记 ${provider} 充值/恢复 — 清除历史失败信号`,
    source: provider === 'llm' ? 'LLM 网关' : 'RoboHire',
    payloadJson: JSON.stringify({ provider }),
  });

  // 2. Resolve the firing alert(s) now so the UI reflects it immediately.
  let resolved = 0;
  try {
    const deps = createPgResolveDeps();
    const keys = await deps.findFiring(`dep_down.${provider}.`);
    await deps.markResolved(keys);
    resolved = keys.length;
  } catch (e) {
    // Marker is already written (the durable part); resolving is best-effort —
    // the next sweep's resolveStale will close it anyway.
    console.warn(`[dependency-health/reset] resolve failed: ${(e as Error).message}`);
  }

  return NextResponse.json({ ok: true, provider, resolved });
}
