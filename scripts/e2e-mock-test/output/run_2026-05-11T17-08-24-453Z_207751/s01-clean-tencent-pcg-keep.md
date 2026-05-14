# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,通用 + 客户级规则都应该 PASS / NOT_APPLICABLE。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | KEEP | UNKNOWN |
| must-fail rules | (none) | llm-call-error:Connection error. |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ❌ **must-pass rule applicable+PASS: 10-25** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-pass rule applicable+PASS: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-pass rule applicable+PASS: 10-26** — LLM 没在 rule_flags 输出这条规则
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (0)** — wrote=0 expected=0
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=0 / total=0

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

> (无 applicable rule_flags,跳过 evidence 验证)

## 4. LLM 原始输出(full JSON)

```json
null
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-11T17-08-24-453Z_207751_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-11T17-08-24-453Z_207751`
  - decision: FAIL / UNKNOWN
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`unknown` duration=0 ms tokens=?/?
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 0 (applicable=true 的全部):

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 34 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 16.51 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 118 ms |
| **total** | **16.66 s** |
