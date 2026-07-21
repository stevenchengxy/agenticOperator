// lib/partner-pg/interview-invitations.ts
//
// 2026-05-25: AO interviewInviterAgent dual-write 到 partner-pg interview_invitation
// 表. RaaS 在 emit INTERVIEW_INVITATION_REQUESTED 之前先 INSERT 一行(状态
// 'requested', correlation_id 即本次邀请的业务关联键). AO 调完 RoboHire
// 成功后,按 correlation_id 把同一行 UPDATE 成 status='sent' + GoHire 回执
// 字段(login_url / qrcode_url / gohire_user_id / request_introduction_id /
// gohire_invite_log).
//
// 设计要点:
//   - 由 RaaS 负责 INSERT, AO 只 UPDATE — 避免 AO/RaaS 重复 INSERT 抢主键
//   - UPDATE ... WHERE correlation_id = $1 天然幂等(重发同 correlation_id
//     得到一样的最终行)
//   - rowCount=0 不是 fatal — 可能 RaaS 还没写 / correlation_id 拼错;
//     caller 当 soft-fail,继续 emit _SENT(候选人确实拿到了 login_url)
//   - gohire_invite_log 字段存 RoboHire 响应的"原始 JSON 字符串" — 用
//     JSON.stringify 一次性序列化,**不要** parse 后重排 / cherry-pick 字段
//
// 与 lib/partner-pg/parsed-resume.ts / candidates.ts 风格一致:
//   - 复用 client.ts 的 `query` helper(自动走 apiCall logger + 失败 banner)
//   - 错误捕获返 { ok: false, error } 而不是 throw,让 agent step 决定 retry 策略

import { query } from './client';

export type MarkInterviewInvitationSentFields = {
  login_url: string | null;
  qrcode_url: string | null;
  /** RoboHire data.user_id(GoHire 端的用户主键). number | string 透传. */
  gohire_user_id: string | number | null;
  request_introduction_id: string | null;
  /**
   * RoboHire 响应的"原始 JSON 字符串". 由 caller 用 `JSON.stringify(roboHireResponse)`
   * 序列化得到, 不要中途 parse 再 stringify — V8 保证 JSON.parse → JSON.stringify
   * 顺序稳定, 但 cherry-pick 后重组会丢字段 / 改顺序.
   */
  gohire_invite_log: string;
};

export type MarkInterviewInvitationSentResult =
  | { ok: true; updated: boolean }
  | { ok: false; error: string };

/**
 * UPDATE interview_invitation SET status='sent' + GoHire 回执 WHERE correlation_id=$1.
 *
 * 返回:
 *   { ok: true, updated: true }  — UPDATE 命中 1 行(典型成功路径)
 *   { ok: true, updated: false } — UPDATE 命中 0 行(correlation_id 未 INSERT;
 *                                  RaaS 端可能有 bug, agent 应 warn 但仍 emit _SENT)
 *   { ok: false, error }         — SQL 抛错(table 不存在 / 连接挂 / 权限)
 */
export async function markInterviewInvitationSent(
  correlationId: string,
  fields: MarkInterviewInvitationSentFields,
): Promise<MarkInterviewInvitationSentResult> {
  if (!correlationId) {
    return { ok: false, error: 'missing correlation_id' };
  }
  const sql = `
    UPDATE interview_invitation
    SET status = 'sent',
        login_url = $2,
        qrcode_url = $3,
        gohire_user_id = $4,
        request_introduction_id = $5,
        gohire_invite_log = $6,
        updated_at = NOW()
    WHERE correlation_id = $1
    RETURNING interview_invitation_id
  `;
  try {
    const r = await query(sql, [
      correlationId,
      fields.login_url,
      fields.qrcode_url,
      // pg driver 接受 number | string, bigint 列也兼容; null 显式透传.
      fields.gohire_user_id,
      fields.request_introduction_id,
      fields.gohire_invite_log,
    ]);
    return { ok: true, updated: (r.rowCount ?? 0) > 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
