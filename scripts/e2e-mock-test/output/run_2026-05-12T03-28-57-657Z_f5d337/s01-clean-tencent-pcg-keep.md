# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,binary 模式应该全部规则 PASS / NOT_APPLICABLE → KEEP/PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | PASS ✓ |
| llm_decision | PASS | PASS |
| must-fail rules | (none) | (none) |
| augmentation injected | yes | no |

## 2. Assertions

- ✅ **decision == expected (PASS)**
- ✅ **llm_decision compatible (PASS)**
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **matchResume called**
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: ### 预筛标签
- **硬性匹配**: 学历(本科)、语言(CET-6 580)、技能(React/TS/Webpac
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=19 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 简历包含两段工作经历：阿里巴巴(2021-03至2024-08)及字节跳动(2018-07至2021-02)，平均每段时长超过1年，无消极空窗期记录。 | 阿里巴巴, 简历包含两段工作经历, 及字节跳动 | 阿里巴巴, 2021-03 | 简历包含两段工作经历, 及字节跳动 | ✓ |
| 10-12 | 出生年份1996，本科毕业年份2018，毕业年龄22岁，符合本科22-23岁基准，偏差为0。 | 出生年份, 本科毕业年份, 毕业年龄 | — | 出生年份, 本科毕业年份 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人提供证书为CET-6 580，满足硬性门槛。 | 岗位要求, 以上, 候选人提供证书为 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 候选人简历已解析并关联至原始需求jr_x99。 | 候选人简历已解析并关联至原始需求 | — | 候选人简历已解析并关联至原始需求 | ✓ |
| 10-25 | 候选人工作经历中不包含华为、荣耀及其关联公司。 | 候选人工作经历中不包含华为, 荣耀及其关联公司 | — | 候选人工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 候选人工作经历中不包含OPPO、小米及其关联公司。 | 候选人工作经历中不包含, 小米及其关联公司, OPPO | — | 候选人工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历本科符合；技能React/TypeScript/Webpack均具备；语言CET-6符合；年龄30岁在25-40范围内。 | 学历本科符合, 技能, 均具备 | CET-6, React | 学历本科符合, 技能 | ✓ |
| 10-54 | 候选人最近一段经历为阿里巴巴，不命中负向要求“外包从业经历超过2年”。 | 候选人最近一段经历为阿里巴巴, 不命中负向要求, 外包从业经历超过 | — | 候选人最近一段经历为阿里巴巴, 不命中负向要求 | ✓ |
| 10-6 | 候选人命中加分项：Next.js, GraphQL。 | Next.js, 候选人命中加分项, Next | Next.js, Next | 候选人命中加分项 | ✓ |
| 10-7 | 期望薪资35k-50k，岗位上限50k，未超过框架上限。 | 期望薪资, 岗位上限, 未超过框架上限 | 35k-50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 候选人外包接受度为“接受”。 | 候选人外包接受度为, 接受 | 接受 | 候选人外包接受度为 | ✓ |
| 10-9 | 毕业2018-06至首份工作2018-07间隔1个月；阿里与字节跳动间隔1个月；均未超过3个月。 | 毕业, 至首份工作, 间隔 | 2018-07 | 毕业, 至首份工作 | ✓ |
| 10-27 | 利益冲突声明为空，未发现腾讯关联亲属。 | 利益冲突声明为空, 未发现腾讯关联亲属 | — | 利益冲突声明为空, 未发现腾讯关联亲属 | ✓ |
| 10-35 | 国籍为中国，不适用外籍通道限制。 | 国籍为中国, 不适用外籍通道限制 | — | 国籍为中国, 不适用外籍通道限制 | ✓ |
| 10-38 | 简历履历中不包含腾讯或腾讯外包工作经历。 | 简历履历中不包含腾讯或腾讯外包工作经历 | — | 简历履历中不包含腾讯或腾讯外包工作经历 | ✓ |
| 10-45 | 不存在腾讯正式岗位工作经历记录。 | 不存在腾讯正式岗位工作经历记录 | — | 不存在腾讯正式岗位工作经历记录 | ✓ |
| 10-47 | 候选人为男性，不触发女性婚育风险审视规则。 | 候选人为男性, 不触发女性婚育风险审视规则 | — | 候选人为男性, 不触发女性婚育风险审视规则 | ✓ |
| 10-40 | 候选人无腾讯历史从业经历，不涉及主动离职回流。 | 候选人无腾讯历史从业经历, 不涉及主动离职回流 | — | 候选人无腾讯历史从业经历, 不涉及主动离职回流 | ✓ |
| 10-53 | 目标岗位归属PCG，符合跳过内部技术面试条件。 | 目标岗位归属, 符合跳过内部技术面试条件, PCG | — | 目标岗位归属, 符合跳过内部技术面试条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_8fa6da",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "PASS",
  "failure_reasons": [],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历包含两段工作经历：阿里巴巴(2021-03至2024-08)及字节跳动(2018-07至2021-02)，平均每段时长超过1年，无消极空窗期记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生年份1996，本科毕业年份2018，毕业年龄22岁，符合本科22-23岁基准，偏差为0。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求CET-6 480以上，候选人提供证书为CET-6 580，满足硬性门槛。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班、倒班或长期出差标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人简历已解析并关联至原始需求jr_x99。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人工作经历中不包含华为、荣耀及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人工作经历中不包含OPPO、小米及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无我司（CSI）历史任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历本科符合；技能React/TypeScript/Webpack均具备；语言CET-6符合；年龄30岁在25-40范围内。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人最近一段经历为阿里巴巴，不命中负向要求“外包从业经历超过2年”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人命中加分项：Next.js, GraphQL。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资35k-50k，岗位上限50k，未超过框架上限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人外包接受度为“接受”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业2018-06至首份工作2018-07间隔1个月；阿里与字节跳动间隔1个月；均未超过3个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "利益冲突声明为空，未发现腾讯关联亲属。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈的亲属关系确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国，不适用外籍通道限制。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历履历中不包含腾讯或腾讯外包工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM针对腾讯历史离场原因的核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "不存在腾讯正式岗位工作经历记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人未被标记为正编转外包受控状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性，不触发女性婚育风险审视规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无腾讯历史从业经历，不涉及主动离职回流。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标岗位归属PCG，符合跳过内部技术面试条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛标签\n- **硬性匹配**: 学历(本科)、语言(CET-6 580)、技能(React/TS/Webpack) 全部通过\n- **加分项**: 命中 Next.js, GraphQL\n- **稳定性**: 履历连续，无长空窗期，平均任职 > 2.5年\n- **流程说明**: 目标事业群 PCG，已标记跳过内部技术面试环节",
  "notifications": []
}
```

## 5. matchResume 调用 — body.resume(注入 augmentation 后)

```
### 预筛标签
- **硬性匹配**: 学历(本科)、语言(CET-6 580)、技能(React/TS/Webpack) 全部通过
- **加分项**: 命中 Next.js, GraphQL
- **稳定性**: 履历连续，无长空窗期，平均任职 > 2.5年
- **流程说明**: 目标事业群 PCG，已标记跳过内部技术面试环节

---

{
  "name": "张三",
  "email": "zhangsan@example.com",
  "phone": "13800000000",
  "location": "上海",
  "birth_date": "1996-05-12",
  "gender": "男",
  "nationality": "中国",
  "marital_status": "已婚已育",
  "summary": "5 年高级前端经验,曾任阿里淘宝高级前端工程师",
  "experience": [
    {
      "title": "高级前端工程师",
      "company": "阿里巴巴",
      "location": "杭州",
      "startDate": "2021-03",
      "endDate": "2024-08",
      "description": "负责淘宝交易链路前端架构;主导 webpack→vite 迁移",
      "highlights": [
        "主导 webpack→vite 迁移",
        "团队规模 8 人"
      ]
    },
    {
      "title": "前端工程师",
      "company": "字节跳动",
      "location": "北京",
      "startDate": "2018-07",
      "endDate": "2021-02",
      "description": "负责抖音电商业务前端开发"
    }
  ],
  "education": [
    {
      "degree": "本科",
      "field": "计算机科学",
      "institution": "浙江大学",
      "graduationYear": "2018"
    }
  ],
  "skills": [
    "React",
    "TypeScript",
    "Node.js",
    "Webpack",
    "Vite",
    "Next.js",
    "GraphQL"
  ],
  "languages": [
    {
      "language": "英语",
      "proficiency": "CET-6 580"
    }
  ],
  "conflict_of_interest": [],
  "expected_salary_range": "35k-50k",
  "outsourcing_acceptance": "接受",
  "labor_form_preference": "正编",
  "former_csi_employment": null,
  "former_tencent_employment": null,
  "gap_periods": []
}
```

**Robohire mock 回应 matchScore**: 76

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-28-57-657Z_f5d337_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-12T03-28-57-657Z_f5d337`
  - decision: PASS / PASS
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17071 ms tokens=10004/3119
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-40` [needs_human] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 13 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 17.08 s |
| matchResume | 4 ms |
| saveMatchResults | 2 ms |
| Neo4j write | 17 ms |
| **total** | **17.12 s** |
