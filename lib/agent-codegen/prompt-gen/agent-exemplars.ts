// agent-exemplars.ts
// Reads the 5 production agents' source as read-only blueprints. They are
// ground truth; PromptGen NEVER writes them. Trigger/emits are parsed best-effort
// for blueprint matching; failures degrade to an empty exemplar list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentExemplar } from './context-select';

const AGENTS_DIR = join(process.cwd(), 'server', 'inngest', 'agents');

const KNOWN: Array<{ slug: string; stage: string; file: string; triggerEvent: string; emitEvents: string[] }> = [
  {
    slug: 'create-jd-agent',
    stage: 'jd',
    file: 'create-jd-agent.ts',
    // Primary trigger is REQUIREMENT_LOGGED; also handles CLARIFICATION_READY, JD_REJECTED
    triggerEvent: 'REQUIREMENT_LOGGED',
    emitEvents: ['JD_GENERATED'],
  },
  {
    slug: 'resume-parser-agent',
    stage: 'resume',
    file: 'resume-parser-agent.ts',
    triggerEvent: 'RESUME_DOWNLOADED',
    emitEvents: ['RESUME_PROCESSED'],
  },
  {
    slug: 'rule-check-agent',
    stage: 'match',
    file: 'rule-check-agent.ts',
    triggerEvent: 'RESUME_PROCESSED',
    emitEvents: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED'],
  },
  {
    slug: 'match-resume-agent',
    stage: 'match',
    file: 'match-resume-agent.ts',
    triggerEvent: 'MATCH_RULE_CHECK_PASSED',
    emitEvents: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_FAILED'],
  },
  {
    slug: 'interview-inviter-agent',
    stage: 'interview',
    file: 'interview-inviter-agent.ts',
    triggerEvent: 'INTERVIEW_INVITATION_REQUESTED',
    emitEvents: ['INTERVIEW_INVITATION_SENT', 'INTERVIEW_INVITATION_FAILED'],
  },
];

export function loadAgentExemplars(): AgentExemplar[] {
  return KNOWN.flatMap((a) => {
    try {
      const source = readFileSync(join(AGENTS_DIR, a.file), 'utf8');
      return [{ slug: a.slug, stage: a.stage, triggerEvent: a.triggerEvent, emitEvents: a.emitEvents, source }];
    } catch {
      return [];
    }
  });
}
