// Embedded in /monitor 'Agents' tab — was originally /workflow-agents page.
// Shows the 3 real PRA agents with pause toggle + send test event.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentCard } from '@/components/workflow-agents/AgentCard';
import { SendEventModal } from '@/components/workflow-agents/SendEventModal';
import { useApp } from '@/lib/i18n';
import type { AgentFunction, RunRow } from '@/components/workflow-agents/WorkflowAgentsContent';

const REFRESH_MS = 5000;

export function InngestAgentsTab({
  onSelectAgent,
}: {
  onSelectAgent?: (slug: string) => void;
}) {
  const { t } = useApp();
  const router = useRouter();
  const [functions, setFunctions] = useState<AgentFunction[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sendModalFor, setSendModalFor] = useState<string | null>(null);

  async function load() {
    try {
      const [fn, run] = await Promise.all([
        fetch('/api/inngest-admin/functions').then((r) => r.json()),
        fetch('/api/inngest-admin/runs?limit=100').then((r) => r.json()),
      ]);
      setFunctions(fn.functions ?? []);
      setRuns(run.runs ?? []);
    } catch {
      /* soft fail */
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
      {functions.length === 0 && (
        <div className="col-span-full text-[12px] text-ink-3 px-2 py-4 border border-dashed border-line rounded">
          {t('monitor_agents_waiting_registration')}
        </div>
      )}
      {functions.map((fn) => {
        const fnRuns = runs.filter((r) => r.function.slug === fn.slug);
        const fnSuccess = fnRuns.filter((r) => r.status === 'Completed').length;
        const fnFail = fnRuns.filter((r) => r.status === 'Failed').length;
        return (
          <AgentCard
            key={fn.slug}
            fn={fn}
            runCount={fnRuns.length}
            successCount={fnSuccess}
            failCount={fnFail}
            selected={false}
            onClick={() => {
              if (onSelectAgent) onSelectAgent(fn.slug);
              else router.push(`/monitor/inngest/${fn.slug}`);
            }}
            onToggle={async (paused) => {
              await fetch(`/api/inngest-admin/functions/${fn.slug}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paused }),
              });
              load();
            }}
            onSendTest={() => setSendModalFor(fn.triggers[0]?.value ?? null)}
          />
        );
      })}
      {sendModalFor && (
        <SendEventModal
          triggerName={sendModalFor}
          onClose={() => setSendModalFor(null)}
          onSent={() => {
            setSendModalFor(null);
            setTimeout(load, 1500);
          }}
        />
      )}
    </div>
  );
}
