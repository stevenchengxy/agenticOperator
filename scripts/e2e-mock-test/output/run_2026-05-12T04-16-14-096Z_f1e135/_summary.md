# E2E Mock Test Run — run_2026-05-12T04-16-14-096Z_f1e135

**Result: 6/10 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (FAIL) | 94% | ❌ FAIL (4/8 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (FAIL) | 94% | ✅ PASS |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (FAIL) | 86% | ✅ PASS |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (FAIL) | 95% | ✅ PASS |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (FAIL) | 94% | ❌ FAIL (7/8 assertions) |
| 6 | [s06-bytedance-history-pause](s06-bytedance-history-pause.md) | FAIL (FAIL) | 88% | ✅ PASS |
| 7 | [s07-foreign-marital-tencent](s07-foreign-marital-tencent.md) | FAIL (FAIL) | 100% | ❌ FAIL (7/8 assertions) |
| 8 | [s08-bytedance-cooldown-expired](s08-bytedance-cooldown-expired.md) | FAIL (FAIL) | 100% | ✅ PASS |
| 9 | [s09-tencent-history-to-bytedance](s09-tencent-history-to-bytedance.md) | FAIL (FAIL) | 100% | ❌ FAIL (7/9 assertions) |
| 10 | [s10-clean-tencent-cdg](s10-clean-tencent-cdg.md) | FAIL (FAIL) | 94% | ✅ PASS |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 

### s05-tencent-history-same-studio

- ❌ **must-not-fail rule: 10-42** — applicable=true result=FAIL

### s07-foreign-marital-tencent

- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit

### s09-tencent-history-to-bytedance

- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-43** — LLM 没在 rule_flags 输出这条规则

## Evidence verifiability

**Aggregate verifiability: 148/158 (94%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
