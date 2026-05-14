# E2E Mock Test Run — run_2026-05-12T03-09-38-834Z_877700

**Result: 0/6 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (FAIL) | 53% | ❌ FAIL (2/8 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (FAIL) | 43% | ❌ FAIL (6/7 assertions) |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (FAIL) | 47% | ❌ FAIL (6/7 assertions) |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (FAIL) | 59% | ❌ FAIL (6/7 assertions) |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (FAIL) | 50% | ❌ FAIL (6/8 assertions) |
| 6 | [s06-bytedance-history-pause](s06-bytedance-history-pause.md) | FAIL (FAIL) | 38% | ❌ FAIL (8/9 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ❌ **evidence verifiable rate ≥ 0.8 (got 53%)** — verified=8 / total=15

### s02-huawei-cooldown-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 43%)** — verified=10 / total=23

### s03-csi-blacklist-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 47%)** — verified=9 / total=19

### s04-tencent-history-cross-studio

- ❌ **evidence verifiable rate ≥ 0.8 (got 59%)** — verified=10 / total=17

### s05-tencent-history-same-studio

- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ❌ **evidence verifiable rate ≥ 0.8 (got 50%)** — verified=8 / total=16

### s06-bytedance-history-pause

- ❌ **evidence verifiable rate ≥ 0.8 (got 38%)** — verified=8 / total=21

## Evidence verifiability

**Aggregate verifiability: 53/111 (48%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
