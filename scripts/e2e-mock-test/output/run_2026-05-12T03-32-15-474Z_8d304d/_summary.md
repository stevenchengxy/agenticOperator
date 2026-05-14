# E2E Mock Test Run — run_2026-05-12T03-32-15-474Z_8d304d

**Result: 3/6 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (FAIL) | 94% | ❌ FAIL (4/8 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (FAIL) | 94% | ✅ PASS |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (FAIL) | 89% | ✅ PASS |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (FAIL) | 90% | ✅ PASS |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (FAIL) | 100% | ❌ FAIL (7/8 assertions) |
| 6 | [s06-bytedance-history-pause](s06-bytedance-history-pause.md) | FAIL (FAIL) | 100% | ❌ FAIL (7/9 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 

### s05-tencent-history-same-studio

- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL

### s06-bytedance-history-pause

- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-26** — applicable=false result=NOT_APPLICABLE

## Evidence verifiability

**Aggregate verifiability: 96/102 (94%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
