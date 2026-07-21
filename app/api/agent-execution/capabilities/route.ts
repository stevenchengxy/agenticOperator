// A4 — GET /api/agent-execution/capabilities
// Advertise supported scenarios, pinnable ontology versions, agent/prompt
// versions. Lets the partner discover what to send without offline back-and-forth.

import { NextResponse } from 'next/server';
import { checkAuth } from '@/server/agent-execution/auth';
import { listVersions, loadVersion } from '@/server/agent-execution/version-registry';
import { AGENT_VERSION, PROMPT_VERSION } from '@/server/agent-execution/mapper';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, retryable: false } },
      { status: auth.status },
    );
  }

  const versions = listVersions().map((v) => {
    const loaded = loadVersion(v);
    return { version: v, ruleCount: loaded?.ruleCount ?? null, metadataVersion: loaded?.metadataVersion ?? null };
  });

  return NextResponse.json(
    {
      scenarios: ['matchResume'],
      domains: ['RAAS-v1', 'raas', '招聘-v1'],
      ontologyVersions: versions,
      agentVersion: AGENT_VERSION,
      promptVersion: PROMPT_VERSION,
      modes: ['shadow'],
      limits: { maxConcurrent: 4, idempotencyWindowDays: 7, resultRetentionDays: 7 },
      notes: [
        'inline candidate not supported in MVP (use candidate.ref) — guide §10-④',
        'entry.stepIds not supported (single-pass evaluation) — guide §10-⑩',
        'meta.usage.usd is null (token-only metering) — guide §10-⑤',
        'interpretation/evidence are derived-from-reason until the prompt split lands — guide §10-④',
      ],
    },
    { status: 200 },
  );
}
