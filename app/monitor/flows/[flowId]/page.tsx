// /monitor/flows/[flowId] — Level 4 (per-flow drill-in).
//
// flowId examples: "upload:u_xxx" / "jr:JR-001" / "evt:01KRM..."

"use client";

import { useParams } from 'next/navigation';
import { Shell } from '@/components/shared/Shell';
import { FlowDetailContent } from '@/components/monitor/FlowDetailContent';
import { useApp } from '@/lib/i18n';

export default function Page() {
  const { t } = useApp();
  const params = useParams();
  const flowId = typeof params?.flowId === 'string' ? params.flowId : String(params?.flowId ?? '');
  return (
    <Shell crumbs={[t('nav_monitor'), t('monitor_crumb_flows'), flowId]} directionTag={t('monitor_direction_flow_detail')}>
      <FlowDetailContent flowIdEncoded={flowId} />
    </Shell>
  );
}
