// Vendor copy of lib/ontology-gen/v4/fill-runtime-input.ts (AO main).
//
// 纯函数:把 {{CLIENT}} / {{JOB}} / {{RESUME}} 替换为渲染后的 runtime input。
// Reverse 替换顺序(RESUME → JOB → CLIENT)— 避免 resume/job 里恰好含
// "{{CLIENT}}" 字面量时被二次替换。

import type { ActionObjectV4 } from './action-object-v4.types';
import {
  isMatchResumeRuntimeInput,
  type MatchResumeRuntimeInput,
  type RuntimeClient,
} from './runtime-input.types';

const PLACEHOLDER_CLIENT = '{{CLIENT}}';
const PLACEHOLDER_JOB = '{{JOB}}';
const PLACEHOLDER_RESUME = '{{RESUME}}';

export function fillRuntimeInput(
  obj: ActionObjectV4,
  input: MatchResumeRuntimeInput,
): ActionObjectV4 {
  if (!isMatchResumeRuntimeInput(input)) {
    // 保留主仓 fillRuntimeInput 对其他 kind 的兜底处理空间;
    // resume-parser-agent 当前只用 matchResume 一条路径。
    throw new Error(
      '[rule-check/yeyang] fillRuntimeInput only supports MatchResumeRuntimeInput here',
    );
  }
  let p = obj.prompt;
  p = replaceAll(p, PLACEHOLDER_RESUME, renderJsonBlock(input.resume));
  p = replaceAll(p, PLACEHOLDER_JOB, renderJsonBlock(input.job));
  p = replaceAll(p, PLACEHOLDER_CLIENT, renderClient(input.client));
  return { ...obj, prompt: p };
}

function renderClient(c: RuntimeClient): string {
  const lines = [`client_name: ${c.name}`];
  if (c.department) lines.push(`department: ${c.department}`);
  return lines.join('\n');
}

function renderJsonBlock(v: unknown): string {
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

function replaceAll(s: string, needle: string, replacement: string): string {
  return s.split(needle).join(replacement);
}
