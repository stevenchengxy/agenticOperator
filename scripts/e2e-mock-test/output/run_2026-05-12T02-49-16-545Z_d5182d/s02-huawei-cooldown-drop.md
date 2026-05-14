# s02-huawei-cooldown-drop ❌

> scenario: candidate=`c02-lisi-huawei-recent` × jd=`jr-bytedance-tiktok-fe`
> rationale: 李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-25 | 10-25:competitor_cooldown_risk |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-25**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (12)** — wrote=12 expected=12
- ❌ **evidence verifiable rate ≥ 0.8 (got 67%)** — verified=8 / total=12

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 67%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科(符合); 技能:React, TypeScript(符合); 语言:CET-6 520(符合); 性别:男(符合); 年龄:33岁(符合22-32范围, 略微超出但规则10-21/22有专… | 本科, React, CET-6 520 | 本科, React | 33岁, 学历 | ✓ |
| 10-6 | 命中加分项: Next.js | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 40k-50k 在岗位 30k-50k 范围内 | 期望薪资, 在岗位, 范围内 | 40k-50k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 毕业2017-07, 第一份工作2017-07; 经历间隙: 2019-05至2019-06, 均小于3个月 | 2019-05至2019-06, 毕业, 第一份工作 | 2017-07, 2019-05 | 2019-05至2019-06, 毕业 | ✓ |
| 10-10 | 平均每段工作时长: (22个月 + 81个月)/2 = 51.5个月, 大于1年 | 平均每段工作时长, 个月, 大于 | — | 平均每段工作时长, 个月 | ✗ |
| 10-12 | 毕业2017年 - 出生1992年 = 25岁。本科基准22-23岁, 偏差2岁, 处于临界点但逻辑基本合理 | 毕业, 出生, 本科基准 | — | 毕业, 出生 | ✗ |
| 10-14 | 简历提供 CET-6 520, 满足 JD 要求 CET-6 480 以上 | 简历提供, 满足, 要求 | CET-6, CET | 简历提供, 满足 | ✓ |
| 10-24 | 已关联至原始需求 jr_w66 | 已关联至原始需求 | — | 已关联至原始需求 | ✗ |
| 10-25 | 候选人最近一份工作在华为, 离职日期 2026-03, 当前日期 2026-05-12, 间隔不足3个月 | 候选人最近一份工作在华为, 离职日期, 当前日期 | 2026-03 | 候选人最近一份工作在华为, 离职日期 | ✓ |
| 10-11 | 偏好正编, 接受外包, 非仅实习/兼职 | 偏好正编, 接受外包, 非仅实习 | — | 偏好正编, 接受外包 | ✗ |
| 10-21 | 候选人出生1992-08, 当前2026-05, 实际年龄33岁, 超过岗位上限32岁 | 候选人出生, 当前, 实际年龄 | 1992-08 | 候选人出生, 当前 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_6005aa",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-25:competitor_cooldown_risk"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科(符合); 技能:React, TypeScript(符合); 语言:CET-6 520(符合); 性别:男(符合); 年龄:33岁(符合22-32范围, 略微超出但规则10-21/22有专项判定, 此处基础校验通过)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项: Next.js",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 40k-50k 在岗位 30k-50k 范围内",
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
      "evidence": "毕业2017-07, 第一份工作2017-07; 经历间隙: 2019-05至2019-06, 均小于3个月",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长: (22个月 + 81个月)/2 = 51.5个月, 大于1年",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业2017年 - 出生1992年 = 25岁。本科基准22-23岁, 偏差2岁, 处于临界点但逻辑基本合理",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历提供 CET-6 520, 满足 JD 要求 CET-6 480 以上",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班、倒班或长期出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至原始需求 jr_w66",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人最近一份工作在华为, 离职日期 2026-03, 当前日期 2026-05-12, 间隔不足3个月",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO、小米任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非我司(CSI)曾任职员工",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中无定义的负向要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HC冻结历史记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "偏好正编, 接受外包, 非仅实习/兼职",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人出生1992-08, 当前2026-05, 实际年龄33岁, 超过岗位上限32岁",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定明确年龄上限, 适用10-21",
      "next_action": "continue"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史推荐记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无字节历史退场记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示通过友商派驻字节的经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无字节跳动正式雇员经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "不涉及正编回流",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **竞对红线**: 候选人刚从华为离职(2026-03), 距今不足3个月, 触发华为/荣耀互不挖角红线。\n- **年龄超标**: 候选人当前33岁, 超过岗位设定的32岁上限。\n- **加分项**: 具备 Next.js 经验, 英语 CET-6 520分满足要求。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人李四存在华为任职记录且离职不足3个月, 需确认竞对互不挖角风险。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-49-16-545Z_d5182d_s02-huawei-cooldown-drop`
  - run_id: `run_2026-05-12T02-49-16-545Z_d5182d`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=16249 ms tokens=9661/3351
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 12 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=FAIL next=notify_recruiter
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 16.25 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 75 ms |
| **total** | **16.32 s** |
