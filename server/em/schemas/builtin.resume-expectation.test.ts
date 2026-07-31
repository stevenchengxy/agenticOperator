import { describe, expect, it } from 'vitest';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { BUILTIN_SCHEMAS } from './builtin';

describe('resume event contract after expectation payload integration', () => {
  it('keeps the original RESUME_DOWNLOADED → RESUME_PROCESSED topology', () => {
    expect(BUILTIN_SCHEMAS.some((registration) => registration.name === 'RESUME_PARSED')).toBe(false);

    const resumeParser = AGENT_MAP.find((agent) => agent.short === 'ResumeParser');
    expect(resumeParser?.triggersEvents).toContain('RESUME_DOWNLOADED');
    expect(resumeParser?.emitsEvents).toContain('RESUME_PROCESSED');
    expect(resumeParser?.emitsEvents).not.toContain('RESUME_PARSED');
  });

  it('accepts the real RAAS expectation_payload on RESUME_DOWNLOADED', () => {
    const registration = BUILTIN_SCHEMAS.find(
      (candidate) => candidate.name === 'RESUME_DOWNLOADED',
    );
    expect(registration).toBeTruthy();

    const parsed = registration!.versions[0].schema.safeParse({
      entity_type: 'Candidate',
      entity_id: null,
      event_id: 'event-1',
      payload: {
        upload_id: 'upload-1',
        bucket: 'recruit-resume-raw',
        object_key: 'resumes/a.pdf',
        expectation_payload: {
          expected_location: '南京',
          expected_position: '电气工程师',
          expected_salary_range: '13000-15000',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
