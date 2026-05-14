# E2E Mock Test Run — run_2026-05-12T04-10-46-198Z_f889c7

**Result: 0/10 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (3/8 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/7 assertions) |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/7 assertions) |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/7 assertions) |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/8 assertions) |
| 6 | [s06-bytedance-history-pause](s06-bytedance-history-pause.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/9 assertions) |
| 7 | [s07-foreign-marital-tencent](s07-foreign-marital-tencent.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/8 assertions) |
| 8 | [s08-bytedance-cooldown-expired](s08-bytedance-cooldown-expired.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/7 assertions) |
| 9 | [s09-tencent-history-to-bytedance](s09-tencent-history-to-bytedance.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/9 assertions) |
| 10 | [s10-clean-tencent-cdg](s10-clean-tencent-cdg.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (6/9 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **must-not-fail rule: 10-25** — LLM 没在 rule_flags 输出这条规则
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 

### s02-huawei-cooldown-drop

- ❌ **must-fail rule fired: 10-25** — LLM 没有把 10-25 标为 fail/pause/hit

### s03-csi-blacklist-drop

- ❌ **must-fail rule fired: 10-17** — LLM 没有把 10-17 标为 fail/pause/hit

### s04-tencent-history-cross-studio

- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit

### s05-tencent-history-same-studio

- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit
- ❌ **must-not-fail rule: 10-42** — LLM 没在 rule_flags 输出这条规则

### s06-bytedance-history-pause

- ❌ **must-fail rule fired: 10-49** — LLM 没有把 10-49 标为 fail/pause/hit
- ❌ **must-not-fail rule: 10-25** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-26** — LLM 没在 rule_flags 输出这条规则

### s07-foreign-marital-tencent

- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit
- ❌ **must-fail rule fired: 10-47** — LLM 没有把 10-47 标为 fail/pause/hit

### s08-bytedance-cooldown-expired

- ❌ **must-fail rule fired: 10-49** — LLM 没有把 10-49 标为 fail/pause/hit

### s09-tencent-history-to-bytedance

- ❌ **must-fail rule fired: 10-5** — LLM 没有把 10-5 标为 fail/pause/hit
- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-43** — LLM 没在 rule_flags 输出这条规则

### s10-clean-tencent-cdg

- ❌ **must-fail rule fired: 10-5** — LLM 没有把 10-5 标为 fail/pause/hit
- ❌ **must-not-fail rule: 10-25** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则

## Evidence verifiability

**Aggregate verifiability: 0/0 (100%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
