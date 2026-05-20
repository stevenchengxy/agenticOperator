// Write Application instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json) Application has 25 fields.
// AO 只填 candidate-resume-application 三方关联 + 流程初始状态字段;
// 其余(stage 跃迁 / sla / decision 等)由 HSM / dispatcher 在后续阶段补全。

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  type WriteResult,
} from './_helpers';

export type WriteApplicationInput = {
  application_id: string;
  client_id?: string | null;
  job_requisition_id: string;
  candidate_id: string;
  resume_id?: string | null;
  recruiter_employee_id?: string | null;
  /** Initial status from saveCandidateToPartnerPg (default 'active'). */
  status?: string;
  /** Initial stage (default 'resume_received'). */
  stage?: string;
};

export async function writeApplicationInstance(
  input: WriteApplicationInput,
): Promise<WriteResult> {
  const payload = compact({
    application_id: input.application_id,
    client_id: nonEmptyString(input.client_id),
    job_requisition_id: input.job_requisition_id,
    candidate_id: input.candidate_id,
    resume_id: nonEmptyString(input.resume_id),
    recruiter_employee_id: nonEmptyString(input.recruiter_employee_id),
    status: input.status ?? 'active',
    stage: input.stage ?? 'resume_received',
  });

  return safeWriteInstance('Application', payload);
}
