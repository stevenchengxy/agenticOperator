// Static field descriptions for all 22 agents in AGENT_MAP.
// Used by AgentDetailPanel to display Description / Input / Processing Logic / Output
// sections matching the leader's RAAS Live Ops reference design.

export type AgentDescription = {
  description: string;       // 1-2 sentence summary (~50-80 chars)
  input: string;             // what triggers / feeds this agent
  output: string;            // what it produces
  processingLogic: string[]; // 3-5 numbered Chinese steps
};

export const AGENT_DESCRIPTIONS: Record<string, AgentDescription> = {
  ReqSync: {
    description: '从客户 RMS 系统同步招聘需求，支持定时轮询与 Webhook 两种触发模式。',
    input: '客户 RMS 的需求 Webhook 推送或 SCHEDULED_SYNC 定时事件。',
    output: 'REQUIREMENT_SYNCED — 标准化后的招聘需求 payload。',
    processingLogic: [
      '接收 SCHEDULED_SYNC 定时信号或客户 Webhook',
      '调用客户侧 RMS API 拉取最新需求列表',
      '将不同 RMS 的字段统一映射到内部标准 schema',
      '对比上次同步结果，过滤重复或无变化条目',
      'em.publish REQUIREMENT_SYNCED 通知下游 ReqAnalyzer',
    ],
  },

  ManualEntry: {
    description: '当系统无法自动解析需求时，由 HSM 手工录入关键字段完成补全。',
    input: 'CLARIFICATION_INCOMPLETE — 自动分析阶段判定信息不足触发。',
    output: 'REQUIREMENT_LOGGED — 经人工补全的完整需求记录。',
    processingLogic: [
      '收到 CLARIFICATION_INCOMPLETE 事件，打开 HITL 待办任务',
      'HSM 在交付界面核实并填写缺失字段',
      '对比客户原始 RMS 数据验证一致性',
      '保存需求草稿并 em.publish REQUIREMENT_LOGGED',
    ],
  },

  ReqAnalyzer: {
    description: '对同步或手工录入的需求进行结构化分析，提取硬性条件、加分项与背景要求。',
    input: 'REQUIREMENT_SYNCED 或 REQUIREMENT_LOGGED — 原始需求 payload。',
    output: 'ANALYSIS_COMPLETED — 结构化需求分析结果，含硬性/软性/负向三层标签。',
    processingLogic: [
      '解析需求文本，识别职位类型与行业背景',
      '抽取硬性要求（学历、证书、年限）',
      '标注加分项与文化契合度偏好',
      '标记冲突或模糊字段，决定是否需要澄清',
      'em.publish ANALYSIS_COMPLETED 或 ANALYSIS_BLOCKED',
    ],
  },

  Clarifier: {
    description: '当分析结果存在模糊或缺失字段时，与客户 HM 确认并补全关键信息。',
    input: 'ANALYSIS_COMPLETED — ReqAnalyzer 判定需要进一步澄清。',
    output: 'CLARIFICATION_READY 或 CLARIFICATION_INCOMPLETE — 澄清完成或仍有缺口。',
    processingLogic: [
      '识别需要补全的字段及优先级',
      '生成结构化澄清问卷发送给客户 HM',
      '等待 HM 回复并解析答案',
      '将补全结果写入需求 schema',
      'em.publish CLARIFICATION_READY 或触发 ManualEntry',
    ],
  },

  JDGenerator: {
    description: '基于完整需求与画像，自动生成符合客户品牌语气的职位描述。',
    input: 'CLARIFICATION_READY 或 JD_REJECTED — 需求就绪或审批退回重新生成。',
    output: 'JD_GENERATED — 结构化 JD 草稿，含职责、要求、福利三段式。',
    processingLogic: [
      '读取最终确认的需求分析结果',
      '匹配客户历史 JD 语气与格式模板',
      '调用 LLM 生成职责、任职要求、薪酬福利',
      '执行品牌合规检查（禁用词、EEO 声明）',
      'em.publish JD_GENERATED 提交 JDReviewer 审批',
    ],
  },

  JDReviewer: {
    description: 'HSM 对 AI 生成的 JD 进行人工审核，确保内容准确并符合客户期望。',
    input: 'JD_GENERATED — JDGenerator 输出的草稿 JD。',
    output: 'JD_APPROVED 或 JD_REJECTED — 批准上线或退回修改。',
    processingLogic: [
      '在 HITL 界面展示 JD 草稿及需求对照',
      'HSM 检查职责描述与需求分析的匹配度',
      '校验薪酬区间及法律合规条款',
      '提交审核决定并留存审批记录',
    ],
  },

  TaskAssigner: {
    description: '根据 JD 审批结果，将发布任务分配给对应渠道运营专员或自动化 Publisher。',
    input: 'JD_APPROVED — JDReviewer 批准的 JD。',
    output: 'TASK_ASSIGNED — 渠道发布任务，含目标渠道列表与优先级。',
    processingLogic: [
      '读取客户渠道订阅配置',
      '按职位类型与预算匹配最优渠道组合',
      '生成渠道发布任务单并分配执行方',
      'em.publish TASK_ASSIGNED 通知 Publisher',
    ],
  },

  Publisher: {
    description: '将已审批的 JD 自动发布到 BOSS 直聘、猎聘、LinkedIn 等多个渠道。',
    input: 'TASK_ASSIGNED — TaskAssigner 下发的渠道发布任务。',
    output: 'CHANNEL_PUBLISHED 或 CHANNEL_PUBLISHED_FAILED — 各渠道发布状态。',
    processingLogic: [
      '读取渠道 API 配置与认证凭证',
      '格式化 JD 内容适配各渠道字段要求',
      '并发调用各渠道 API 提交发布请求',
      '轮询确认发布状态（最多 3 次重试）',
      'em.publish CHANNEL_PUBLISHED 或 CHANNEL_PUBLISHED_FAILED',
    ],
  },

  ManualPublish: {
    description: '当自动发布失败时，由运营专员手动完成渠道上线操作。',
    input: 'CHANNEL_PUBLISHED_FAILED — Publisher 自动发布失败。',
    output: 'CHANNEL_PUBLISHED — 人工确认渠道已上线。',
    processingLogic: [
      '收到失败通知，创建 HITL 待办任务',
      '运营专员登录渠道后台手动上传 JD',
      '在系统内确认发布成功并填写渠道链接',
      'em.publish CHANNEL_PUBLISHED 推进流程',
    ],
  },

  ResumeCollector: {
    description: '从已发布渠道定时采集投递简历，支持 Webhook 推送与轮询两种模式。',
    input: 'CHANNEL_PUBLISHED — 渠道上线后开始监听新投递。',
    output: 'RESUME_DOWNLOADED — 原始简历文件及元数据，存入对象存储。',
    processingLogic: [
      '监听渠道 Webhook 或定时轮询简历列表',
      '下载简历文件（PDF / Word / 渠道结构化数据）',
      '上传到内部对象存储并生成唯一 resumeId',
      '记录投递时间、来源渠道、候选人基础信息',
      'em.publish RESUME_DOWNLOADED 触发解析流程',
    ],
  },

  ResumeParser: {
    description: '对简历文件进行结构化解析，提取教育、经历、技能等字段，同时执行查重与黑名单核查。',
    input: 'RESUME_DOWNLOADED — 原始简历文件 ID 及对象存储路径。',
    output: 'RESUME_PROCESSED — 结构化候选人画像 JSON，或 RESUME_PARSE_ERROR。',
    processingLogic: [
      '读取简历文件，识别格式（PDF / DOCX / 结构化 JSON）',
      '调用解析模型提取基本信息、学历、工作经历、技能标签',
      '比对黑名单数据库及历史投递记录执行查重',
      '生成候选人标准化画像并计算质量评分',
      'em.publish RESUME_PROCESSED 或 RESUME_PARSE_ERROR',
    ],
  },

  ResumeFixer: {
    description: '当自动解析失败或质量不达标时，由运营专员手动补全候选人结构化信息。',
    input: 'RESUME_PARSE_ERROR — ResumeParser 解析失败或字段缺失过多。',
    output: 'RESUME_PROCESSED — 经人工补全的结构化候选人画像。',
    processingLogic: [
      '收到 RESUME_PARSE_ERROR，创建 HITL 任务',
      '在界面展示原始简历与当前解析结果对照',
      '运营专员手动填写或修正缺失字段',
      '保存修正结果并触发二次质量校验',
      'em.publish RESUME_PROCESSED 恢复流程',
    ],
  },

  Matcher: {
    description: '将候选人画像与 JD 需求进行多维度匹配评分，输出通过 / 拒绝 / 面试三种结果。',
    input: 'RESUME_PROCESSED — 结构化候选人画像。',
    output: 'MATCH_PASSED_NEED_INTERVIEW、MATCH_PASSED_NO_INTERVIEW 或 MATCH_FAILED。',
    processingLogic: [
      '加载 JD 分析结果中的硬性/软性/负向条件',
      '逐项评估候选人画像，计算各维度得分',
      '应用硬性条件过滤（任一不符即拒绝）',
      '综合加分项与软性条件计算最终匹配分',
      '按分段阈值 em.publish 对应匹配结果事件',
    ],
  },

  MatchReviewer: {
    description: '对自动匹配失败的候选人进行人工复审，可手动推进或确认淘汰。',
    input: 'MATCH_FAILED — Matcher 判定不符合要求的候选人。',
    output: '人工决定复议通过或维持淘汰（无事件，通过 HITL 任务状态驱动）。',
    processingLogic: [
      '收到 MATCH_FAILED 触发 HITL 复审任务',
      '展示候选人画像与各项评分明细',
      '招聘专员判断是否有特殊业务背景需考虑',
      '复议通过则手动触发面试邀约；否则确认淘汰存档',
    ],
  },

  InterviewInviter: {
    description: '向通过匹配的候选人自动发送面试邀请，协调时间并同步给内部面试官。',
    input: 'MATCH_PASSED_NEED_INTERVIEW — Matcher 判定候选人需进入面试环节。',
    output: 'INTERVIEW_INVITATION_SENT — 面试邀请已发出，含时间与链接。',
    processingLogic: [
      '生成候选人专属面试预约链接',
      '调用邮件/短信通道发送面试邀请',
      '同步面试日程到内部面试官日历',
      'em.publish INTERVIEW_INVITATION_SENT',
    ],
  },

  AIInterviewer: {
    description: '通过 AI 对话完成结构化初面，评估候选人沟通能力与岗位匹配度。',
    input: 'INTERVIEW_INVITATION_SENT — 候选人接受邀请后进入 AI 面试流程。',
    output: 'AI_INTERVIEW_COMPLETED — 面试录音、转录及初步评分报告。',
    processingLogic: [
      '按岗位类型加载面试题库与评分维度',
      '引导候选人完成结构化对话（15-25 分钟）',
      '实时转录并分析关键词与行为指标',
      '生成面试报告，含亮点、风险项与总体评分',
      'em.publish AI_INTERVIEW_COMPLETED',
    ],
  },

  Evaluator: {
    description: '综合 AI 面试报告、简历质量与匹配得分，生成候选人最终综合评估报告。',
    input: 'AI_INTERVIEW_COMPLETED — AIInterviewer 输出的面试报告。',
    output: 'EVALUATION_PASSED 或 EVALUATION_FAILED — 综合评估通过或淘汰。',
    processingLogic: [
      '读取 AI 面试报告、匹配得分、简历质量评分',
      '按岗位权重加权计算综合评分',
      '比对客户设定的录用门槛',
      '生成综合评估报告供后续推荐包使用',
      'em.publish EVALUATION_PASSED 或 EVALUATION_FAILED',
    ],
  },

  ResumeRefiner: {
    description: '对通过评估的候选人简历进行格式优化，使其符合客户门户提交标准。',
    input: 'EVALUATION_PASSED 或 MATCH_PASSED_NO_INTERVIEW — 评估通过的候选人。',
    output: 'RESUME_OPTIMIZED — 标准化格式的候选人简历文件。',
    processingLogic: [
      '读取候选人原始简历与解析结构',
      '按客户门户格式要求重排版面与字段',
      '去除敏感信息（如联系方式 / 照片）',
      '生成 PDF 输出并存入对象存储',
      'em.publish RESUME_OPTIMIZED',
    ],
  },

  PackageBuilder: {
    description: '将优化后简历、评估报告、匹配摘要打包生成完整的候选人推荐包。',
    input: 'RESUME_OPTIMIZED — ResumeRefiner 输出的标准化简历。',
    output: 'PACKAGE_GENERATED 或 PACKAGE_MISSING_INFO — 推荐包就绪或信息缺失。',
    processingLogic: [
      '聚合候选人简历、评估报告、面试摘要',
      '按客户模板生成推荐包文档（PDF/DOCX）',
      '校验所有必填字段是否完整',
      'em.publish PACKAGE_GENERATED 或 PACKAGE_MISSING_INFO',
    ],
  },

  PackageFiller: {
    description: '当推荐包信息不完整时，由运营专员手动补全缺失字段并重新生成。',
    input: 'PACKAGE_MISSING_INFO — PackageBuilder 检测到必填字段缺失。',
    output: 'PACKAGE_GENERATED — 经人工补全的完整推荐包。',
    processingLogic: [
      '收到 PACKAGE_MISSING_INFO 创建 HITL 任务',
      '展示当前推荐包及缺失字段列表',
      '运营专员补录缺失信息',
      '触发 PackageBuilder 重新生成推荐包',
    ],
  },

  PackageReviewer: {
    description: 'HSM 对最终推荐包进行质量把关审核，确认后方可提交至客户门户。',
    input: 'PACKAGE_GENERATED — PackageBuilder 生成的候选人推荐包。',
    output: 'PACKAGE_APPROVED — HSM 审批通过，可进入提交阶段。',
    processingLogic: [
      '在 HITL 界面展示推荐包全文及评估摘要',
      'HSM 核实候选人信息与 JD 要求对照',
      '确认薪酬预期与客户预算匹配',
      '提交审批决定并记录审批人与时间戳',
      'em.publish PACKAGE_APPROVED',
    ],
  },

  PortalSubmitter: {
    description: '将已审批的候选人推荐包自动提交到客户 ATS/招聘门户，完成交付闭环。',
    input: 'PACKAGE_APPROVED — PackageReviewer 审批通过的推荐包。',
    output: 'APPLICATION_SUBMITTED 或 SUBMISSION_FAILED — 提交成功或失败告警。',
    processingLogic: [
      '读取客户 ATS 接口配置与认证凭证',
      '按 ATS 字段规范格式化推荐包数据',
      '调用 ATS API 或填写门户表单提交',
      '确认提交回执并记录外部 Application ID',
      'em.publish APPLICATION_SUBMITTED 或 SUBMISSION_FAILED',
    ],
  },

  Chatbot: {
    description: '面向内部操作员的对话助手，支持查询运行状态、触发操作及答疑。',
    input: '操作员自然语言输入，通过 AO 控制台聊天界面触发。',
    output: '结构化回复或操作确认，写入 AgentActivity 审计日志。',
    processingLogic: [
      '解析操作员输入意图（查询 / 操作 / 解释）',
      '检索相关运行、事件或配置数据',
      '生成结构化回复或触发相应操作',
      '记录对话到 AgentActivity 供审计追溯',
    ],
  },
};

export function getAgentDescription(canonicalShort: string): AgentDescription | null {
  return AGENT_DESCRIPTIONS[canonicalShort] ?? null;
}
