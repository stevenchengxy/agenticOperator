# s07-foreign-marital-tencent ❌

> scenario: candidate=`c05-zhouqi-foreign-data` × jd=`jr-tencent-cdg-data`
> rationale: 周七 nationality="美国"(外籍)+ gender="女" + age=28 + marital="未婚"。腾讯客户场景 10-35(外籍通道限制)+ 10-47(女>26 未婚/已婚未育 HSM 审视)都必须命中。复合多规则 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | UNKNOWN |
| must-fail rules | 10-35, 10-47 | parse-error:no-parsed-json |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit
- ❌ **must-fail rule fired: 10-47** — LLM 没有把 10-47 标为 fail/pause/hit
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

- **RuleCheckAudit** `rca_run_2026-05-12T04-10-46-198Z_f889c7_s07-foreign-marital-tencent`
  - run_id: `run_2026-05-12T04-10-46-198Z_f889c7`
  - decision: FAIL / UNKNOWN
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`stub:deterministic` duration=10 ms tokens=5535/2176
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 0 (applicable=true 的全部):

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 3 ms |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 2 ms |
| **total** | **7 ms** |
