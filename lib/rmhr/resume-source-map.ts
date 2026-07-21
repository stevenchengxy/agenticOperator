// PARTNER DELIVERABLE: full company resumeSourceId code list + label→code mapping.
// P0 ships only the one known code + the default; partner extends CHANNEL_CODE_MAP.
export const DEFAULT_RESUME_SOURCE_ID = '02001034'; // TODO(partner): confirm a real default that does NOT trigger data.code 1001
const CHANNEL_CODE_MAP: Record<string, string> = {
  'boss直聘-ai': '02001034',
  // TODO(partner): 猎聘 / 智联 / 前程无忧 / LinkedIn / 脉脉 / 人才库-AI ...
};
export function resolveResumeSourceId(aoChannel: string | null | undefined): string {
  const key = (aoChannel ?? '').trim().toLowerCase();
  return CHANNEL_CODE_MAP[key] ?? DEFAULT_RESUME_SOURCE_ID;
}
