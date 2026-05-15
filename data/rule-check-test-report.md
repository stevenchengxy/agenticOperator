# Rule Check Test Suite — Report

- Generated: 2026-05-13T10:07:43.510Z
- Started:   2026-05-13T10:05:43.276Z
- Total:     2
- Passed:    1
- Failed:    1
- Errored:   0

## Results

| # | Scenario | Expected | Got | Stats | Time | Result |
|---|---|---|---|---|---|---|
| S01 | 控制组 PASS | PASS | REVIEW | pass=5 fail=0 pending=0 info=3 nt=9 ne=0 | 58654ms | ✗ |
| S02 | 华为冷冻期 REVIEW | REVIEW | REVIEW | pass=6 fail=0 pending=1 info=2 nt=8 ne=0 | 57355ms | ✓ |

## Failures and errors

### S01 — 控制组 PASS ✗

- **Expected decision:** PASS
- **Got decision:** REVIEW
- **Got stats:** pass=5 fail=0 pending=0 info=3 nt=9 ne=0

- **Differences:**
  - decision mismatch — expected PASS, got REVIEW

- **Full rule_results:**

  | rule_id | status | reason |
  |---|---|---|
  | 10-16 | not_triggered |  |
  | 10-17 | not_triggered |  |
  | 10-18 | not_triggered |  |
  | 10-26 | not_triggered |  |
  | 10-25 | not_triggered |  |
  | 10-10 | pass |  |
  | 10-9 | pass |  |
  | 10-54 | not_triggered |  |
  | 10-7 | insufficient_info | 候选人期望薪资及岗位薪资上限缺失 |
  | 10-8 | insufficient_info | 候选人对人力资源外包模式接受度缺失 |
  | 10-15 | not_triggered |  |
  | 10-6 | pass |  |
  | 10-12 | pass |  |
  | 10-14 | not_triggered |  |
  | 10-5 | pass |  |
  | 10-29 | not_triggered |  |
  | 10-24 | insufficient_info | 岗位原始招聘需求关联信息缺失 |

