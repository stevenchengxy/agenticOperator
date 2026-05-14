# E2E Mock Test Run — run_2026-05-12T02-49-16-545Z_d5182d

**Result: 0/6 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | PASS (PASS) | 43% | ❌ FAIL (5/10 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (FAIL) | 67% | ❌ FAIL (6/7 assertions) |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (FAIL) | 41% | ❌ FAIL (6/7 assertions) |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (FAIL) | 65% | ❌ FAIL (6/7 assertions) |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (FAIL) | 53% | ❌ FAIL (6/8 assertions) |
| 6 | [s06-clean-bytedance-keep](s06-clean-bytedance-keep.md) | FAIL (FAIL) | 44% | ❌ FAIL (4/9 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-38** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-26** — applicable=false result=NOT_APPLICABLE
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: ### 预筛亮点
- **加分项命中**: 候选人具备 `Next.js` 和 `GraphQL` 技能。
- **稳定
- ❌ **evidence verifiable rate ≥ 0.8 (got 43%)** — verified=6 / total=14

### s02-huawei-cooldown-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 67%)** — verified=8 / total=12

### s03-csi-blacklist-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 41%)** — verified=9 / total=22

### s04-tencent-history-cross-studio

- ❌ **evidence verifiable rate ≥ 0.8 (got 65%)** — verified=11 / total=17

### s05-tencent-history-same-studio

- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ❌ **evidence verifiable rate ≥ 0.8 (got 53%)** — verified=8 / total=15

### s06-clean-bytedance-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ❌ **evidence verifiable rate ≥ 0.8 (got 44%)** — verified=8 / total=18

## Evidence verifiability

**Aggregate verifiability: 50/98 (51%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
