# s08-bytedance-cooldown-expired ❌

> scenario: candidate=`c06-qianba-bytedance-history` × jd=`jr-bytedance-tiktok-fe`
> rationale: 钱八 work_history 含字节跳动正式员工(2 年前主动离职)。10-49 字节正编回流标记仍要求上传客户 BP 凭证。冷冻期已过(>6m),但凭证流程未走完 → needs_human → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | UNKNOWN |
| must-fail rules | 10-49 | parse-error:no-parsed-json |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ❌ **must-fail rule fired: 10-49** — LLM 没有把 10-49 标为 fail/pause/hit
- ✅ **matchResume NOT called (FAIL skips Robohire)**
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

- **RuleCheckAudit** `rca_run_2026-05-12T04-10-46-198Z_f889c7_s08-bytedance-cooldown-expired`
  - run_id: `run_2026-05-12T04-10-46-198Z_f889c7`
  - decision: FAIL / UNKNOWN
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`stub:deterministic` duration=10 ms tokens=5525/2176
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 0 (applicable=true 的全部):

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 2 ms |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 2 ms |
| **total** | **5 ms** |
