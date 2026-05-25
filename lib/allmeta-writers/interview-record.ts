// Write Interview_Record instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json) Interview_Record:
//   interview_record_id (PK), interview_model_id, application_id,
//   interviewer_employee_id, interview_type, interview_round, start_time,
//   end_time, duration_minutes, interview_mode, recording_url,
//   raw_interview_notes, candidate_behavior_notes, tech_gaps_identified
//   (List<String>), golden_30_call_status (Boolean), interview_result
//
// 当前调用点:interviewInviterAgent 在 RoboHire 邀请发出后写一条 "skeleton"
//   Interview_Record — 仅记录已知的 inviting 元数据(模型/时长/形式 + login
//   URL 暂存到 recording_url),其余 start_time/end_time/notes/result 留空,
//   等真正的面试发生后由下游 agent 或 HSM 在同一 PK 上 upsert 补齐。

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asNumberOrNull,
  asIsoDateOrNull,
  type WriteResult,
} from './_helpers';

export type WriteInterviewRecordInput = {
  interview_record_id: string;
  interview_model_id?: string | null;
  application_id?: string | null;
  interviewer_employee_id?: string | null;
  /** 我司面试 / 客户面试. AO/GoHire AI 视频面试默认 '我司面试'(早期筛). */
  interview_type?: string | null;
  /** '一面' | '二面' | …;default '一面'. */
  interview_round?: string | null;
  start_time?: string | Date | null;
  end_time?: string | Date | null;
  duration_minutes?: number | null;
  /** '视频面' / 'AI视频面试' / '电话' / '现场';邀请阶段用 'AI视频面试'. */
  interview_mode?: string | null;
  /**
   * 邀请阶段:暂存 GoHire 给候选人的 login_url(候选人侧入口);
   * 面试结束后会被 GoHire 回调写成真实录像 URL,同 PK upsert 覆盖即可。
   */
  recording_url?: string | null;
  raw_interview_notes?: string | null;
  candidate_behavior_notes?: string | null;
  tech_gaps_identified?: string[] | null;
  golden_30_call_status?: boolean | null;
  interview_result?: string | null;
};

export async function writeInterviewRecordInstance(
  input: WriteInterviewRecordInput,
): Promise<WriteResult> {
  const payload = compact({
    interview_record_id: input.interview_record_id,
    interview_model_id: nonEmptyString(input.interview_model_id),
    application_id: nonEmptyString(input.application_id),
    interviewer_employee_id: nonEmptyString(input.interviewer_employee_id),
    interview_type: nonEmptyString(input.interview_type),
    interview_round: nonEmptyString(input.interview_round),
    start_time: asIsoDateOrNull(input.start_time),
    end_time: asIsoDateOrNull(input.end_time),
    duration_minutes: asNumberOrNull(input.duration_minutes),
    interview_mode: nonEmptyString(input.interview_mode),
    recording_url: nonEmptyString(input.recording_url),
    raw_interview_notes: nonEmptyString(input.raw_interview_notes),
    candidate_behavior_notes: nonEmptyString(input.candidate_behavior_notes),
    tech_gaps_identified:
      Array.isArray(input.tech_gaps_identified) && input.tech_gaps_identified.length
        ? input.tech_gaps_identified.filter((s) => typeof s === 'string' && s.trim())
        : undefined,
    golden_30_call_status:
      typeof input.golden_30_call_status === 'boolean' ? input.golden_30_call_status : undefined,
    interview_result: nonEmptyString(input.interview_result),
  });

  return safeWriteInstance('Interview_Record', payload);
}
