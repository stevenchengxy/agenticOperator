// Ground-truth registry — lookup by fixture name.

import { CREATE_JD_AGENT_GROUND_TRUTH } from './create-jd-agent';
import { INTERVIEW_INVITER_GROUND_TRUTH } from './interview-inviter-agent';
import type { GroundTruth } from './types';

export const GROUND_TRUTHS: ReadonlyArray<GroundTruth> = [
  CREATE_JD_AGENT_GROUND_TRUTH,
  INTERVIEW_INVITER_GROUND_TRUTH,
];

export function findGroundTruth(fixtureName: string): GroundTruth | undefined {
  return GROUND_TRUTHS.find((g) => g.fixtureName === fixtureName);
}

export type { GroundTruth, ExpectedStep, ExpectedEmit } from './types';
