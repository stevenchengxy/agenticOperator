// /monitor/inngest/[slug] — Inngest agent drill-in (Level 3).
//
// Shows: header + AI summary + flow list (each = 1 candidate × 1 JD process).

"use client";

import { useParams } from 'next/navigation';
import { Shell } from '@/components/shared/Shell';
import { InngestAgentDetailContent } from '@/components/monitor/InngestAgentDetailContent';
import { useApp } from '@/lib/i18n';

export default function Page() {
  const { t } = useApp();
  const params = useParams();
  const slug = typeof params?.slug === 'string' ? params.slug : String(params?.slug ?? '');
  return (
    <Shell crumbs={[t('nav_monitor'), t('monitor_tab_agents'), slug]} directionTag={t('monitor_direction_inngest_agent')}>
      <InngestAgentDetailContent slug={slug} />
    </Shell>
  );
}
