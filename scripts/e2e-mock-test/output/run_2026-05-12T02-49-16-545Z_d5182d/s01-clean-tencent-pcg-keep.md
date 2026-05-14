# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,通用 + 客户级规则都应该 PASS / NOT_APPLICABLE。

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
- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-38** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-26** — applicable=false result=NOT_APPLICABLE
- ✅ **matchResume called**
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: ### 预筛亮点
- **加分项命中**: 候选人具备 `Next.js` 和 `GraphQL` 技能。
- **稳定
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (14)** — wrote=14 expected=14
- ❌ **evidence verifiable rate ≥ 0.8 (got 43%)** — verified=6 / total=14

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 43%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科; 技能:React, TypeScript, Webpack; 语言:CET-6 580; 性别:男; 年龄:30岁 (1996-05-12)。全部满足JD要求。 | 本科, React, CET-6 580 | 本科, React | 30岁, 学历 | ✓ |
| 10-6 | 命中加分项: Next.js, GraphQL | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 35k-50k, 岗位薪资 30k-50k, 处于范围内。 | 期望薪资, 岗位薪资, 处于范围内 | 35k-50k | 期望薪资, 岗位薪资 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2018-07至今工作连续, 无超过3个月空窗期。 | 至今工作连续, 无超过, 个月空窗期 | 2018-07 | 至今工作连续, 无超过 | ✓ |
| 10-10 | 平均每段工作时长约3年, 稳定性良好。 | 平均每段工作时长约, 稳定性良好 | — | 平均每段工作时长约, 稳定性良好 | ✗ |
| 10-12 | 1996年出生, 2018年本科毕业, 毕业年龄22岁, 偏差0岁, 逻辑正常。 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | CET-6 580, 满足JD要求的480分以上。 | 满足, 要求的, 分以上 | CET-6, CET | 满足, 要求的 | ✓ |
| 10-24 | 已关联至 jr_x99。 | 已关联至 | — | 已关联至 | ✗ |
| 10-54 | 最近一段经历为阿里巴巴, 不属于负向要求(外包经历超过2年)。 | 最近一段经历为阿里巴巴, 不属于负向要求, 外包经历超过 | — | 最近一段经历为阿里巴巴, 不属于负向要求 | ✗ |
| 10-27 | conflict_of_interest 为空, 无亲属冲突声明。 | 为空, 无亲属冲突声明 | — | 为空, 无亲属冲突声明 | ✗ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-47 | 性别为男, 不触发该规则。 | 性别为男, 不触发该规则 | — | 性别为男, 不触发该规则 | ✗ |
| 10-53 | 目标事业群为 PCG, 适用跳过规则。 | 目标事业群为, 适用跳过规则, PCG | — | 目标事业群为, 适用跳过规则 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_f34a33",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "PASS",
  "failure_reasons": [],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科; 技能:React, TypeScript, Webpack; 语言:CET-6 580; 性别:男; 年龄:30岁 (1996-05-12)。全部满足JD要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项: Next.js, GraphQL",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-50k, 岗位薪资 30k-50k, 处于范围内。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度: 接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2018-07至今工作连续, 无超过3个月空窗期。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3年, 稳定性良好。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1996年出生, 2018年本科毕业, 毕业年龄22岁, 偏差0岁, 逻辑正常。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "CET-6 580, 满足JD要求的480分以上。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无轮班/出差标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至 jr_x99。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华为/荣耀经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO/小米经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无我司任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "最近一段经历为阿里巴巴, 不属于负向要求(外包经历超过2年)。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空, 无亲属冲突声明。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无腾讯或腾讯外包经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未被标记为受控状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "性别为男, 不触发该规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为 PCG, 适用跳过规则。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛亮点\n- **加分项命中**: 候选人具备 `Next.js` 和 `GraphQL` 技能。\n- **稳定性**: 毕业至今无空窗期，平均司龄 3 年。\n- **流程优化**: 目标部门为 PCG，根据规则 10-53 将跳过内部技术面试。",
  "notifications": []
}
```

## 5. matchResume 调用 — body.resume(注入 augmentation 后)

```
### 预筛亮点
- **加分项命中**: 候选人具备 `Next.js` 和 `GraphQL` 技能。
- **稳定性**: 毕业至今无空窗期，平均司龄 3 年。
- **流程优化**: 目标部门为 PCG，根据规则 10-53 将跳过内部技术面试。

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

**Robohire mock 回应 matchScore**: 66

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-49-16-545Z_d5182d_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-12T02-49-16-545Z_d5182d`
  - decision: PASS / PASS
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17181 ms tokens=9832/2953
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 14 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 20 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.18 s |
| matchResume | 2 ms |
| saveMatchResults | 1 ms |
| Neo4j write | 167 ms |
| **total** | **17.38 s** |
