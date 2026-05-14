# E2E Mock Test Run — run_2026-05-11T17-08-24-453Z_207751

**Result: 0/1 scenarios passed**

## Summary

| # | Scenario | Decision | Evidence rate | Status |
|---|---|---|---|---|
| 1 | [s01-clean-tencent-pcg-keep](s01-clean-tencent-pcg-keep.md) | FAIL (UNKNOWN) | 100% | ❌ FAIL (3/10 assertions) |

## Failed assertions (details)

### s01-clean-tencent-pcg-keep

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ❌ **must-pass rule applicable+PASS: 10-25** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-pass rule applicable+PASS: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-pass rule applicable+PASS: 10-26** — LLM 没在 rule_flags 输出这条规则
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 

## Evidence verifiability

**Aggregate verifiability: 0/0 (100%)**

说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。
