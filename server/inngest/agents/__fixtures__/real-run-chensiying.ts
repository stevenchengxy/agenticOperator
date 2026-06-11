// 真实 run 夹具 —— 候选人「陈思」整条链路(同一 candidate/resume/JR):
//   Resume Parser 01KTKGHGYW27VZPT47S5RZY24C → Rule Check 01KTKGJ0QC8PQCTHZ6FVDVKFY4
//   → Match Resume 01KTKGJ5D518SMPXKET7HMSSRA
//
// anchors / JR 字段都是该 run 的**真实值**(从 logs + partner-pg 取);简历做了
// 最小化 + 脱敏(电话/邮箱替换为假值),但保留 rule-check 看到的结构。
// 岗位是腾讯 CDG 事业群(client_department.dept_name='CDG'),但 sd_org_name 是
// 英文 'Technology' 解析不出 bg —— 正是触发 client_department 兜底修复的场景。
// 候选人是字节跳动行政文秘(无腾讯经历)→ CDG 回流冷冻规则 10-42 应被「抓取」
// 但「不触发」(NOT_TRIGGERED),不该 FAIL 她。

export const REAL_ANCHORS = {
  candidate_id: 'd52a569b-65ff-465a-b491-dd4d44fda112',
  resume_id: '287178ea-a2a5-4a8b-8d2e-40c8ee9f9ac3',
  upload_id: '3e02e864-0d7f-dfa8-3e49-a5d0b4bbd749',
  employee_id: '0000023911',
  job_requisition_id: 'JRQ-a5f6029a-8af8-4f9a-81e8-7c594cc52aa8-TEST334',
  client_id: 'a5f6029a-8af8-4f9a-81e8-7c594cc52aa8',
  client_department_id: '44cd4ad4-35af-4abd-b418-209491d16789',
  sourcing_channel_id: '02001034',
} as const;

/** 最小化 + 脱敏的真实简历(字节跳动行政文秘,无腾讯经历)。 */
export const REAL_PARSED_RESUME = {
  name: '陈思',
  experience: [
    { company: '字节跳动（深圳）科技有限公司', title: '行政文秘专员', startDate: '2024.03', endDate: '至今' },
    { company: '深圳本技有限公司', title: '行政助理', startDate: '2021.07', endDate: '2024.02' },
  ],
  education: [{ school: '北京师范大学', degree: '本科', major: '汉语言文学（师范）', endDate: '2021.06' }],
  skills: { technical: ['Excel 数据透视', '公文写作'], tools: ['飞书', '企业微信', '腾讯文档'] },
  phone: '138****0000', // 脱敏
  email: 'redacted@example.com', // 脱敏
  rawText:
    '陈思 · 行政文秘 · 字节跳动（深圳）科技有限公司 2024.03-至今 · 深圳本技有限公司 2021.07-2024.02 · 北京师范大学 汉语言文学',
};

/** 真实 RESUME_PROCESSED envelope(上游 RAAS → AO 的入站事件)。 */
export function realResumeProcessedEvent() {
  return {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: REAL_ANCHORS.upload_id,
      candidate_id: REAL_ANCHORS.candidate_id,
      resume_id: REAL_ANCHORS.resume_id,
      employee_id: REAL_ANCHORS.employee_id,
      employeeId: REAL_ANCHORS.employee_id,
      job_requisition_id: REAL_ANCHORS.job_requisition_id,
      client_id: null, // 真实事件里 client_id 为 null,靠 JR 解析出腾讯
      filename: '陈思颖_简历.pdf',
      bucket: 'recruit-resume-raw',
      objectKey: `2026/06/${REAL_ANCHORS.upload_id}-陈思颖_简历.pdf`,
      sourcing_channel_id: REAL_ANCHORS.sourcing_channel_id,
      parsed: { data: REAL_PARSED_RESUME },
    },
  };
}

/** 真实 partner-pg job_requisition detail(getRequirementDetail 形状)。 */
export function realJobRequisitionDetail() {
  return {
    job_requisition_id: REAL_ANCHORS.job_requisition_id,
    client_id: REAL_ANCHORS.client_id,
    client_department_id: REAL_ANCHORS.client_department_id,
    csi_department_id: 'CSI-DEPT-001',
    client_job_title: '测试岗位',
    status: 'recruiting',
    must_have_skills: [],
    job_responsibility: '行政文秘相关',
    // 真实:英文 org 名,deriveBgFromOrgName 解析不出 bg → 必须靠 client_department 兜底
    specification: { sd_org_name: 'Technology' },
  };
}

type ActionRule = {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: string;
  applicableDepartment: string;
  executor: 'Agent';
  enforcementLevel: 'mandatory';
  failurePolicy: 'block';
  standardizedLogicRule: string;
  relatedEntities: string[];
};

const rule = (
  id: string,
  client: string,
  dept: string,
  name: string,
): ActionRule => ({
  id,
  specificScenarioStage: '简历匹配',
  businessLogicRuleName: name,
  applicableClient: client,
  applicableDepartment: dept,
  executor: 'Agent',
  enforcementLevel: 'mandatory',
  failurePolicy: 'block',
  standardizedLogicRule: `${name}（规则逻辑占位,夹具用）`,
  relatedEntities: ['候选人 (Candidate)', '招聘岗位 (Job_Requisition)'],
});

/**
 * ontology API `ruleCheckForMatchResume/rules` 为该 run 返回的 11 条候选规则
 * (真实 id + 客户/部门;executor=Agent + enforcementLevel=mandatory 与线上一致)。
 * 期望筛选结果(client=腾讯, bg=CDG):
 *   选中(5):10-25 10-26(通用) · 10-45 10-46(腾讯/N-A) · 10-42(腾讯/CDG)
 *   排除(6):10-43 10-56(腾讯/IEG≠CDG) · 10-49 10-32 10-34 10-51(字节≠腾讯)
 */
export const REAL_ACTION_RULES: ActionRule[] = [
  rule('10-25', '通用', 'N/A', '华为荣耀竞对与客户互不挖角红线'),
  rule('10-26', '通用', 'N/A', 'OPPO小米竞对与客户互不挖角红线'),
  rule('10-49', '字节', 'N/A', '字节正编员工回流标记与凭证校验'),
  rule('10-45', '腾讯', 'N/A', '腾讯正编转外包回流标记'),
  rule('10-42', '腾讯', 'CDG', 'CDG事业群6个月回流冷冻期绝对拦截'),
  rule('10-43', '腾讯', 'IEG', 'IEG工作室回流候选人互斥标记'),
  rule('10-32', '字节', 'N/A', '岗位冷冻期规则'),
  rule('10-46', '腾讯', 'N/A', '腾讯正编转外包回流凭证校验'),
  rule('10-34', '字节', 'N/A', '字节跳动友商非BPO外包经历回流冷冻期拦截'),
  rule('10-56', '腾讯', 'IEG', '腾娱互动子公司回流冷冻期拦截'),
  rule('10-51', '字节', 'N/A', '字节正编回流客户BP确认放行'),
];
