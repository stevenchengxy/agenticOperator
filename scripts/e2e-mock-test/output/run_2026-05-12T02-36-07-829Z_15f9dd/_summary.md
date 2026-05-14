# E2E Mock Test Run — run_2026-05-12T02-36-07-829Z_15f9dd

**Result: 0/6 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (PAUSE) | 30% | ❌ FAIL (5/10 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (PAUSE) | 67% | ❌ FAIL (6/7 assertions) |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (DROP) | 50% | ❌ FAIL (6/7 assertions) |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (PAUSE) | 63% | ❌ FAIL (5/7 assertions) |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (DROP) | 53% | ❌ FAIL (5/8 assertions) |
| 6 | [s06-clean-bytedance-keep](s06-clean-bytedance-keep.md) | FAIL (PAUSE) | 36% | ❌ FAIL (4/9 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ❌ **evidence verifiable rate ≥ 0.8 (got 30%)** — verified=7 / total=23

### s02-huawei-cooldown-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 67%)** — verified=8 / total=12

### s03-csi-blacklist-drop

- ❌ **evidence verifiable rate ≥ 0.8 (got 50%)** — verified=9 / total=18

### s04-tencent-history-cross-studio

- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit
- ❌ **evidence verifiable rate ≥ 0.8 (got 63%)** — verified=12 / total=19

### s05-tencent-history-same-studio

- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit
- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ❌ **evidence verifiable rate ≥ 0.8 (got 53%)** — verified=8 / total=15

### s06-clean-bytedance-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ❌ **evidence verifiable rate ≥ 0.8 (got 36%)** — verified=8 / total=22

## Evidence verifiability

**Aggregate verifiability: 52/109 (48%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
