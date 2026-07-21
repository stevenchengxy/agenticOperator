// Write Communication_Log instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json) Communication_Log:
//   communication_log_id (PK), application_id, message_sender, message_receiver,
//   interaction_type, message_content, content_summary, timestamp
//
// 当前调用点:interviewInviterAgent 在 RoboHire 邀请发出后写一条
//   interaction_type='面试邀请' 的日志,记录登陆/二维码链接与发送时间。
// 关联 Application(application_id),便于在人才详情里聚合时间线。

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asIsoDateOrNull,
  type WriteResult,
} from './_helpers';

export type WriteCommunicationLogInput = {
  communication_log_id: string;
  application_id?: string | null;
  message_sender?: string | null;
  message_receiver?: string | null;
  interaction_type?: string | null;
  message_content?: string | null;
  content_summary?: string | null;
  /** ISO string / Date / 已经字符串化的时间;默认写入时间. */
  timestamp?: string | Date | null;
};

export async function writeCommunicationLogInstance(
  input: WriteCommunicationLogInput,
): Promise<WriteResult> {
  const payload = compact({
    communication_log_id: input.communication_log_id,
    application_id: nonEmptyString(input.application_id),
    message_sender: nonEmptyString(input.message_sender),
    message_receiver: nonEmptyString(input.message_receiver),
    interaction_type: nonEmptyString(input.interaction_type),
    message_content: nonEmptyString(input.message_content),
    content_summary: nonEmptyString(input.content_summary),
    timestamp: asIsoDateOrNull(input.timestamp ?? new Date()),
  });

  return safeWriteInstance('Communication_Log', payload);
}
