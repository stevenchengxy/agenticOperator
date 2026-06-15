// lib/monitor-step-descriptor.ts
//
// 把 Inngest 内部 step name(如 `write-comm-log-cbcf69a4-4e32-...` 或自带 hash
// `0737c22d3bfae812339732d14d8c7d...`)翻译成监控页给用户看的业务语义名 + 数据
// 流向标识. **不暴露底层存储/服务实现**(Neo4j / Allmeta / SQLite 等内部细节
// 一律不出现在 label/fromTo 上).
//
// 单独抽到 lib/ 是因为这个 helper 同时被:
//   - components/workflow-agents/RunDetailDrawer.tsx (监控页 → run 详情抽屉)
//   - components/monitor/FlowDetailContent.tsx        (工作流页 → 因果链详情)
// 两个 UI 入口共用. 保持一致性,改一次两处受益.

export type StepDescriptor = {
  /** 业务语义名 e.g. "回查候选人简历正文". 给用户看的主标题. */
  label: string;
  /** 数据流向 e.g. "候选人数据库 → 智能体". 用业务概念表达, 不提具体存储. */
  fromTo?: string;
  /** 分组 emoji + tag, 给视觉分类用. */
  group?: string;
};

// ── Agent file-log event kind → 中文标签(2026-05-27) ──────────────────────
//
// 审计页"运行完整日志" + 监控页 RunTrace 的「智能体完整日志」共用. 把 fileLogger
// 写的 kind(handler.start / llm.request / api.RoboHire.parseResume / ...)翻译成
// 业务语义中文名. 覆盖所有已知 kind + api.* / rule-fetch.* 前缀兜底 + 友好 fallback.

const LOG_KIND_LABEL: Record<string, string> = {
  "handler.start": "▶ 开始处理",
  "handler.raw_input": "📥 完整入参 (上游 → 智能体)",
  "handler.done": "✅ 处理完成",
  "handler.error": "❌ 处理出错",
  "backfill.resume.ok": "🔄 回查简历正文",
  "backfill.jd.ok": "🔄 回查 JD 文本",
  "emit.invitation-sent": "📡 回发「邀约已送达」",
  "emit.invitation-failed": "📡 回发「邀约失败」",
  "emit.resume-processed": "📡 回发「简历已解析」",
  "emit.match-event": "📡 回发「匹配结果」",
  "save-candidate.ok": "💾 保存候选人 + 简历",
  "save-candidate.failed": "❌ 保存候选人失败",
  "step.start": "▶ 步骤开始",
  "step.end": "■ 步骤结束(含判定结果)",
  "diag.invite-input.preview": "🔎 邀约入参预览",
  "llm.request": "🧠 大模型入参 (prompt)",
  "llm.response": "🧠 大模型出参 (回复)",
  "llm.failed": "❌ 大模型调用失败",
  "runRuleCheck.start": "▶ 规则检查开始",
  "rule-fetch.failed": "❌ 规则拉取失败",
  "rule-fetch.result": "📋 规则拉取结果",
  "rule-fetch.client-resolution": "🔎 解析客户名",
  "rule-fetch.department-resolution": "🔎 解析事业群",
  "match.input": "📥 匹配入参",
};

/**
 * fileLogger event kind → 友好中文标签. 未知 kind 走前缀兜底:
 *   api.RoboHire.X  → 🌐 调用外部面试服务
 *   api.lookup-*    → 🔎 查询实例库
 *   api.fetch-*     → 📋 拉取数据
 *   pg.* / partner  → 💾 数据库
 *   其它 api.*      → 🌐 外部调用
 */
export function describeLogKind(kind: string | null | undefined): string {
  // `kind` arrives from JSONL log lines parsed with an unchecked cast, so a
  // line missing the field is `undefined` at runtime despite the type. Guard
  // before any string op (was crashing the monitor RunTrace on such rows).
  if (typeof kind !== 'string' || kind === '') return '📄 日志事件';
  if (LOG_KIND_LABEL[kind]) return LOG_KIND_LABEL[kind];
  const k = kind.toLowerCase();
  if (k.startsWith('api.robohire')) return '🌐 调用外部面试/解析服务';
  if (k.startsWith('api.lookup')) return '🔎 查询实例库';
  if (k.startsWith('api.fetch')) return '📋 拉取规则/数据';
  if (k.startsWith('api.allmeta') || k.includes('ontology')) return '💾 写/读实例库';
  if (k.startsWith('api.')) return '🌐 外部调用';
  if (k.startsWith('pg.') || k.includes('partner-pg')) return '💾 数据库操作';
  return kind;
}

export function describeStep(name: string | null | undefined): StepDescriptor {
  // Same untyped-source caveat as describeLogKind: never assume a string.
  if (typeof name !== 'string' || name === '') return { label: '步骤' };
  const n = name.toLowerCase();

  // ── interview-inviter-agent ──────────────────────────────────────
  if (n.startsWith('backfill-resume')) {
    return { label: '回查候选人简历正文', fromTo: '候选人数据库 → 智能体', group: '🔄 数据回查' };
  }
  if (n.startsWith('backfill-jd')) {
    return { label: '回查岗位 JD 文本', fromTo: '岗位数据库 → 智能体', group: '🔄 数据回查' };
  }
  if (n.startsWith('invite-')) {
    return { label: '调用外部面试服务发出邀约', fromTo: '智能体 → 外部面试服务', group: '📤 外部服务' };
  }
  if (n.startsWith('write-comm-log')) {
    return { label: '记录沟通日志', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('write-interview-record')) {
    return { label: '记录面试预约', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('update-invitation-pg')) {
    return { label: '更新面试邀约状态', fromTo: '智能体 → 邀约状态库', group: '💾 持久化' };
  }
  if (n.startsWith('emit-invitation-sent') || n.startsWith('emit-invitation-failed')) {
    const ok = n.includes('sent');
    return {
      label: ok ? '回发"邀约已送达"事件' : '回发"邀约失败"事件',
      fromTo: '智能体 → 合作方',
      group: '📡 事件回发',
    };
  }

  // ── resume-parser-agent ──────────────────────────────────────────
  if (n.startsWith('download-and-parse')) {
    return { label: '下载 PDF 简历并解析', fromTo: '文件存储 → 智能体 → 解析服务', group: '📤 外部服务' };
  }
  if (n === 'save-candidate' || n.startsWith('save-candidate-')) {
    return { label: '保存候选人 + 简历', fromTo: '智能体 → 候选人数据库', group: '💾 持久化' };
  }
  if (n.startsWith('write-candidate-neo4j')) {
    return { label: '记录候选人实例', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('write-resume-neo4j')) {
    return { label: '记录简历实例', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('write-application-neo4j')) {
    return { label: '记录应聘实例', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('emit-resume-processed')) {
    return { label: '回发"简历已解析"事件', fromTo: '智能体 → 下游智能体 + 合作方', group: '📡 事件回发' };
  }

  // ── rule-check-agent ─────────────────────────────────────────────
  if (n.startsWith('fetch-parsed-resume')) {
    return { label: '回查已解析简历', fromTo: '候选人数据库 → 智能体', group: '🔄 数据回查' };
  }
  if (n.startsWith('fetch-requirement')) {
    return { label: '回查岗位需求详情', fromTo: '岗位数据库 → 智能体', group: '🔄 数据回查' };
  }
  if (n.startsWith('write-jr-neo4j')) {
    return { label: '镜像岗位实例', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('rule-check-')) {
    return { label: '运行规则检查 (AI)', fromTo: '智能体 → AI 模型', group: '🧠 AI 推理' };
  }
  if (n.startsWith('write-cmr-')) {
    return { label: '记录匹配结果实例', fromTo: '智能体 → 实例库', group: '💾 持久化' };
  }
  if (n.startsWith('persist-cmr-pg')) {
    return { label: '保存匹配结果(失败路径)', fromTo: '智能体 → 匹配结果库', group: '💾 持久化' };
  }
  if (n.startsWith('emit-passed') || n.startsWith('emit-bypass-passed')) {
    return { label: '回发"规则通过"事件', fromTo: '智能体 → 下游智能体', group: '📡 事件回发' };
  }
  if (n.startsWith('emit-failed')) {
    return { label: '回发"规则未通过"事件', fromTo: '智能体 → 合作方', group: '📡 事件回发' };
  }
  if (n.startsWith('write-rule-check-audit')) {
    return { label: '写规则检查审计日志', fromTo: '智能体 → 审计库', group: '💾 持久化' };
  }

  // ── match-resume / create-jd 等其它 ─────────────────────────────
  if (n.startsWith('match-resume') || n.startsWith('save-match')) {
    return { label: '运行简历-岗位匹配', fromTo: '智能体 → AI 模型 / 匹配结果库', group: '📤 外部服务' };
  }

  // ── Inngest sendEvent 内部 hash 化的 step ID ────────────────────
  if (/^[0-9a-f]{8,}/i.test(name)) {
    return { label: '发送事件', fromTo: '智能体 → 事件总线', group: '📡 事件回发' };
  }

  // ── fallback: 原 name 作为 label(技术 step,e.g. 调试/测试 step)
  return { label: name };
}
