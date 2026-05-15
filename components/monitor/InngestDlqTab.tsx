// Embedded in /monitor 'DLQ' tab — failed/cancelled run viewer + retry.

'use client';

import { useEffect, useState } from 'react';
import { DLQPanel } from '@/components/workflow-agents/DLQPanel';
import { RunDetailDrawer } from '@/components/workflow-agents/RunDetailDrawer';

export function InngestDlqTab() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // DLQPanel handles its own load + polling
  return (
    <div className="max-w-3xl">
      <DLQPanel onSelectRun={setSelectedRunId} />
      {selectedRunId && (
        <RunDetailDrawer runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
      )}
    </div>
  );
}
