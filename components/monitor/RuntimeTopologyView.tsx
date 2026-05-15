// Compact "实时" topology — shows ONLY the 3 deployed agents + the events that flow
// between them. UI v2 — cleaner spacing, better visual hierarchy, internal step
// preview rail under each agent.
//
// Layout:
//   ┌─ RESUME_DOWNLOADED ─►  Resume Parser  ─► RESUME_PROCESSED ─► Matcher ─► MATCH_*
//   └─ REQUIREMENT_LOGGED ─► Create JD ─► JD_GENERATED

'use client';

import { useRouter } from 'next/navigation';
import { useInngestLiveOverlay, type LiveAgentState } from '@/lib/api/inngest-live-overlay';
import { useApp } from '@/lib/i18n';
import { AGENT_INTERNAL_FLOWS, STEP_KIND_COLOR } from '@/lib/agent-internal-flow';

const AGENT_LAYOUT: Array<{
  wsId: string;
  shortName: string;
  fullName: string;
  x: number;
  y: number;
  inputs: string[];
  outputs: string[];
}> = [
  {
    wsId: '4',
    shortName: 'Create JD',
    fullName: 'Create JD Agent',
    x: 440,
    y: 60,
    inputs: ['REQUIREMENT_LOGGED', 'CLARIFICATION_READY', 'JD_REJECTED'],
    outputs: ['JD_GENERATED'],
  },
  {
    wsId: '9-1',
    shortName: 'Resume Parser',
    fullName: 'Resume Parser Agent',
    x: 440,
    y: 250,
    inputs: ['RESUME_DOWNLOADED'],
    outputs: ['RESUME_PROCESSED'],
  },
  {
    wsId: '10',
    shortName: 'Matcher',
    fullName: 'Match Resume Agent',
    x: 920,
    y: 250,
    inputs: ['RESUME_PROCESSED'],
    outputs: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'],
  },
];

const VIEW_W = 1340;
const VIEW_H = 380;
const NODE_W = 220;
const NODE_H = 130;

export function RuntimeTopologyView() {
  const { t } = useApp();
  const router = useRouter();
  const { byWsId } = useInngestLiveOverlay();

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] text-ink-3">
          {t('monitor_runtime_topology_hint')}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-ink-4">
          <LegendDot color="var(--c-ok)" label={`● ${t('monitor_agent_card_live')}`} />
          <LegendDot color="var(--c-warn)" label={`⏸ ${t('monitor_agent_card_paused')}`} />
          <LegendDot color="var(--c-ink-4)" label={t('monitor_runtime_not_deployed')} />
        </div>
      </div>
      <div className="border border-line rounded-md bg-panel p-4">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-[460px]">
          <defs>
            <marker id="rt-arrow-v2" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-3)" />
            </marker>
            <linearGradient id="rt-event-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--c-accent)" stopOpacity="0" />
              <stop offset="50%" stopColor="var(--c-accent)" stopOpacity="0.6" />
              <stop offset="100%" stopColor="var(--c-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Edges with event labels */}
          <EventArrow x1={140} y1={AGENT_LAYOUT[0].y + 36} x2={AGENT_LAYOUT[0].x} y2={AGENT_LAYOUT[0].y + 36}
            label="REQUIREMENT_LOGGED" anchor="start" />
          <EventArrow x1={AGENT_LAYOUT[0].x + NODE_W} y1={AGENT_LAYOUT[0].y + 36}
            x2={AGENT_LAYOUT[0].x + NODE_W + 200} y2={AGENT_LAYOUT[0].y + 36}
            label="JD_GENERATED" anchor="end" />

          <EventArrow x1={140} y1={AGENT_LAYOUT[1].y + 36} x2={AGENT_LAYOUT[1].x} y2={AGENT_LAYOUT[1].y + 36}
            label="RESUME_DOWNLOADED" anchor="start" />
          <EventArrow x1={AGENT_LAYOUT[1].x + NODE_W} y1={AGENT_LAYOUT[1].y + 36}
            x2={AGENT_LAYOUT[2].x} y2={AGENT_LAYOUT[2].y + 36}
            label="RESUME_PROCESSED" anchor="middle" />

          <EventArrow x1={AGENT_LAYOUT[2].x + NODE_W} y1={AGENT_LAYOUT[2].y + 36}
            x2={AGENT_LAYOUT[2].x + NODE_W + 200} y2={AGENT_LAYOUT[2].y + 36}
            label="MATCH_*" anchor="end" />

          {/* Agent nodes */}
          {AGENT_LAYOUT.map((a) => (
            <AgentNode
              key={a.wsId}
              x={a.x}
              y={a.y}
              shortName={a.shortName}
              fullName={a.fullName}
              live={byWsId.get(a.wsId) ?? null}
              onClick={() => {
                const live = byWsId.get(a.wsId);
                if (live) router.push(`/monitor/inngest/${live.slug}`);
              }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: color }}
      />
      <span>{label}</span>
    </span>
  );
}

function EventArrow({
  x1,
  y1,
  x2,
  y2,
  label,
  anchor,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}) {
  const labelX = anchor === 'start' ? x1 + 4 : anchor === 'end' ? x2 - 4 : (x1 + x2) / 2;
  const labelY = y1 - 10;
  const labelWidth = label.length * 5.4 + 10;
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2 - 9}
        y2={y2}
        stroke="var(--c-ink-3)"
        strokeWidth={1.4}
        markerEnd="url(#rt-arrow-v2)"
      />
      <rect
        x={
          labelX -
          (anchor === 'start' ? 0 : anchor === 'end' ? labelWidth : labelWidth / 2)
        }
        y={labelY - 8}
        width={labelWidth}
        height={15}
        rx={3}
        fill="var(--c-surface)"
        stroke="var(--c-line)"
      />
      <text
        x={labelX + (anchor === 'start' ? 5 : anchor === 'end' ? -5 : 0)}
        y={labelY + 2.5}
        textAnchor={anchor}
        fontSize={9}
        fontFamily="var(--f-mono)"
        fontWeight={500}
        fill="var(--c-ink-2)"
      >
        {label}
      </text>
    </g>
  );
}

function AgentNode({
  x,
  y,
  shortName,
  fullName,
  live,
  onClick,
}: {
  x: number;
  y: number;
  shortName: string;
  fullName: string;
  live: LiveAgentState | null;
  onClick: () => void;
}) {
  const { t } = useApp();
  const fill = live?.paused ? 'var(--c-warn-bg)' : live ? 'var(--c-ok-bg)' : 'var(--c-panel)';
  const stroke = live?.paused ? 'var(--c-warn)' : live ? 'var(--c-ok)' : 'var(--c-line)';

  // Get internal step preview (3 key steps for the rail)
  const internal = live ? AGENT_INTERNAL_FLOWS[live.slug] : null;
  const previewSteps = internal?.steps.slice(0, 4) ?? [];

  return (
    <g transform={`translate(${x} ${y})`} style={{ cursor: 'pointer' }} onClick={onClick}>
      {/* Main card */}
      <rect width={NODE_W} height={NODE_H} rx={10} fill={fill} stroke={stroke} strokeWidth={1.5} />

      {/* Live ribbon at top */}
      <rect width={NODE_W} height={3} rx={10} fill={live?.paused ? 'var(--c-warn)' : live ? 'var(--c-ok)' : 'var(--c-ink-4)'} />

      {/* LIVE/PAUSED badge top-right */}
      {live && (
        <g transform={`translate(${NODE_W - 62}, 10)`}>
          <rect
            width={54}
            height={16}
            rx={8}
            fill={live.paused ? 'var(--c-warn)' : 'var(--c-ok)'}
          />
          <text x={27} y={11.5} fontSize={9} fontWeight={700} fill="white" textAnchor="middle">
            {live.paused ? `⏸ ${t('monitor_agent_card_paused')}` : `● ${t('monitor_agent_card_live')}`}
          </text>
        </g>
      )}

      {/* Agent name + slug */}
      <text x={14} y={28} fontSize={15} fontWeight={600} fill="var(--c-ink-1)" fontFamily="var(--f-sans)">
        {shortName}
      </text>
      <text x={14} y={42} fontSize={9.5} fill="var(--c-ink-4)" fontFamily="var(--f-mono)">
        {fullName}
      </text>

      {/* Run stats line */}
      {live && (
        <g>
          <text x={14} y={62} fontSize={11.5} fontFamily="var(--f-mono)">
            <tspan fill="var(--c-ok)" fontWeight={600}>{live.completed}✓</tspan>
            {live.failed > 0 && (
              <tspan fill="var(--c-err)" fontWeight={600} dx="6">{live.failed}✗</tspan>
            )}
            {live.running > 0 && (
              <tspan fill="var(--c-warn)" fontWeight={600} dx="6">{live.running}●</tspan>
            )}
            <tspan fill="var(--c-ink-3)" dx="8">· {live.successRate ?? '?'}%</tspan>
            <tspan fill="var(--c-ink-4)" dx="6">· {live.total} {t('monitor_metric_runs')}/24h</tspan>
          </text>
        </g>
      )}
      {!live && (
        <text x={14} y={62} fontSize={11} fill="var(--c-ink-4)" fontFamily="var(--f-mono)">
          {t('monitor_runtime_unregistered')}
        </text>
      )}

      {/* Internal step preview rail */}
      {previewSteps.length > 0 && (
        <g transform={`translate(14, 75)`}>
          <text x={0} y={0} fontSize={8.5} fill="var(--c-ink-4)" fontFamily="var(--f-mono)" letterSpacing={0.4}>
            {t('monitor_internal_steps')}
          </text>
          <g transform="translate(0, 8)">
            {previewSteps.map((step, i) => {
              const colors = STEP_KIND_COLOR[step.kind];
              const isSubsystem = step.kind === 'subsystem';
              const w = 44;
              return (
                <g key={step.id} transform={`translate(${i * (w + 4)}, 0)`}>
                  <rect
                    width={w}
                    height={20}
                    rx={3}
                    fill={isSubsystem ? 'var(--c-warn)' : 'var(--c-surface)'}
                    stroke={isSubsystem ? 'var(--c-warn)' : 'var(--c-line)'}
                    strokeWidth={isSubsystem ? 1.2 : 0.8}
                  />
                  <text
                    x={w / 2}
                    y={13}
                    fontSize={8.5}
                    fontFamily="var(--f-mono)"
                    fontWeight={isSubsystem ? 700 : 500}
                    fill={isSubsystem ? 'white' : 'var(--c-ink-2)'}
                    textAnchor="middle"
                  >
                    {step.name.length > 7 ? step.name.slice(0, 6) + '…' : step.name}
                  </text>
                </g>
              );
            })}
            {internal && internal.steps.length > previewSteps.length && (
              <text
                x={previewSteps.length * 48}
                y={13}
                fontSize={9}
                fill="var(--c-ink-4)"
                fontFamily="var(--f-mono)"
              >
                +{internal.steps.length - previewSteps.length}
              </text>
            )}
          </g>
        </g>
      )}

      {/* Click hint */}
      {live && (
        <text x={NODE_W - 8} y={NODE_H - 8} fontSize={9} fill="var(--c-ink-4)" textAnchor="end" fontFamily="var(--f-mono)">
          {t('monitor_open')}
        </text>
      )}
    </g>
  );
}
