// to-codegen-input.ts
// Deserialize an approved AgentPrompt into the existing pipeline inputs.
// runPipeline() is unchanged: this is the whole "inject prompt into CodeGen" seam.

import type { AgentPrompt } from './prompt-types';
import type { AgentFormFields } from '../spec-types';

export function toCodegenInput(
  prompt: AgentPrompt,
  confirmedForm: AgentFormFields,
): { form: AgentFormFields; businessLogic: string } {
  const lines: string[] = [];
  lines.push(`Role: ${prompt.role}`);
  if (prompt.inputs.length) lines.push(`Reads: ${prompt.inputs.join('; ')}`);
  lines.push('');
  lines.push('Steps:');
  prompt.steps.forEach((s, i) => {
    const tools = s.usesTools?.length ? ` [tools: ${s.usesTools.join(', ')}]` : '';
    lines.push(`  ${i + 1}. ${s.description}${tools}`);
  });
  if (prompt.constraints.length) {
    lines.push('');
    lines.push('Constraints:');
    prompt.constraints.forEach((c) => lines.push(`  - ${c}`));
  }
  if (prompt.acceptance.length) {
    lines.push('');
    lines.push('Acceptance:');
    prompt.acceptance.forEach((a) => lines.push(`  - ${a}`));
  }
  return { form: confirmedForm, businessLogic: lines.join('\n') };
}
