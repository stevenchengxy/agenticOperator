// Agent descriptions derived from the canonical workflow JSON (lib/workflow-canonical.json).
//
// Each agent's description, input events, output events, and processing steps
// are sourced from the authoritative workflow spec rather than hand-written.
// The public API (getAgentDescription) is unchanged so all consumers keep working.
//
// For agents outside the canonical workflow (Chatbot), a static fallback entry
// is provided below.

import { CANONICAL_WORKFLOW, type WorkflowJsonNode } from '@/lib/workflow-graph-meta';
import { AGENT_MAP } from '@/lib/agent-mapping';

export type AgentDescription = {
  description: string;
  input: string;
  output: string;
  processingLogic: string[];
};

export type AgentAction = {
  order: string;
  name: string;
  description: string;
  type: 'manual' | 'tool' | 'logic';
  condition: string;
};

/** AgentDescription extended with the raw actions array for expandable step views. */
export type AgentDescriptionFull = AgentDescription & {
  actions: AgentAction[];
};

// Build lookup maps
const BY_WSID = new Map<string, WorkflowJsonNode>(CANONICAL_WORKFLOW.map(n => [n.id, n]));
const WSID_BY_SHORT = new Map<string, string>(AGENT_MAP.map(a => [a.short, a.wsId]));

// Static descriptions for agents that live outside the canonical workflow.
const STATIC_DESCRIPTIONS: Record<string, AgentDescription> = {
  Chatbot: {
    description: '面向内部操作员的对话助手，支持查询运行状态、触发操作及答疑。',
    input: '操作员自然语言输入，通过 AO 控制台聊天界面触发。',
    output: '结构化回复或操作确认，写入 AgentActivity 审计日志。',
    processingLogic: [
      '解析操作员输入意图（查询 / 操作 / 解释）',
      '检索相关运行、事件或配置数据',
      '生成结构化回复或触发相应操作',
      '记录对话到 AgentActivity 供审计追溯',
    ],
  },
};

/**
 * Derive an AgentDescription from the canonical workflow JSON for the given
 * agent short name. Falls back to STATIC_DESCRIPTIONS for system-meta agents
 * (e.g. Chatbot). Returns null if the agent is unknown.
 */
export function getAgentDescription(canonicalShort: string): AgentDescription | null {
  // Check static fallback first (Chatbot etc.)
  if (STATIC_DESCRIPTIONS[canonicalShort]) {
    return STATIC_DESCRIPTIONS[canonicalShort];
  }

  const wsId = WSID_BY_SHORT.get(canonicalShort);
  if (!wsId) return null;

  const node = BY_WSID.get(wsId);
  if (!node) return null;

  const input =
    node.trigger.length > 0
      ? `订阅事件: ${node.trigger.join(' · ')}`
      : '由人工/外部系统直接触发 (无 Inngest 触发事件)';

  const output =
    node.triggered_event.length > 0
      ? `发出事件: ${node.triggered_event.join(' · ')}`
      : '终止节点 / 无下游事件';

  const processingLogic = node.actions.map(
    a =>
      `${a.name}: ${a.description.length > 120 ? a.description.slice(0, 120) + '…' : a.description}`,
  );

  return {
    description: node.description,
    input,
    output,
    processingLogic,
  };
}

/**
 * Like getAgentDescription but also exposes the raw actions array so consumers
 * can render expandable step detail panels without re-truncating the descriptions.
 * Returns null for unknown agents or static-only agents (e.g. Chatbot) that
 * don't have structured action data.
 */
export function getAgentDescriptionFull(canonicalShort: string): AgentDescriptionFull | null {
  // Static agents don't have structured action data — synthesize empty actions
  if (STATIC_DESCRIPTIONS[canonicalShort]) {
    const base = STATIC_DESCRIPTIONS[canonicalShort];
    return {
      ...base,
      actions: base.processingLogic.map((step, i) => ({
        order: String(i + 1),
        name: step.split(':')[0] ?? step,
        description: step,
        type: 'logic' as const,
        condition: '—',
      })),
    };
  }

  const wsId = WSID_BY_SHORT.get(canonicalShort);
  if (!wsId) return null;

  const node = BY_WSID.get(wsId);
  if (!node) return null;

  const input =
    node.trigger.length > 0
      ? `订阅事件: ${node.trigger.join(' · ')}`
      : '由人工/外部系统直接触发 (无 Inngest 触发事件)';

  const output =
    node.triggered_event.length > 0
      ? `发出事件: ${node.triggered_event.join(' · ')}`
      : '终止节点 / 无下游事件';

  const processingLogic = node.actions.map(
    a =>
      `${a.name}: ${a.description.length > 120 ? a.description.slice(0, 120) + '…' : a.description}`,
  );

  return {
    description: node.description,
    input,
    output,
    processingLogic,
    actions: node.actions,
  };
}
