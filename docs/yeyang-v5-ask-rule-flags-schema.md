# 给叶洋的 v5 ask:Action Object 输出 schema 加 rule_flags + evidence

> 来自:雨函 / Agentic Operator(2026-05-12)
> 关联:[docs/rule-check-unified-plan.md](./rule-check-unified-plan.md) Phase 3 的第 1 项
> 等级:阻塞 rule-check 生产启用

---

## TL;DR

v4-4 当前 `match-resume.action-object.ts` 的输出 schema 是 step-level:
```
step_results.step_N.fired_rule_ids: ["10-25", ...]
                   .blocking_rule_ids: ["10-25"]
                   .notifications: [...]
```

这个 schema **不带 evidence 字段**,user story 反向验证(LLM 为什么判命中 / 没命中 10-X)做不了。

希望 v5 (`assembleActionObjectV4_5`)在每个 Step 内部输出**rule-level 数组**,每条带 evidence + applicable + result + next_action,跟我们 POC composer 的 schema 收敛。改完之后我们就能下掉 POC 路径,统一走你这条。

---

## 0. 当前 v4-4 schema(摘自 [generated/v4/match-resume.action-object.ts](../generated/v4/match-resume.action-object.ts))

```json
{
  "match_results": [...],
  "overall_status": "存在匹配岗位" | "全部不匹配",
  "notifications": [{"recipient","channel","trigger_rule_id","reason"}],
  "terminal": false,
  "step_results": {
    "step_1": {
      "status": "not_started|completed|blocked|pending_human",
      "fired_rule_ids": [],
      "blocking_rule_ids": [],
      "notifications": [],
      "redline_result": "..."
    },
    "step_2": { ..., "hard_match_result": "..." },
    "step_3": { ..., "bonus_and_reflux_result": "..." },
    "step_4": { ..., "match_report": "...", "next_action": "..." }
  }
}
```

**问题**:
- `fired_rule_ids: ["10-25"]` 只是 ID 列表,LLM 为什么觉得 10-25 命中?看不到推理依据
- 不在 `fired_rule_ids` 里的规则,是"评估了不命中" 还是 "根本没看"?分不清
- 复盘场景"10-43 应该在 IEG 推荐时拦截但没拦"无法定位是 LLM 漏看了还是判错了

---

## 1. v5 期望 schema

每个 step_result 增加 `rule_flags[]` 数组(对照我们 POC 的 [`lib/rule-check/prompt.ts`](../lib/rule-check/prompt.ts) §5),fired/blocking ID 列表保留但变成派生字段:

```json
{
  "match_results": [...],
  "overall_status": "存在匹配岗位" | "全部不匹配",
  "notifications": [...],
  "terminal": false,
  "step_results": {
    "step_1": {
      "status": "not_started|completed|blocked|pending_human",
      "rule_flags": [
        {
          "rule_id": "10-25",
          "rule_name": "华为荣耀竞对与客户互不挖角红线",
          "applicable_client": "通用",
          "severity": "terminal",

          "applicable": true,
          "result": "PASS|FAIL|REVIEW|NOT_APPLICABLE",
          "evidence": "简历 experience[2]: 华为, 离职日期 2025-11; 距今 5 个月 ≥ 3 个月阈值,不命中,result=PASS",
          "next_action": "continue|block|pause|notify_recruiter|notify_hsm"
        },
        ... // 本 step 下所有规则全列(包括 applicable=false 的,evidence 写"不适用原因")
      ],
      "fired_rule_ids": ["10-25", ...],         // 派生:rule_flags.filter(applicable=true && result≠PASS).map(rule_id)
      "blocking_rule_ids": ["10-25"],           // 派生:rule_flags.filter(severity=terminal && result=FAIL).map(rule_id)
      "notifications": [...]
    },
    "step_2": { ... },
    ...
  },

  // 新增 — 跟 POC 的 resume_augmentation 对齐
  // 给下游 Robohire `/match-resume` 看,注入到 resume 字段顶部
  "resume_augmentation": "## Rule Check Annotations\n- [10-25 ✓] 华为冷冻已过 ..."
}
```

### 字段约束

| 字段 | 强制 / 可选 | 语义 |
|---|---|---|
| `rule_flags[].applicable` | 强制 boolean | 这条规则在本场景下需不需要评估(例如腾讯婚育规则 10-47 在腾讯岗位 applicable=true,在字节岗位 applicable=false) |
| `rule_flags[].result` | 强制 enum | `PASS`(适用且通过) / `FAIL`(适用且终止级命中) / `REVIEW`(适用且需人工) / `NOT_APPLICABLE`(applicable=false 时填这个;或简历缺字段无法判定) |
| `rule_flags[].evidence` | 强制非空字符串 | 引用简历或岗位原文片段。简历缺字段时写 `"简历未提供 <字段名>,标 NOT_APPLICABLE"`。**不允许编造**,文本只能引用 prompt 中给出的 INPUT 内容 |
| `rule_flags[].next_action` | 可选 | 命中时该做什么。terminal 严格意义上的 block / needs_human 应该 pause / flag_only 应该 continue。落到 `step_N.notifications` |
| `rule_flags[]` 覆盖完整性 | self-check 强制 | 本 step 下 prompt 列出的规则,**每一条都要在 rule_flags 里出现**(applicable=true 或 false 都要列),禁止"我没列 = 没看" |
| 顶层 `resume_augmentation` | 强制非空字符串 | 给 Robohire 的 markdown annotations,见下面例子。即便全 PASS 也要写(可以是 "All rules cleared" 这种) |

### `resume_augmentation` 例子

```markdown
## Rule Check Annotations

- [10-25 ✓] 华为冷冻期已过(experience[2]: 华为, 离职 2025-11, 距今 5 个月)
- [10-43 ⚠] IEG 工作室回流标记:experience[1] 显示曾在腾讯天美;本岗位是 IEG 光子,跨室推荐合规(>6 个月)
- [10-6 ⓘ] 加分项命中:experience.highlights 主导 webpack→vite 迁移

(无终止级风险,可推进 deep matching)
```

格式约定:
- `✓` = applicable & result=PASS
- `✗` = applicable & result=FAIL
- `⚠` = applicable & result=REVIEW
- `ⓘ` = applicable & severity=flag_only

---

## 2. 提示模板侧的改动建议

[`lib/ontology-gen/v4/assemble-v4-4.ts`](../lib/ontology-gen/v4/assemble-v4-4.ts) 里:

### 2.1 在 `## 重要约束` 段加 evidence 规则

```diff
- 你只能依据本模板中引用的 action、step 和 rule 原文进行判断。
+ 你只能依据本模板中引用的 action、step 和 rule 原文进行判断。
+ 每条规则在 `step_results.step_N.rule_flags[]` 里 **必须列出**(即使
+ applicable=false 也要列,evidence 写"不适用原因"),禁止"没列 = 没看"。
+ Evidence 字段必须引用 prompt 中 §运行时输入 的实际内容,不允许编造。
```

### 2.2 输出 JSON 骨架更新

把当前的 `step_results.step_N` 块从 `fired_rule_ids/blocking_rule_ids/...` 改成 `rule_flags[]` 数组(见 §1 schema)。

### 2.3 在 `## 返回前检查` 加 2 条自检

```diff
4. `step_results` 包含所有已执行步骤的中间结果。
5. `terminal` 与规则要求的终止/阻断状态一致。
+ 6. 每个 step 的 `rule_flags` 包含本 step prompt 列出的所有规则(数完确认),
+     applicable=false 的也必须有 entry。
+ 7. 每条 evidence 引用简历原文或岗位原文,简历缺字段写"简历未提供 X,标 NOT_APPLICABLE"。
+ 8. `resume_augmentation` 是非空 markdown 段,即使全 PASS 也写一句话总结。
```

---

## 3. 我们这边的 wiring(等你 v5 出来后我做)

`lib/rule-check/yeyang-runner.ts` 当前的 `foldVerdict()` 用 `terminal=true OR overall_status='全部不匹配' OR step.status='blocked'` 判 FAIL。v5 后简化成:

```ts
// v5
function foldVerdict(parsed: YeyangV5Output) {
  // 任一 step 的 rule_flags 出现 applicable=true && result='FAIL' → DROP
  // 否则任一出现 applicable=true && result='REVIEW' → PAUSE
  // 否则 → KEEP
  // → binary:DROP/PAUSE = FAIL,KEEP = PASS
}
```

并且 `yeyang-runner.ts` 不再需要把叶洋 schema 反贴回 POC 的 `LlmRuleCheckOutput`(`pseudoLlmOutput` 那段),因为输出本身已经是 POC 风格。

最终结果:我们删掉 [`lib/rule-check/prompt.ts`](../lib/rule-check/prompt.ts) 和 [`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts) 的 POC 路径,统一走你这条。`RULE_CHECK_PROMPT_SOURCE` env 也可以下掉。

---

## 4. 落地节奏

| 时间 | 你 | 我 |
|---|---|---|
| Week 1 | v5 assembler 出 PR + 重新生成 `generated/v4/match-resume.action-object.ts` | 等 |
| Week 2 | 主仓 v5 合并 | yeyang-runner.ts 切到 v5 schema |
| Week 2 末 | (无) | 我们这边跑 POC 6 场景对比 v5 输出(准确率不掉) |
| Week 3 | (无) | 把 RULE_CHECK_PROMPT_SOURCE env 下掉,POC 路径归档(`scripts/rule-check-poc/_archived/`)|

---

## 5. 验收

- `yeyang-runner.ts` 跑 POC 6 场景 → 6/6 accuracy 不降(当前 POC 是 4/6,你 v5 出来后我们至少要打平或更好)
- LLM 输出的 `step_results.step_*.rule_flags` 加起来 = `actionSteps[*].rules` 总数(完整覆盖)
- 随机抽 10 个 `rule_flags[i].evidence` 字段,人工检查能不能在 prompt INPUT 里溯源(95% 以上能溯源)
- `resume_augmentation` 非空且格式跟 §1 例子一致(单测 grep `^- \[`)

---

## 6. 如果你有疑问

- 字段名(applicable / result / evidence / next_action / resume_augmentation)是我们 POC 已经 6 场景验过的,可以照搬。但如果你觉得更适合的名字告诉我们,改名小事
- `result` 的 `NOT_APPLICABLE` 跟 `applicable=false` 有冗余,但保留独立字段是因为 "applicable=true 但简历缺字段无法判定" 这种情况也用 `result=NOT_APPLICABLE`。两个字段语义不同
- 如果你想保留 v4-4 的 `fired_rule_ids` / `blocking_rule_ids` 作为 derived 字段(便于老消费方),我们这边不反对。但 `rule_flags[]` 是 source-of-truth
