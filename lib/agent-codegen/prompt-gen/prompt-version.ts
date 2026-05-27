// prompt-version.ts
// AgentPrompt <-> AgentVersion.codegen.promptText. New rows store JSON tagged
// with a version marker; legacy rows (plain prose) read as a minimal prompt.

import { AgentPromptDraftSchema, type AgentPrompt } from './prompt-types';

const TAG = 'agentprompt/v1:';

export function serializePromptText(prompt: AgentPrompt): string {
  return TAG + JSON.stringify(prompt);
}

export function deserializePromptText(text: string | null | undefined): AgentPrompt | null {
  if (!text) return null;
  if (text.startsWith(TAG)) {
    try {
      const obj = JSON.parse(text.slice(TAG.length));
      // tolerate the extra provenance/confirmed fields the draft schema omits
      const draft = AgentPromptDraftSchema.safeParse(obj);
      if (draft.success) {
        return {
          ...draft.data,
          trigger: { ...draft.data.trigger, confirmed: Boolean(obj?.trigger?.confirmed) },
          fieldOrigin: obj?.fieldOrigin ?? {},
        };
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  // legacy plain prose
  return {
    intent: text,
    role: '', trigger: { event: '', payloadExpectations: '', confirmed: false },
    inputs: [], steps: [], tools: [], emits: [], errorHandling: 'retry',
    constraints: [], acceptance: [], fieldOrigin: {},
  };
}
