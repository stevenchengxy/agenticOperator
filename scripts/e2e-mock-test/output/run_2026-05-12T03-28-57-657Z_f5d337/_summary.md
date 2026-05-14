# E2E Mock Test Run — run_2026-05-12T03-28-57-657Z_f5d337

**Result: 4/6 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | PASS (PASS) | 100% | ❌ FAIL (7/8 assertions) |
| 2 | [s02-huawei-cooldown-drop](s02-huawei-cooldown-drop.md) | FAIL (FAIL) | 100% | ✅ PASS |
| 3 | [s03-csi-blacklist-drop](s03-csi-blacklist-drop.md) | FAIL (FAIL) | 95% | ✅ PASS |
| 4 | [s04-tencent-history-cross-studio](s04-tencent-history-cross-studio.md) | FAIL (FAIL) | 92% | ✅ PASS |
| 5 | [s05-tencent-history-same-studio](s05-tencent-history-same-studio.md) | FAIL (FAIL) | 94% | ❌ FAIL (7/8 assertions) |
| 6 | [s06-bytedance-history-pause](s06-bytedance-history-pause.md) | FAIL (FAIL) | 100% | ✅ PASS |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: ### 预筛标签
- **硬性匹配**: 学历(本科)、语言(CET-6 580)、技能(React/TS/Webpac

### s05-tencent-history-same-studio

- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL

## Evidence verifiability

**Aggregate verifiability: 105/109 (96%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
