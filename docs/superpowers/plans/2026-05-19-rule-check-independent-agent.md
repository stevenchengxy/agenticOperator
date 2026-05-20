# Rule-Check 独立化 + RoboHire 直连 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 rule-check 从 matchResumeAgent 内嵌位置抽离成独立 Inngest function;用 enforcementLevel + failurePolicy 取代 inferSeverity 关键词启发式;parse-resume + match-resume 切换 RAAS proxy → AO 直连 RoboHire。

**Architecture:** 现状 matchResumeAgent 内部 step 4.0 跑 runRuleCheck;改造后 matchResumeAgent 双段订阅(`RESUME_PROCESSED` + `RULE_CHECK_PASSED`),中间插入 NEW `ruleCheckAgent`(订阅 `RULE_CHECK_REQUESTED`)。RoboHire 客户端新建 `lib/robohire-client.ts`,parseResumeDirect / matchResumeDirect 直连 `api.robohire.io`。Rule 数据从 v0.1 升级到 v0.1.002(新增 `enforcementLevel` + `failurePolicy` 两字段),Neo4j 通过迁移脚本 DETACH DELETE + UNWIND 重导。

**Tech Stack:** Next.js 16.2 / TypeScript 5 / Inngest 4 / Vitest / Neo4j 5 (bolt://localhost:7688) / RoboHire API (api.robohire.io)

**Spec reference:** [docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md](../specs/2026-05-19-rule-check-independent-agent-design.md)

**Implementation order:** 5 个独立 PR,每个 PR 一个 Chunk。Chunk 1-3 独立可上线,Chunk 4 依赖前 3 个,Chunk 5 可选。

---

## Pre-flight: 共享前置(执行任一 Chunk 前必读)

### 工作环境

- 项目根目录:`/Users/yuhancheng/Desktop/agenticOperator`
- Dev server 端口:**3002**(不是 3000)
- Inngest dev:`npm run inngest:up`(docker compose)
- Neo4j 容器:`e2e-test-neo4j`(browser :7475,bolt :7688)
- Postgres:partner 那边,通过 RAAS API Server `http://192.168.1.105:3001`

### 关键命令

```bash
npm run dev                        # next dev :3002
npm run build                      # 触发 TypeScript 检查 + lint
npm run test                       # vitest run (全套)
npx vitest run <path>              # 单文件
npx vitest watch <path>            # 单文件 watch
npm run inngest:up / :down / :logs # docker compose 控 Inngest dev server
```

### Memory / 项目契约提醒

- **AO ↔ RAAS dual-write 契约**:`POST /candidates / /match-results / /jd/sync-generated` 写 Postgres,不能去掉。能绕过的只有 RoboHire 透传(`POST /parse-resume / /match-resume`)。
- **不要写 ad-hoc probe / introspection 脚本**:用现有 API 而不是临时探查。
- 失败一律 fail-safe in-band — `runRuleCheck` 不抛异常,异常分支返回 `decision='FAIL'` + `audit.fail_reason`。

---

## Chunk 1: PR-1 — Rule 数据 v0.1.002 迁移 + 删除 inferSeverity

> **目标**:rules_v0_1_002.json 覆盖到本地 + Neo4j;Rule type 加 `enforcementLevel` + `failurePolicy`;删除 `inferSeverity()` 33 关键词 heuristic;UI severity badge 改用新字段。
>
> **可单独上线**。本 chunk 完成后,生产 rule-check 链路(仍内嵌在 matchResumeAgent)依然工作,只是用新 schema 字段表达严重度。

### Files

- Create: `scripts/migrate-rules-v0-1-002.ts`
- Modify: `lib/rule-check/rules.json` (覆盖整个文件)
- Modify: `lib/rule-check/types.ts` (加 2 字段)
- Modify: `lib/rule-check/ontology.ts` (删 inferSeverity + 改 normalizeRaw)
- Modify: `lib/rule-check/prompt.ts` (renderRuleBlock 改 severity 显示)
- Modify: `lib/rule-check/runner.test.ts` (mock fixtures 加新字段)
- Modify: `lib/rule-check/ontology-source.test.ts` (mock fixtures 加新字段)
- Modify: `lib/rule-check/prompt.test.ts` (assert 新字段渲染)
- Create: `lib/rule-check/ontology.test.ts` (NEW — 测试 enforcement derive + applyClientFilter)
- Modify: `components/rule-check/ScenarioMatrix.tsx`(若有 severity 显示)
- Modify: `components/rule-check/CaseDrawer.tsx`(若有 severity 显示)
- Modify: `lib/i18n.tsx` (4 个新 key)

### Task 1.1: 准备迁移脚本(测试驱动)

**Files:**
- Create: `scripts/migrate-rules-v0-1-002.ts`
- Test: 手工跑 + Cypher 校验(没有自动化测试,因为这是一次性脚本)

- [ ] **Step 1: 备份当前 rules.json**

```bash
cp /Users/yuhancheng/Desktop/agenticOperator/lib/rule-check/rules.json \
   /Users/yuhancheng/Desktop/agenticOperator/lib/rule-check/rules.json.bak.$(date +%Y%m%d-%H%M%S)
```
Expected: 备份文件创建成功。

- [ ] **Step 2: pre-flight 检查 Neo4j 当前 Rule 数量**

```bash
curl -s -u neo4j:testpassword123 -H "Content-Type: application/json" \
  -X POST http://localhost:7475/db/neo4j/tx/commit \
  -d '{"statements":[{"statement":"MATCH (n:Rule) RETURN count(n) AS cnt"}]}' | jq '.results[0].data[0].row[0]'
```
Expected: `248`(当前数量)

- [ ] **Step 3: 写迁移脚本骨架**

创建 `scripts/migrate-rules-v0-1-002.ts`:

```ts
// scripts/migrate-rules-v0-1-002.ts
//
// 一次性迁移脚本:把 neo4j_data/rules_v0_1_002.json 灌进:
//   1. lib/rule-check/rules.json  (本地 fallback,覆盖)
//   2. Neo4j :Rule 节点          (DETACH DELETE + UNWIND 重建)
//
// 跑法: npx tsx --env-file=.env.local scripts/migrate-rules-v0-1-002.ts
//
// GOVERNS 关系会随 DETACH DELETE 丢失 — 详见 spec §4.3。

import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(PROJECT_ROOT, 'neo4j_data', 'rules_v0_1_002.json');
const TARGET_JSON = path.join(PROJECT_ROOT, 'lib', 'rule-check', 'rules.json');

interface RawRule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: 'Agent' | 'Human';
  enforcementLevel: 'mandatory' | 'optional';
  failurePolicy: 'block' | 'warn';
}

interface RulesFile {
  metadata: { project_name: string; document_type: string; version: string; last_updated: string; description: string };
  rules: RawRule[];
}

async function main() {
  // 1. 读 + 验证源文件
  const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as RulesFile;
  if (raw.metadata.version !== '0.2') {
    throw new Error(`Expected version 0.2, got ${raw.metadata.version}`);
  }
  if (!Array.isArray(raw.rules) || raw.rules.length !== 248) {
    throw new Error(`Expected 248 rules, got ${raw.rules?.length}`);
  }
  for (const r of raw.rules) {
    if (!r.enforcementLevel || !r.failurePolicy) {
      throw new Error(`Rule ${r.id} missing enforcementLevel or failurePolicy`);
    }
  }
  console.log(`[migrate] source OK: 248 rules, version=${raw.metadata.version}`);

  // 2. Neo4j 操作
  const uri = process.env.NEO4J_INSTANCE_URI ?? 'bolt://localhost:7688';
  const user = process.env.NEO4J_INSTANCE_USER ?? 'neo4j';
  const pw = process.env.NEO4J_INSTANCE_PASSWORD ?? 'testpassword123';
  const db = process.env.NEO4J_INSTANCE_DATABASE ?? 'neo4j';
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pw));

  try {
    const session = driver.session({ database: db });
    try {
      // 2a. 记录现存 GOVERNS 关系数(post-check 用)
      const preGoverns = await session.run(
        `MATCH (:Rule)-[g:GOVERNS]->(:ActionStep) RETURN count(g) AS cnt`,
      );
      const preGovernsCount = preGoverns.records[0]?.get('cnt')?.toNumber() ?? 0;
      console.log(`[migrate] pre-flight: ${preGovernsCount} GOVERNS relationships exist`);

      // 2b. DETACH DELETE 全部 :Rule
      const delResult = await session.run(`MATCH (r:Rule) DETACH DELETE r RETURN count(r) AS deleted`);
      console.log(`[migrate] deleted Rule nodes`);

      // 2c. UNWIND 写入新 rules
      const insertResult = await session.run(
        `UNWIND $rules AS row
         CREATE (r:Rule)
         SET r = row, r.imported_at = datetime()
         RETURN count(r) AS inserted`,
        { rules: raw.rules },
      );
      const inserted = insertResult.records[0]?.get('inserted')?.toNumber() ?? 0;
      console.log(`[migrate] inserted ${inserted} Rule nodes`);

      // 2d. post-check
      const postCheck = await session.run(
        `MATCH (n:Rule) WHERE n.enforcementLevel IS NULL RETURN count(n) AS missing`,
      );
      const missing = postCheck.records[0]?.get('missing')?.toNumber() ?? 0;
      if (missing !== 0) throw new Error(`${missing} rules still missing enforcementLevel`);

      const sample = await session.run(
        `MATCH (n:Rule {id: '10-25'}) RETURN n.enforcementLevel, n.failurePolicy, n.businessLogicRuleName`,
      );
      const row = sample.records[0];
      console.log(
        `[migrate] sample rule 10-25: enforcementLevel=${row?.get('n.enforcementLevel')} ` +
          `failurePolicy=${row?.get('n.failurePolicy')} ` +
          `name="${row?.get('n.businessLogicRuleName')}"`,
      );
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }

  // 3. 覆盖本地 JSON
  fs.copyFileSync(SOURCE, TARGET_JSON);
  console.log(`[migrate] wrote ${TARGET_JSON}`);

  console.log('[migrate] ✅ complete. NOTE: GOVERNS relationships dropped — run restore script if needed.');
}

main().catch((e) => {
  console.error('[migrate] ❌ failed:', e);
  process.exit(1);
});
```

- [ ] **Step 4: 跑迁移脚本**

```bash
npx tsx --env-file=.env.local scripts/migrate-rules-v0-1-002.ts
```
Expected: print "source OK: 248 rules" → "deleted Rule nodes" → "inserted 248 Rule nodes" → sample rule 10-25 显示 `enforcementLevel=optional failurePolicy=warn name="华为荣耀竞对与客户互不挖角红线"` → "✅ complete"。

- [ ] **Step 5: post-flight Cypher 校验**

```bash
curl -s -u neo4j:testpassword123 -H "Content-Type: application/json" \
  -X POST http://localhost:7475/db/neo4j/tx/commit \
  -d '{"statements":[
    {"statement":"MATCH (n:Rule) RETURN count(n) AS total"},
    {"statement":"MATCH (n:Rule) WHERE n.enforcementLevel IS NULL OR n.failurePolicy IS NULL RETURN count(n) AS missing"},
    {"statement":"MATCH (n:Rule {id: \"2-4\"}) RETURN n.enforcementLevel, n.failurePolicy, n.applicableClient"}
  ]}' | jq '.results[] | .data[0].row'
```
Expected:
- total = 248
- missing = 0
- 2-4 = `["mandatory","block","字节"]`

- [ ] **Step 6: 验证本地 JSON 已覆盖**

```bash
jq -r '.metadata.version, [.rules[].enforcementLevel] | unique' \
  /Users/yuhancheng/Desktop/agenticOperator/lib/rule-check/rules.json
```
Expected:
```
0.2
[
  "mandatory",
  "optional"
]
```

- [ ] **Step 7: 提交**

```bash
git add scripts/migrate-rules-v0-1-002.ts lib/rule-check/rules.json
git commit -m "feat(rule-check): migrate rules to v0.1.002 (add enforcementLevel + failurePolicy)

- Add 248 rules with enforcementLevel (mandatory/optional) + failurePolicy (block/warn) fields
- Replace lib/rule-check/rules.json content
- Migration script DETACH DELETE + UNWIND-creates :Rule nodes in Neo4j
- Note: GOVERNS relationships dropped, restore separately if needed"
```

### Task 1.2: 更新 Rule TypeScript 类型(TDD)

**Files:**
- Modify: `lib/rule-check/types.ts`

- [ ] **Step 1: 读现有 Rule type**

```bash
grep -n "^export type Rule\b\|^export interface Rule" /Users/yuhancheng/Desktop/agenticOperator/lib/rule-check/types.ts
```

- [ ] **Step 2: 加 2 个 optional 字段**

在 `lib/rule-check/types.ts` 的 `Rule` type 末尾加:

```ts
export type Rule = {
  // ... existing fields
  /** New v0.1.002: 是否强制执行。`mandatory` 不可跳过,`optional` 可由 HSM 跳过。 */
  enforcementLevel?: 'mandatory' | 'optional';
  /** New v0.1.002: 失败时如何处理。`block` 立即终止 matchResume,`warn` 仅记录不中断。 */
  failurePolicy?: 'block' | 'warn';
  /** @deprecated v0.1.002 后从 enforcementLevel + failurePolicy derive。保留一个 release 防止 UI 编译失败。 */
  severity?: Severity;
};
```

(注:把 `severity` 改成 optional,因为 derive 后才填)

- [ ] **Step 3: 检查 TypeScript 编译**

```bash
npx tsc --noEmit -p .
```
Expected: 0 errors(severity 已 optional,旧代码不影响)。

- [ ] **Step 4: 提交**

```bash
git add lib/rule-check/types.ts
git commit -m "feat(rule-check): add enforcementLevel + failurePolicy to Rule type"
```

### Task 1.3: 删除 inferSeverity + 改 normalizeRaw + 加 derive 函数(TDD)

**Files:**
- Modify: `lib/rule-check/ontology.ts`
- Create: `lib/rule-check/ontology.test.ts`

- [ ] **Step 1: 写失败测试 — ontology.test.ts**

创建 `lib/rule-check/ontology.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyClientFilter, classifyRules, extractDims, normalizeRawRule } from './ontology';
import type { Rule } from './types';

describe('normalizeRawRule', () => {
  it('reads enforcementLevel + failurePolicy from raw rule and derives legacy severity', () => {
    const r = normalizeRawRule({
      id: '10-25',
      specificScenarioStage: '简历匹配',
      businessLogicRuleName: 'sample',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      submissionCriteria: '',
      standardizedLogicRule: 'sample logic',
      relatedEntities: [],
      businessBackgroundReason: '',
      ruleSource: '',
      executor: 'Agent',
      enforcementLevel: 'mandatory',
      failurePolicy: 'block',
    });
    expect(r.enforcementLevel).toBe('mandatory');
    expect(r.failurePolicy).toBe('block');
    expect(r.severity).toBe('terminal'); // mandatory + block → terminal
  });

  it('derives severity=flag_only for optional + warn', () => {
    const r = normalizeRawRule({
      id: '10-26',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'optional',
      failurePolicy: 'warn',
    } as any);
    expect(r.severity).toBe('flag_only');
  });

  it('derives severity=needs_human for mixed enforcement/failure combo', () => {
    const r = normalizeRawRule({
      id: '10-27',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'optional',
      failurePolicy: 'block',
    } as any);
    expect(r.severity).toBe('needs_human');
  });

  it('falls back to flag_only when enforcement fields missing (legacy json compat)', () => {
    const r = normalizeRawRule({
      id: '10-99',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
    } as any);
    expect(r.severity).toBe('flag_only');
    expect(r.enforcementLevel).toBeUndefined();
    expect(r.failurePolicy).toBeUndefined();
  });
});

describe('applyClientFilter (unchanged behavior)', () => {
  const sampleRules: Rule[] = [
    { id: '1', applicableClient: '通用', applicableDepartment: 'N/A', executor: 'Agent' } as Rule,
    { id: '2', applicableClient: '字节', applicableDepartment: 'N/A', executor: 'Agent' } as Rule,
    { id: '3', applicableClient: '字节', applicableDepartment: 'IEG', executor: 'Agent' } as Rule,
    { id: '4', applicableClient: '通用', applicableDepartment: 'N/A', executor: 'Human' } as Rule,
  ];

  it('includes 通用 rules and matching-client rules; excludes Human-executor', () => {
    const r = applyClientFilter(sampleRules, { client_id: '字节', business_group: null, studio: null });
    expect(r.map((x) => x.id).sort()).toEqual(['1', '2']);
  });

  it('matches department rule when business_group provided', () => {
    const r = applyClientFilter(sampleRules, { client_id: '字节', business_group: 'IEG', studio: null });
    expect(r.map((x) => x.id).sort()).toEqual(['1', '2', '3']);
  });
});
```

- [ ] **Step 2: 跑测试 — 应该失败**

```bash
npx vitest run lib/rule-check/ontology.test.ts
```
Expected: FAIL — `normalizeRawRule` is not exported(还没改 ontology.ts)。

- [ ] **Step 3: 修改 ontology.ts**

打开 `lib/rule-check/ontology.ts`,做以下改动:

(a) 删除 31-83 行整个 `inferSeverity()` 函数 + 33 关键词常量;

(b) 新增 `deriveLegacySeverity` helper(放在原 inferSeverity 位置):

```ts
function deriveLegacySeverity(
  enforcementLevel: 'mandatory' | 'optional' | undefined,
  failurePolicy: 'block' | 'warn' | undefined,
): Severity {
  if (enforcementLevel === 'mandatory' && failurePolicy === 'block') return 'terminal';
  if (enforcementLevel === 'optional' && failurePolicy === 'warn') return 'flag_only';
  if (enforcementLevel === undefined || failurePolicy === undefined) return 'flag_only';
  return 'needs_human';
}
```

(c) 改 `RawRule` interface(15-27 行)加 2 字段:

```ts
interface RawRule {
  id: string;
  specificScenarioStage?: string;
  businessLogicRuleName?: string;
  applicableClient?: string;
  applicableDepartment?: string;
  submissionCriteria?: string;
  standardizedLogicRule?: string;
  relatedEntities?: string[];
  businessBackgroundReason?: string;
  ruleSource?: string;
  executor: 'Agent' | 'Human';
  enforcementLevel?: 'mandatory' | 'optional';
  failurePolicy?: 'block' | 'warn';
}
```

(d) 改 `normalizeRaw()`(85-101 行)读新字段:

```ts
function normalizeRaw(r: RawRule): Rule {
  const standardizedLogicRule = r.standardizedLogicRule ?? '';
  return {
    id: r.id,
    specificScenarioStage: r.specificScenarioStage ?? '',
    businessLogicRuleName: r.businessLogicRuleName ?? '',
    applicableClient: r.applicableClient ?? '通用',
    applicableDepartment: r.applicableDepartment ?? 'N/A',
    submissionCriteria: r.submissionCriteria ?? '',
    standardizedLogicRule,
    relatedEntities: r.relatedEntities ?? [],
    businessBackgroundReason: r.businessBackgroundReason ?? '',
    ruleSource: r.ruleSource ?? '',
    executor: r.executor,
    enforcementLevel: r.enforcementLevel,
    failurePolicy: r.failurePolicy,
    severity: deriveLegacySeverity(r.enforcementLevel, r.failurePolicy),
  };
}
```

(e) 把 `normalizeRaw` 改 export 名 `normalizeRawRule`(测试用):

```ts
export function normalizeRawRule(r: RawRule): Rule {
  // ... same body
}
```

(改 `loadAllRules` 里的引用)

- [ ] **Step 4: 跑测试 — 应该通过**

```bash
npx vitest run lib/rule-check/ontology.test.ts
```
Expected: 7 tests PASS.

- [ ] **Step 5: 跑全套 rule-check 测试,确保没有 regression**

```bash
npx vitest run lib/rule-check
```
Expected: 全部 PASS(已有 runner / ontology-source / prompt 测试可能因 fixture 缺新字段而失败,见 Task 1.4)。如果有 fail,记录失败列表,task 1.4 修。

- [ ] **Step 6: 提交**

```bash
git add lib/rule-check/ontology.ts lib/rule-check/ontology.test.ts
git commit -m "refactor(rule-check): replace inferSeverity heuristic with enforcementLevel + failurePolicy

- Delete 33-keyword inferSeverity() function
- Add deriveLegacySeverity(enforcementLevel, failurePolicy) → Severity
- normalizeRaw reads new fields and derives severity for backward-compat
- Add ontology.test.ts covering all derivation paths"
```

### Task 1.4: 修 mock fixtures 加新字段(TDD)

**Files:**
- Modify: `lib/rule-check/runner.test.ts`
- Modify: `lib/rule-check/ontology-source.test.ts`
- Modify: `lib/rule-check/prompt.test.ts`

- [ ] **Step 1: 跑 runner.test.ts 看哪里失败**

```bash
npx vitest run lib/rule-check/runner.test.ts 2>&1 | head -50
```

- [ ] **Step 2: 给 fixture rules 加上 enforcementLevel + failurePolicy**

每个测试文件里的 fixture Rule object 加这两字段(默认 `optional` + `warn`,除非测试需要 specific 值)。

例:
```ts
{ id: '10-1', businessLogicRuleName: 'foo', applicableClient: '通用', executor: 'Agent',
  enforcementLevel: 'optional', failurePolicy: 'warn', /* ... */ }
```

- [ ] **Step 3: 跑测试 — 应该通过**

```bash
npx vitest run lib/rule-check
```
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add lib/rule-check/runner.test.ts lib/rule-check/ontology-source.test.ts lib/rule-check/prompt.test.ts
git commit -m "test(rule-check): add enforcementLevel/failurePolicy to mock fixtures"
```

### Task 1.5: prompt.ts 改 severity 渲染

**Files:**
- Modify: `lib/rule-check/prompt.ts:74-80` (renderRuleBlock)
- Modify: `lib/rule-check/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

在 `prompt.test.ts` 加 case:

```ts
it('renders enforcement + failure policy in rule block header', () => {
  const rule: Rule = {
    id: '10-5',
    businessLogicRuleName: 'degree-check',
    applicableClient: '通用',
    standardizedLogicRule: 'check degree',
    enforcementLevel: 'mandatory',
    failurePolicy: 'block',
    severity: 'terminal',
    // ... other required fields
  } as Rule;
  const out = renderRuleBlock(rule); // export it if not already
  expect(out).toContain('enforcement=mandatory');
  expect(out).toContain('onFail=block');
  expect(out).not.toContain('severity=');
});
```

(确保 `renderRuleBlock` export — 现在是模块内函数;改成 export 即可。)

- [ ] **Step 2: 跑测试 — 应该失败**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```
Expected: FAIL — 当前 `severity=` 还在 output 里。

- [ ] **Step 3: 改 renderRuleBlock(prompt.ts:74-80)**

```ts
function renderRuleBlock(r: Rule): string {
  const enforcement = r.enforcementLevel ?? 'optional';
  const onFail = r.failurePolicy ?? 'warn';
  return [
    `#### Rule ${r.id}: ${r.businessLogicRuleName}  [applicableClient=${r.applicableClient}, enforcement=${enforcement}, onFail=${onFail}]`,
    `- submissionCriteria: ${r.submissionCriteria || 'N/A'}`,
    `- logic: ${r.standardizedLogicRule}`,
  ].join('\n');
}
export { renderRuleBlock };
```

- [ ] **Step 4: 跑测试 — 应该通过**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/rule-check/prompt.ts lib/rule-check/prompt.test.ts
git commit -m "feat(rule-check): render enforcement+onFail in rule block header"
```

### Task 1.6: UI 适配 — severity badge 改用新字段

**Files:**
- Modify: `components/rule-check/CaseDrawer.tsx`(grep `severity` 看哪里有渲染)
- Modify: `components/rule-check/ScenarioMatrix.tsx`(同上)
- Modify: `lib/i18n.tsx`(加 4 个 i18n key)

- [ ] **Step 1: 找 UI 哪里渲染 severity**

```bash
grep -rn "severity" /Users/yuhancheng/Desktop/agenticOperator/components/rule-check/ /Users/yuhancheng/Desktop/agenticOperator/app/rule-check/ 2>/dev/null | grep -v ".test."
```
列出所有命中位置。

- [ ] **Step 2: 加 i18n key**

在 `lib/i18n.tsx` 的 zh + en 字典里加:

```ts
// zh:
rc_enforcement_mandatory: '强制',
rc_enforcement_optional: '可选',
rc_on_fail_block: '阻断',
rc_on_fail_warn: '警告',

// en:
rc_enforcement_mandatory: 'mandatory',
rc_enforcement_optional: 'optional',
rc_on_fail_block: 'block',
rc_on_fail_warn: 'warn',
```

- [ ] **Step 3: 替换 UI 里 severity badge 为 enforcement + failurePolicy 两段**

具体改法因组件而异;一般是 `<Badge>{t(`rc_severity_${severity}`)}</Badge>` 改成两个 badge,一个显示 enforcement 一个显示 failurePolicy。

- [ ] **Step 4: 启动 dev server,手工验证**

```bash
npm run dev
# 打开 http://localhost:3002/rule-check
```
Expected: 矩阵单元格、抽屉里的 rule detail 显示新两段 badge,不再有"terminal/needs_human/flag_only"字样。

- [ ] **Step 5: 提交**

```bash
git add components/rule-check/ lib/i18n.tsx
git commit -m "feat(rule-check ui): replace severity badge with enforcement+onFail two-tag display"
```

### Chunk 1 Wrap-up

- [ ] **跑全套测试**

```bash
npm run test
```
Expected: 0 failures。

- [ ] **跑 build 检查 TypeScript + lint**

```bash
npm run build
```
Expected: build OK。

- [ ] **(可选) restore GOVERNS 关系** — 如果 monitor / rule-check UI 表现出 `(:Rule)-[:GOVERNS]->(:ActionStep)` 关系缺失的影响,跑:

```bash
# scripts/restore-governs-relationships.ts 当前不存在 — 留 follow-up,实在需要时再做
```

---

## Chunk 2: PR-2 — RoboHire 直连客户端 `lib/robohire-client.ts`

> **目标**:新建 `lib/robohire-client.ts`,提供 `parseResumeDirect` + `matchResumeDirect` 直连 `api.robohire.io`。
>
> **独立**:不动任何 agent。完成后 `lib/robohire-client.ts` 可被任何 caller 调用,但还没被调。

### Files

- Create: `lib/robohire-client.ts`
- Create: `lib/robohire-client.test.ts`
- Create: `scripts/smoke-test-robohire.ts`(开发者手工跑的 live smoke)
- Modify: `.env.local` + `.env.example`

### Task 2.1: env 配置

- [ ] **Step 1: 加 env vars 到 `.env.local`**

打开 `/Users/yuhancheng/Desktop/agenticOperator/.env.local`,在 RAAS 配置块之后加:

```bash
# ─── RoboHire direct API (PR-2, 2026-05-19) ─────────────────────────
# AO directly calls RoboHire for parse-resume / match-resume — bypasses
# RAAS API Server's transparent-proxy endpoints. See:
#   docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §3
ROBOHIRE_API_BASE_URL=https://api.robohire.io
ROBOHIRE_API_KEY=rh_ed0264681b5587cfbd0e4ef556a3b1323e43444603828a0b
ROBOHIRE_TIMEOUT_MS=120000
```

- [ ] **Step 2: 加 env vars 到 `.env.example`**(不带真 key)

```bash
# RoboHire direct API
ROBOHIRE_API_BASE_URL=https://api.robohire.io
ROBOHIRE_API_KEY=rh_replace_me
ROBOHIRE_TIMEOUT_MS=120000
```

- [ ] **Step 3: 提交**

```bash
git add .env.example
git commit -m "chore(env): document ROBOHIRE_API_* env vars in .env.example"
```

(`.env.local` 是 gitignored — 不提交)

### Task 2.2: 写失败测试

**Files:**
- Create: `lib/robohire-client.test.ts`

- [ ] **Step 1: 写测试文件**

创建 `lib/robohire-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseResumeDirect,
  matchResumeDirect,
  RobohireApiError,
} from './robohire-client';

const env = {
  ROBOHIRE_API_BASE_URL: 'https://api.robohire.io',
  ROBOHIRE_API_KEY: 'rh_test_key',
  ROBOHIRE_TIMEOUT_MS: '120000',
};

beforeEach(() => {
  Object.assign(process.env, env);
  vi.restoreAllMocks();
});

describe('parseResumeDirect', () => {
  it('returns parsed data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { name: 'John', skills: ['React'] },
          cached: false,
          requestId: 'req_abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await parseResumeDirect(Buffer.from('%PDF-1.4'), 'r.pdf');
    expect(r.data.name).toBe('John');
    expect(r.requestId).toBe('req_abc');
    expect(r.cached).toBe(false);
  });

  it('throws RobohireApiError with CLIENT code on 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'PDF required', requestId: 'req_xyz' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from(''), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 400,
      code: 'CLIENT',
      requestId: 'req_xyz',
    });
  });

  it('throws RobohireApiError with RATE_LIMITED on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('throws QUOTA_EXHAUSTED on 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'quota exhausted' }), { status: 402 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
  });

  it('passes X-Trace-Id header when opts.traceId set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {}, cached: true, requestId: 'r' })));
    await parseResumeDirect(Buffer.from('%PDF'), 'r.pdf', { traceId: 'trace-123' });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-123');
  });
});

describe('matchResumeDirect', () => {
  it('returns match data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { matchScore: 87, recommendation: 'STRONG_MATCH', summary: 'good' },
          requestId: 'req_match_123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await matchResumeDirect({ resume: 'resume text', jd: 'jd text' });
    expect(r.data.matchScore).toBe(87);
    expect(r.data.recommendation).toBe('STRONG_MATCH');
  });

  it('serializes resume + jd as JSON body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { matchScore: 50, recommendation: 'PARTIAL_MATCH' }, requestId: 'r' })));
    await matchResumeDirect({ resume: 'R', jd: 'J' });
    const body = JSON.parse(((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}'));
    expect(body).toEqual({ resume: 'R', jd: 'J' });
  });
});

describe('RobohireApiError', () => {
  it('isClientError true for 4xx (excluding 429)', () => {
    expect(new RobohireApiError(400, 'CLIENT', 'x').isClientError).toBe(true);
    expect(new RobohireApiError(429, 'RATE_LIMITED', 'x').isClientError).toBe(false);
    expect(new RobohireApiError(500, 'SERVER', 'x').isClientError).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试 — 应该全部失败**

```bash
npx vitest run lib/robohire-client.test.ts
```
Expected: FAIL — module not found。

### Task 2.3: 实现 robohire-client.ts

**Files:**
- Create: `lib/robohire-client.ts`

- [ ] **Step 1: 写客户端实现**

创建 `lib/robohire-client.ts`:

```ts
// AO ↔ RoboHire direct client.
//
// AO 不再通过 RAAS API Server 的 transparent-proxy 端点(/api/v1/parse-resume,
// /api/v1/match-resume) 调 RoboHire,改成直连 https://api.robohire.io。
//
// 仅 RoboHire-能力直连;持久化端点(/candidates, /match-results, /jd/sync-generated)
// 仍走 RAAS API Server,因为它们写 Postgres,RAAS 是 source of truth。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §3。

const DEFAULT_TIMEOUT_MS = 120_000;

function config(): { baseUrl: string; apiKey: string; timeoutMs: number } {
  const baseUrl = process.env.ROBOHIRE_API_BASE_URL?.trim();
  const apiKey = process.env.ROBOHIRE_API_KEY?.trim();
  if (!baseUrl) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_BASE_URL not set');
  if (!apiKey) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_KEY not set');
  const timeoutMs = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return { baseUrl, apiKey, timeoutMs };
}

export class RobohireApiError extends Error {
  constructor(
    public httpStatus: number,
    public code: 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK',
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'RobohireApiError';
  }
  /** 4xx (except 429) — caller should NonRetriable. */
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
}

function statusToCode(status: number): RobohireApiError['code'] {
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'SERVER';
}

export type CommonOpts = { traceId?: string; timeoutMs?: number };

// ─── parse-resume ───────────────────────────────────────────────

export type RobohireParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string; company?: string; location?: string;
    startDate?: string; endDate?: string;
    description?: string; highlights?: string[];
  }>;
  education?: Array<{
    degree?: string; field?: string; institution?: string; graduationYear?: string;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
  [k: string]: unknown;
};

export type RobohireParseResumeResponse = {
  data: RobohireParseResumeData;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  requestId: string;
};

export async function parseResumeDirect(
  pdf: Buffer,
  filename: string,
  opts: CommonOpts = {},
): Promise<RobohireParseResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), filename);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/parse-resume`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    });
  } catch (e) {
    throw new RobohireApiError(0, 'NETWORK', `parse-resume fetch failed: ${(e as Error).message}`);
  }

  return handleJsonResponse<RobohireParseResumeResponse>(res, 'parse-resume');
}

// ─── match-resume ───────────────────────────────────────────────

export type RobohireMatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type RobohireMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type RobohireMatchResumeResponse = {
  data: RobohireMatchResumeData;
  requestId: string;
  savedAs?: string;
};

export async function matchResumeDirect(
  input: RobohireMatchResumeInput,
  opts: CommonOpts = {},
): Promise<RobohireMatchResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/match-resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    });
  } catch (e) {
    throw new RobohireApiError(0, 'NETWORK', `match-resume fetch failed: ${(e as Error).message}`);
  }

  return handleJsonResponse<RobohireMatchResumeResponse>(res, 'match-resume');
}

// ─── shared response handler ────────────────────────────────────

async function handleJsonResponse<T>(res: Response, op: string): Promise<T> {
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const code = statusToCode(res.status);
    const errMsg = body?.error ?? `${op} ${res.status} ${res.statusText}`;
    const requestId = body?.requestId;
    throw new RobohireApiError(res.status, code, errMsg, requestId);
  }

  if (!body || body.success === false) {
    throw new RobohireApiError(
      res.status,
      'SERVER',
      `${op} returned success=false: ${body?.error ?? 'unknown'}`,
      body?.requestId,
    );
  }

  return body as T;
}
```

- [ ] **Step 2: 跑测试 — 应该全部通过**

```bash
npx vitest run lib/robohire-client.test.ts
```
Expected: 8 PASS, 0 FAIL。

- [ ] **Step 3: 跑 build 验证 TypeScript**

```bash
npm run build 2>&1 | tail -20
```
Expected: build OK。

- [ ] **Step 4: 提交**

```bash
git add lib/robohire-client.ts lib/robohire-client.test.ts
git commit -m "feat(robohire): add direct-API client for parse-resume + match-resume

- New lib/robohire-client.ts: parseResumeDirect, matchResumeDirect, RobohireApiError
- HTTP→error code mapping: 4xx→CLIENT, 402→QUOTA_EXHAUSTED, 429→RATE_LIMITED, 5xx→SERVER
- Reads ROBOHIRE_API_BASE_URL + ROBOHIRE_API_KEY env vars
- 8 unit tests with mocked fetch covering success / error / trace-id / body serialization"
```

### Task 2.4: live smoke 脚本(开发者手工跑)

**Files:**
- Create: `scripts/smoke-test-robohire.ts`

- [ ] **Step 1: 写脚本**

```ts
// scripts/smoke-test-robohire.ts
//
// 手工跑一次真实 RoboHire 直连,验证 key + 网络 + payload 解析。
// CI 不跑(会扣 quota)。开发者上 PR-2 时跑一次。
//
// 跑法: npx tsx --env-file=.env.local scripts/smoke-test-robohire.ts <path-to-pdf>

import fs from 'node:fs';
import { parseResumeDirect, matchResumeDirect } from '../lib/robohire-client';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: smoke-test-robohire.ts <path-to-pdf>');
    process.exit(1);
  }
  const pdf = fs.readFileSync(pdfPath);
  console.log(`[smoke] reading ${pdfPath} (${pdf.length} bytes)`);

  console.log('[smoke] calling parseResumeDirect...');
  const t0 = Date.now();
  const parsed = await parseResumeDirect(pdf, 'smoke.pdf', { traceId: 'smoke-trace-1' });
  console.log(
    `[smoke] parse OK in ${Date.now() - t0}ms · cached=${parsed.cached} · name="${parsed.data.name}" · requestId=${parsed.requestId}`,
  );

  console.log('[smoke] calling matchResumeDirect...');
  const t1 = Date.now();
  const match = await matchResumeDirect(
    {
      resume: `${parsed.data.name}\n${parsed.data.summary ?? ''}\nSkills: ${(parsed.data.skills ?? []).join(', ')}`,
      jd: 'We are hiring a Senior Frontend Developer with React expertise.',
    },
    { traceId: 'smoke-trace-1' },
  );
  console.log(
    `[smoke] match OK in ${Date.now() - t1}ms · score=${match.data.matchScore} · rec=${match.data.recommendation} · requestId=${match.requestId}`,
  );

  console.log('[smoke] ✅ both calls succeeded');
}

main().catch((e) => {
  console.error('[smoke] ❌ failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 跑一次(用户决定要不要执行)**

```bash
# 找一份测试 PDF (resume-parser-agent 仓库或 tests fixture 都行)
# 例:
npx tsx --env-file=.env.local scripts/smoke-test-robohire.ts /Users/yuhancheng/Desktop/agenticOperator/tests/fixtures/sample-resume.pdf
```
Expected: print "parse OK" + "match OK" + "✅ both calls succeeded"。

> **注意**:这一步会真实扣 RoboHire match quota 一次。再跑同一 PDF 的 parse 会返回 `cached: true` 不扣 quota,但 match 不缓存,每次都扣。

- [ ] **Step 3: 提交脚本**

```bash
git add scripts/smoke-test-robohire.ts
git commit -m "test(robohire): add live smoke script for PR-2 verification"
```

### Chunk 2 Wrap-up

- [ ] 跑全套测试:`npm run test`
- [ ] 跑 build:`npm run build`
- [ ] live smoke 至少 1 次

---

## Chunk 3: PR-3 — resumeParserAgent 切换 parse-resume 到直连

> **目标**:`resumeParserAgent` 里 `parseResume(buffer, name, opts)` 调用换成 `parseResumeDirect(...)`。`POST /candidates` 保留(RAAS Postgres 写入)。
>
> **依赖**:Chunk 2 已合并(`lib/robohire-client.ts` 可用)。
>
> **独立可上线**。这一步上线后,Inngest run 里的"download-and-parse" step 不再调 RAAS proxy,直接打 RoboHire。

### Files

- Modify: `server/inngest/agents/resume-parser-agent.ts`(单文件单函数替换)

### Task 3.1: 切换 parse-resume

- [ ] **Step 1: 读现有调用点**

```bash
grep -n "parseResume\b" /Users/yuhancheng/Desktop/agenticOperator/server/inngest/agents/resume-parser-agent.ts
```
Expected: 看到 line 25 `import` + line 121 调用。

- [ ] **Step 2: 改 import 和调用**

打开 `server/inngest/agents/resume-parser-agent.ts`:

(a) 第 25 行替换 import:

```ts
// Before
import {
  downloadResumeRaw,
  parseResume,
  saveCandidate,
  RaasApiError,
  type RaasParseResumeData,
  type SaveCandidateInput,
} from '@/lib/raas-api-client';

// After
import {
  downloadResumeRaw,
  saveCandidate,
  RaasApiError,
  type RaasParseResumeData,
  type SaveCandidateInput,
} from '@/lib/raas-api-client';
import { parseResumeDirect, RobohireApiError } from '@/lib/robohire-client';
```

(b) 第 120 行附近,把 `parseResume(pdfBuffer, pdfFilename, { traceId })` 改成 `parseResumeDirect(pdfBuffer, pdfFilename, { traceId })`:

```ts
// Before (line ~119-128):
let parseRes;
try {
  parseRes = await parseResume(pdfBuffer, pdfFilename, { traceId });
} catch (e) {
  if (e instanceof RaasApiError && e.isClientError) {
    throw new NonRetriableError(
      `RAAS POST /parse-resume 4xx: ${e.code} ${e.message}`,
    );
  }
  throw e;
}

// After:
let parseRes;
try {
  parseRes = await parseResumeDirect(pdfBuffer, pdfFilename, { traceId });
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(
      `RoboHire POST /parse-resume 4xx: ${e.httpStatus} ${e.code} ${e.message}`,
    );
  }
  throw e;
}
```

(c) 调整 log message(line ~131):"RAAS parse-resume OK" → "RoboHire parse-resume OK"。

(d) `RaasParseResumeData` 类型在 saveCandidate input 里也有用 — 它和 `RobohireParseResumeData` 形状 1:1 一致(RAAS 是透明 proxy,数据来源是 RoboHire),所以保留 `as unknown as RaasParseResumeData` cast 即可。改:

```ts
// 在 download-and-parse step 返回值的 `parsed` 字段加 cast(如果 TS 编译报错):
return {
  parsed: parseRes.data as unknown as RaasParseResumeData,
  // ...
};
```

- [ ] **Step 3: 跑 TypeScript build 看 lint / 类型**

```bash
npm run build 2>&1 | tail -30
```
Expected: build OK。如果有 RaasParseResumeData 类型不兼容报错,加 cast 修(参考 Step 2d)。

- [ ] **Step 4: 跑相关测试**

```bash
npx vitest run server/inngest/agents/ 2>&1 | tail -20
```
Expected: PASS(若 resume-parser-agent 没有单测,只看不其他模块受影响)。

- [ ] **Step 5: 启动 dev server + Inngest dev,触发一条 RESUME_DOWNLOADED**

```bash
# Terminal 1
npm run inngest:up
# Terminal 2
npm run dev
# Terminal 3 (触发测试事件)
npm run publish:test
```

Expected:
- Inngest dev UI(http://localhost:8288)看到 resumeParserAgent run
- Step `download-and-parse-*` log 包含 "RoboHire parse-resume OK" 而非 "RAAS"
- Final step `save-candidate` 仍调 RAAS POST /candidates,返回 candidate_id

- [ ] **Step 6: 提交**

```bash
git add server/inngest/agents/resume-parser-agent.ts
git commit -m "feat(resume-parser): switch parse-resume to direct RoboHire call

- Replace parseResume (RAAS proxy) with parseResumeDirect (lib/robohire-client)
- POST /candidates still goes through RAAS API Server (writes Postgres)
- Error path: RobohireApiError 4xx → NonRetriableError (same semantics as before)"
```

### Chunk 3 Wrap-up

- [ ] **跑端到端 smoke**:在 Inngest dev 触发 RESUME_DOWNLOADED → 确认下游 RESUME_PROCESSED 发出 + saveCandidate 成功
- [ ] **回滚预案**:revert 该 PR 即可,不需要数据迁移

---

## Chunk 4: PR-4 — ruleCheckAgent NEW + matchResumeAgent 双段重构 + match-resume 直连

> **目标**:
> - 新建 `ruleCheckAgent`(订阅 `RULE_CHECK_REQUESTED`)
> - 把 `matchResumeAgent` 拆双段(订阅 `RESUME_PROCESSED` + `RULE_CHECK_PASSED`)
> - 删除 `RULE_CHECK_ENABLED` 内嵌 gate
> - `matchResume` 调用切换到 `matchResumeDirect`(RoboHire 直连)
>
> **依赖**:Chunk 1, 2, 3 已合并。
>
> **风险**:这是本 spec 风险最高的 chunk,涉及事件链改造。需要在 Inngest dev 完整跑通后再合并。

### Files

- Modify: `server/inngest/client.ts`(新增 `RULE_CHECK_REQUESTED` event + 扩展 `RuleCheckPassedData`)
- Create: `server/inngest/agents/rule-check-agent.ts`
- Modify: `server/inngest/agents/match-resume-agent.ts`(大改 — 双段订阅 + 删 rule-check 段 + 切 matchResumeDirect)
- Modify: `server/inngest/functions.ts`(注册 ruleCheckAgent)
- Create: `server/inngest/agents/rule-check-agent.test.ts`
- Modify: `server/inngest/agents/match-resume-agent.test.ts`(若存在;否则新建)

### Task 4.1: 扩展 event schemas

**Files:**
- Modify: `server/inngest/client.ts`

- [ ] **Step 1: 新增 `RuleCheckRequestedData` type**

在 `server/inngest/client.ts` 的 §3.5 块(line 131 附近)加:

```ts
/**
 * Rule check 请求事件 — matchResumeAgent 第一段对每条 JR emit 一条,
 * 触发 ruleCheckAgent 跑 LLM 评估。
 *
 * 新增 in PR-4 (2026-05-19)。之前 rule-check 内嵌在 matchResumeAgent step 4.0。
 */
export type RuleCheckRequestedData = {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  job_requisition_id: string;
  client_id?: string;
  // 完整 JR 对象 + parsed resume — 给 ruleCheckAgent 用,避免再去拉 RAAS
  job_requisition: Record<string, unknown>;
  parsed_resume: Record<string, unknown> | null;
  // runtime_context 由 ruleCheckAgent 转给 buildRuleCheckInput
  runtime_context: {
    upload_id: string;
    candidate_id: string;
    resume_id: string;
    employee_id: string;
    filename?: string;
    received_at?: string;
    trace_id?: string | null;
  };
  trace_id?: string | null;
};
```

- [ ] **Step 2: 扩展 `RuleCheckPassedData`**

把 `RuleCheckPassedData`(line 148-155 附近)扩成:

```ts
export type RuleCheckPassedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  audit: RuleCheckAuditMeta;
  // ── NEW in PR-4: 透传给 matchResumeAgent 第二段(订阅 RULE_CHECK_PASSED) ──
  /** Full JR object — 第二段调 matchResumeDirect 时拼 jd text。 */
  job_requisition: Record<string, unknown>;
  /** Parsed resume(可能为 null,如果 RoboHire parse 之后没拿到)。 */
  parsed_resume: Record<string, unknown> | null;
  /** runtime_context 透传(主要 traceId)。 */
  runtime_context?: RuleCheckRequestedData['runtime_context'];
  /** employee_id 给第二段 saveMatchResults 用。 */
  employee_id?: string;
};
```

- [ ] **Step 3: 跑 build 检查类型**

```bash
npm run build 2>&1 | tail -10
```
Expected: build OK (现在没人 emit / consume 新字段,但类型对齐 — should compile)。

- [ ] **Step 4: 提交**

```bash
git add server/inngest/client.ts
git commit -m "feat(events): add RULE_CHECK_REQUESTED event + extend RULE_CHECK_PASSED payload

- New RuleCheckRequestedData type for matchResumeAgent→ruleCheckAgent handoff
- RuleCheckPassedData now carries job_requisition + parsed_resume + runtime_context
  for matchResumeAgent's 2nd-segment subscriber to consume without re-fetching"
```

### Task 4.2: 新建 ruleCheckAgent — 写测试

**Files:**
- Create: `server/inngest/agents/rule-check-agent.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ruleCheckAgent } from './rule-check-agent';
import * as ruleCheckLib from '@/lib/rule-check';
import * as ontologyLib from '@/lib/rule-check/ontology';

// Helper: build a minimal RULE_CHECK_REQUESTED event payload
function evt(over: Record<string, unknown> = {}) {
  return {
    name: 'RULE_CHECK_REQUESTED',
    data: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'EMP_TEST',
      job_requisition_id: 'JR1',
      client_id: 'CLI_TENCENT',
      job_requisition: { job_requisition_id: 'JR1', client_id: 'CLI_TENCENT' },
      parsed_resume: { name: 'John' },
      runtime_context: {
        upload_id: 'U1', candidate_id: 'C1', resume_id: 'R1', employee_id: 'EMP_TEST', trace_id: null,
      },
      ...over,
    },
  };
}

// Helper: mock step.run / step.sendEvent
function mockStep() {
  const sent: Array<{ name: string; data: any }> = [];
  return {
    sent,
    run: async (_id: string, fn: () => Promise<unknown>) => await fn(),
    sendEvent: async (_id: string, e: { name: string; data: any }) => {
      sent.push(e);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ruleCheckAgent', () => {
  it('emits RULE_CHECK_PASSED when runRuleCheck returns PASS', async () => {
    vi.spyOn(ruleCheckLib, 'runRuleCheck').mockResolvedValue({
      decision: 'PASS',
      stats: { total: 5, pass: 5, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [],
      audit: {
        rules_evaluated: 5, graph_calls: 6,
        llm_model: 'gemini', llm_duration_ms: 1234, llm_round_trips: 0,
        rule_source: 'json-fallback',
      },
    } as any);
    vi.spyOn(ontologyLib, 'extractDims').mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });

    const step = mockStep();
    const fn = ruleCheckAgent.fn;
    await fn({ event: evt() as any, step: step as any, logger: console as any } as any);

    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('RULE_CHECK_PASSED');
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.job_requisition).toEqual({ job_requisition_id: 'JR1', client_id: 'CLI_TENCENT' });
    expect(step.sent[0].data.parsed_resume).toEqual({ name: 'John' });
  });

  it('emits RULE_CHECK_FAILED when runRuleCheck returns FAIL', async () => {
    vi.spyOn(ruleCheckLib, 'runRuleCheck').mockResolvedValue({
      decision: 'FAIL',
      stats: { total: 5, pass: 4, fail: 1, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-5', rule_name: 'degree', step_id: 'STEP1', status: 'fail', reason: 'no degree' },
      ],
      audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
    } as any);
    vi.spyOn(ontologyLib, 'extractDims').mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });

    const step = mockStep();
    const fn = ruleCheckAgent.fn;
    await fn({ event: evt() as any, step: step as any, logger: console as any } as any);

    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('RULE_CHECK_FAILED');
    expect(step.sent[0].data.decision).toBe('FAIL');
    expect(step.sent[0].data.failed_rules).toHaveLength(1);
  });

  it('emits RULE_CHECK_FAILED with decision=REVIEW when REVIEW returned', async () => {
    vi.spyOn(ruleCheckLib, 'runRuleCheck').mockResolvedValue({
      decision: 'REVIEW',
      stats: { total: 5, pass: 4, fail: 0, pending: 1, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [{ rule_id: '10-21', rule_name: 'age', step_id: 'S2', status: 'pending', reason: 'needs HSM review' }],
      audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
    } as any);
    vi.spyOn(ontologyLib, 'extractDims').mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });

    const step = mockStep();
    await ruleCheckAgent.fn({ event: evt() as any, step: step as any, logger: console as any } as any);

    expect(step.sent[0].name).toBe('RULE_CHECK_FAILED');
    expect(step.sent[0].data.decision).toBe('REVIEW');
  });
});
```

- [ ] **Step 2: 跑测试 — 应该失败**

```bash
npx vitest run server/inngest/agents/rule-check-agent.test.ts
```
Expected: FAIL — module not found。

### Task 4.3: 实现 ruleCheckAgent

**Files:**
- Create: `server/inngest/agents/rule-check-agent.ts`

- [ ] **Step 1: 写 agent**

```ts
// ruleCheckAgent — Workflow node 10.5 (NEW PR-4 2026-05-19).
//
// 订阅 RULE_CHECK_REQUESTED(由 matchResumeAgent 第一段 emit),跑 LLM
// rule check,根据 decision emit RULE_CHECK_PASSED / RULE_CHECK_FAILED。
//
// runRuleCheck 内部已 fail-safe in-band(异常返回 decision='FAIL'+audit.fail_reason),
// 不会抛错。retries=1 主要是为 Inngest step.run 自己的层级异常兜底。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §5.2

import { buildRuleCheckInput, runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import {
  inngest,
  type RuleCheckRequestedData,
  type RuleCheckPassedData,
  type RuleCheckFailedData,
  type RuleCheckAuditMeta,
} from '@/server/inngest/client';

const AGENT_ID = 'rule-check-agent';
const AGENT_NAME = 'ruleCheck';

export const ruleCheckAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Rule Check Agent (workflow node 10.5)',
    retries: 1,
    triggers: [{ event: 'RULE_CHECK_REQUESTED' }],
  },
  async ({ event, step, logger }) => {
    const data = event.data as RuleCheckRequestedData;
    const stepKey = sanitize(data.job_requisition_id);

    const result = await step.run(`rule-check-${stepKey}`, async () => {
      const input = buildRuleCheckInput({
        runtime_context: data.runtime_context,
        parsed_resume: data.parsed_resume,
        job_requisition: data.job_requisition,
      });
      const r = await runRuleCheck(input);
      logger.info(
        `[${AGENT_NAME}] decision=${r.decision} stats=pass:${r.stats.pass}/fail:${r.stats.fail}/pending:${r.stats.pending}/info:${r.stats.insufficient_info} ` +
          `rules=${r.audit.rules_evaluated} graph_calls=${r.audit.graph_calls} ` +
          `model=${r.audit.llm_model} latency_ms=${r.audit.llm_duration_ms} ` +
          `tool_rounds=${r.audit.llm_round_trips}` +
          (r.audit.fail_reason ? ` fail_reason=${r.audit.fail_reason}` : ''),
      );
      return r;
    });

    const dims = extractDims(data.job_requisition);
    const audit: RuleCheckAuditMeta = {
      rules_evaluated: result.audit.rules_evaluated,
      graph_calls: result.audit.graph_calls,
      client_id: dims.client_id,
      business_group: dims.business_group,
      studio: dims.studio,
      llm_model: result.audit.llm_model,
      llm_duration_ms: result.audit.llm_duration_ms,
      llm_round_trips: result.audit.llm_round_trips,
      llm_prompt_tokens: result.audit.llm_prompt_tokens,
      llm_completion_tokens: result.audit.llm_completion_tokens,
      rule_source: result.audit.rule_source,
      fail_reason: result.audit.fail_reason,
    };

    if (result.decision === 'PASS') {
      const payload: RuleCheckPassedData = {
        upload_id: data.upload_id,
        candidate_id: data.candidate_id,
        resume_id: data.resume_id,
        job_requisition_id: data.job_requisition_id,
        client_id: data.client_id ?? '',
        audit,
        // 透传给 matchResumeAgent 第二段
        job_requisition: data.job_requisition,
        parsed_resume: data.parsed_resume,
        runtime_context: data.runtime_context,
        employee_id: data.employee_id,
      };
      await step.sendEvent(`emit-passed-${stepKey}`, { name: 'RULE_CHECK_PASSED', data: payload });
      return { ok: true, decision: 'PASS', job_requisition_id: data.job_requisition_id };
    }

    // FAIL or REVIEW
    const failedPayload: RuleCheckFailedData = {
      upload_id: data.upload_id,
      candidate_id: data.candidate_id,
      resume_id: data.resume_id,
      job_requisition_id: data.job_requisition_id,
      client_id: data.client_id ?? '',
      decision: result.decision,
      failed_rules: result.explanations.map((e) => ({
        rule_id: e.rule_id,
        rule_name: e.rule_name,
        step_id: e.step_id,
        status: e.status,
        reason: e.reason,
      })),
      audit,
    };
    await step.sendEvent(`emit-failed-${stepKey}`, { name: 'RULE_CHECK_FAILED', data: failedPayload });
    return { ok: true, decision: result.decision, job_requisition_id: data.job_requisition_id };
  },
);

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}
```

- [ ] **Step 2: 跑测试 — 应该 PASS**

```bash
npx vitest run server/inngest/agents/rule-check-agent.test.ts
```
Expected: 3 PASS。

- [ ] **Step 3: 注册到 functions.ts**

打开 `server/inngest/functions.ts`,line 36-38 加 import + line 72 加到 realFunctions:

```ts
// Line 36-38:
import { resumeParserAgent } from "./agents/resume-parser-agent";
import { createJdAgent } from "./agents/create-jd-agent";
import { matchResumeAgent } from "./agents/match-resume-agent";
import { ruleCheckAgent } from "./agents/rule-check-agent";

// Line 72:
const realFunctions = [resumeParserAgent, createJdAgent, matchResumeAgent, ruleCheckAgent];
```

也更新顶部 comment 的"3 real functions"为"4 real functions",更新主链路 comment 加 ruleCheckAgent。

- [ ] **Step 4: 跑 build**

```bash
npm run build 2>&1 | tail -10
```
Expected: build OK。

- [ ] **Step 5: 提交**

```bash
git add server/inngest/agents/rule-check-agent.ts server/inngest/agents/rule-check-agent.test.ts server/inngest/functions.ts
git commit -m "feat(rule-check-agent): NEW Inngest function (workflow node 10.5)

- Subscribes RULE_CHECK_REQUESTED, calls runRuleCheck, emits PASS/FAILED
- Register as 4th real function alongside resumeParser/createJd/matchResume
- runRuleCheck fail-safe in-band — retries=1 only for step.run-level errors
- 3 unit tests covering PASS / FAIL / REVIEW decision paths"
```

### Task 4.4: matchResumeAgent 双段重构

**Files:**
- Modify: `server/inngest/agents/match-resume-agent.ts`(大改)

- [ ] **Step 1: 备份 + 读现有 file**

```bash
cp server/inngest/agents/match-resume-agent.ts server/inngest/agents/match-resume-agent.ts.bak
```

- [ ] **Step 2: 整体替换**

把 `server/inngest/agents/match-resume-agent.ts` 重写为以下结构(保留大部分 helper 函数,改 triggers + 主函数体):

```ts
// matchResume agent — Workflow node 10 (PR-4 2026-05-19 双段订阅版).
//
// 订阅两类事件,根据 event.name 分支:
//
// 1. RESUME_PROCESSED (第一段)
//    - 通过 RAAS API Server 拉招聘人员名下在招 JR 列表
//    - 对每条 JR emit RULE_CHECK_REQUESTED → ruleCheckAgent
//    - 不再内嵌 runRuleCheck(已抽到 ruleCheckAgent)
//    - 不再调 matchResume(等 ruleCheckAgent 回信 RULE_CHECK_PASSED)
//
// 2. RULE_CHECK_PASSED (第二段)
//    - 直连 RoboHire POST /match-resume (不再走 RAAS proxy)
//    - 持久化:RAAS POST /match-results (写 Postgres,保留)
//    - emit MATCH_PASSED_NEED_INTERVIEW
//
// 改动 vs PR-4 前:
//   ❌ 删除 RULE_CHECK_ENABLED env gate + step 4.0 inline rule-check
//   ✅ 双段订阅 — RESUME_PROCESSED + RULE_CHECK_PASSED
//   ✅ matchResume 切换 RoboHire 直连
//   ✅ POST /match-results 保留(RAAS dual-write 契约,见 memory)

import { NonRetriableError } from 'inngest';
import {
  RaasApiError,
  getRequirementDetail,
  getRequirementsAgentView,
  isRaasApiConfigured,
  saveMatchResults,
  type RequirementsAgentViewItem,
} from '@/lib/raas-api-client';
import { matchResumeDirect, RobohireApiError, type RobohireMatchResumeData } from '@/lib/robohire-client';
import {
  inngest,
  type MatchPassedNeedInterviewData,
  type ResumeProcessedData,
  type RuleCheckPassedData,
  type RuleCheckRequestedData,
} from '@/server/inngest/client';

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent (workflow node 10)',
    retries: 2,
    triggers: [
      { event: 'RESUME_PROCESSED' },
      { event: 'RULE_CHECK_PASSED' },
    ],
  },
  async ({ event, step, logger }) => {
    if (event.name === 'RESUME_PROCESSED') {
      return await handleResumeProcessed({ event, step, logger });
    }
    if (event.name === 'RULE_CHECK_PASSED') {
      return await handleRuleCheckPassed({ event, step, logger });
    }
    // 不应该走到这里(Inngest 会按 triggers 过滤)
    logger.warn(`[${AGENT_NAME}] unexpected event name: ${event.name}`);
    return { ok: true, skipped: true };
  },
);

// ──────────────────────────────────────────────────────────────────────
// 第一段:RESUME_PROCESSED → emit RULE_CHECK_REQUESTED 一条/JR
// ──────────────────────────────────────────────────────────────────────

async function handleResumeProcessed({ event, step, logger }: any) {
  const data = unwrapResumeProcessedEvent(event.data);
  const traceId = getTraceId(event.data);
  const uploadId = pickUploadId(data);
  const candidateId = pickCandidateId(data);
  const employeeId = pickEmployeeId(data);
  const resumeId = typeof data.resume_id === 'string' ? data.resume_id : '';

  if (!uploadId && !candidateId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 upload_id 和 candidate_id`);
  }
  if (!employeeId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 employee_id`);
  }
  if (!isRaasApiConfigured()) {
    throw new NonRetriableError(`[${AGENT_NAME}] RAAS_API_BASE_URL / AGENT_API_KEY env 未配置`);
  }

  logger.info(
    `[${AGENT_NAME}] received RESUME_PROCESSED · upload_id=${uploadId ?? '—'} ` +
      `candidate_id=${candidateId ?? '—'} employee_id=${employeeId}`,
  );

  // 拉 JR 列表(逻辑保持)
  const linkedJrId =
    typeof data.job_requisition_id === 'string' && data.job_requisition_id.trim().length > 0
      ? data.job_requisition_id.trim()
      : null;

  const requirements = await step.run('list-requirements', async () => {
    if (linkedJrId) {
      try {
        const detail = await getRequirementDetail(linkedJrId, { traceId });
        const merged = {
          ...(detail.specification ?? {}),
          ...(detail.requirement ?? {}),
        } as unknown as RequirementsAgentViewItem;
        if (!hasMatchableContent(merged)) {
          logger.warn(`[${AGENT_NAME}] linked JR ${linkedJrId} 内容空,跳过`);
          return [];
        }
        return [merged];
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(`getRequirementDetail 4xx for ${linkedJrId}: ${e.code} ${e.message}`);
        }
        throw e;
      }
    }
    try {
      const r = await getRequirementsAgentView({ claimer_employee_id: employeeId }, { traceId });
      const recruiting = (r.items ?? []).filter(isRecruitingStatus);
      const matchable = recruiting.filter(hasMatchableContent);
      logger.info(
        `[${AGENT_NAME}] RAAS returned ${r.items?.length ?? 0} requirement(s); ` +
          `${recruiting.length} recruiting; ${matchable.length} matchable`,
      );
      return matchable;
    } catch (e) {
      if (e instanceof RaasApiError && e.isClientError) {
        throw new NonRetriableError(`getRequirementsAgentView 4xx: ${e.code} ${e.message}`);
      }
      throw e;
    }
  });

  if (requirements.length === 0) {
    return {
      ok: true,
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      requested_count: 0,
      reason: 'no-matchable-requirements',
    };
  }

  // 对每条 JR emit RULE_CHECK_REQUESTED
  const parsedData =
    data.parsed && typeof data.parsed === 'object'
      ? ((data.parsed as Record<string, unknown>).data as Record<string, unknown> | undefined)
      : undefined;

  let requested = 0;
  for (const req of requirements) {
    const jrid = pickRequisitionId(req);
    if (!jrid) continue;
    const stepKey = sanitizeStepKey(jrid);

    const payload: RuleCheckRequestedData = {
      upload_id: uploadId ?? '',
      candidate_id: candidateId ?? '',
      resume_id: resumeId,
      employee_id: employeeId,
      job_requisition_id: jrid,
      client_id: pickClientId(req),
      job_requisition: req as unknown as Record<string, unknown>,
      parsed_resume: parsedData ?? null,
      runtime_context: {
        upload_id: uploadId ?? '',
        candidate_id: candidateId ?? '',
        resume_id: resumeId,
        employee_id: employeeId,
        filename: typeof data.filename === 'string' ? data.filename : undefined,
        received_at: typeof data.receivedAt === 'string' ? data.receivedAt : undefined,
        trace_id: traceId ?? null,
      },
      trace_id: traceId ?? null,
    };
    await step.sendEvent(`emit-rule-check-requested-${stepKey}`, {
      name: 'RULE_CHECK_REQUESTED',
      data: payload,
    });
    logger.info(`[${AGENT_NAME}] ✓ emitted RULE_CHECK_REQUESTED for JR=${jrid}`);
    requested += 1;
  }

  return {
    ok: true,
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    requested_count: requested,
  };
}

// ──────────────────────────────────────────────────────────────────────
// 第二段:RULE_CHECK_PASSED → RoboHire match → saveMatchResults → emit
// ──────────────────────────────────────────────────────────────────────

async function handleRuleCheckPassed({ event, step, logger }: any) {
  const data = event.data as RuleCheckPassedData;
  const traceId = data.runtime_context?.trace_id ?? undefined;
  const stepKey = sanitizeStepKey(data.job_requisition_id);
  const req = data.job_requisition as RequirementsAgentViewItem;
  const candidateId = data.candidate_id ?? '';
  const uploadId = data.upload_id ?? '';

  // 拼 resume / jd 文本
  const resumeText = buildResumeTextFromParsed(data.parsed_resume);
  const jdText = flattenRequirementForMatch(req);

  if (!resumeText.trim()) {
    throw new NonRetriableError(`[${AGENT_NAME}] resume text empty for JR ${data.job_requisition_id}`);
  }

  // 4a. 直连 RoboHire
  const matchResult = await step.run(`match-${stepKey}`, async () => {
    logger.info(
      `[${AGENT_NAME}] calling RoboHire /match-resume · jr=${data.job_requisition_id} ` +
        `jd_chars=${jdText.length} resume_chars=${resumeText.length}`,
    );
    try {
      const r = await matchResumeDirect({ resume: resumeText, jd: jdText }, { traceId: traceId ?? undefined });
      logger.info(
        `[${AGENT_NAME}] RoboHire match OK · score=${r.data.matchScore} rec=${r.data.recommendation} requestId=${r.requestId}`,
      );
      return { ok: true as const, data: r.data, requestId: r.requestId, savedAs: r.savedAs };
    } catch (e) {
      if (e instanceof RobohireApiError && e.isClientError) {
        logger.error(`[${AGENT_NAME}] RoboHire match 4xx · ${e.code} — skipping JR`);
        return { ok: false as const, error: `${e.code}: ${e.message}` };
      }
      throw e;
    }
  });

  if (!matchResult.ok) {
    return { ok: false, job_requisition_id: data.job_requisition_id, error: matchResult.error };
  }

  // 4b. RAAS POST /match-results 持久化(保留)
  await step.run(`save-match-${stepKey}`, async () => {
    try {
      const r = await saveMatchResults(
        {
          ...(matchResult.data as Record<string, unknown>),
          source: 'need_interview',
          candidate_id: candidateId || undefined,
          upload_id: uploadId || undefined,
          job_requisition_id: data.job_requisition_id,
          client_id: pickClientId(req),
          robohire_request_id: matchResult.requestId,
          savedAs: matchResult.savedAs,
        },
        { traceId },
      );
      logger.info(`[${AGENT_NAME}] saveMatchResults OK · jr=${data.job_requisition_id}`);
      return r;
    } catch (e) {
      if (e instanceof RaasApiError && e.isClientError) {
        throw new NonRetriableError(`saveMatchResults 4xx: ${e.code} ${e.message}`);
      }
      throw e;
    }
  });

  // 4c. emit MATCH_PASSED_NEED_INTERVIEW
  const payload: MatchPassedNeedInterviewData = {
    upload_id: uploadId,
    job_requisition_id: data.job_requisition_id,
    success: true,
    data: matchResult.data as unknown as Record<string, unknown>,
    requestId: matchResult.requestId,
    savedAs: matchResult.savedAs,
  };
  await step.sendEvent(`emit-match-${stepKey}`, { name: 'MATCH_PASSED_NEED_INTERVIEW', data: payload });

  logger.info(`[${AGENT_NAME}] ✅ emitted MATCH_PASSED_NEED_INTERVIEW · jr=${data.job_requisition_id}`);
  return { ok: true, job_requisition_id: data.job_requisition_id, requestId: matchResult.requestId };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (从原 file 保留)
// ──────────────────────────────────────────────────────────────────────

function unwrapResumeProcessedEvent(raw: unknown): ResumeProcessedData & Record<string, any> {
  if (!raw || typeof raw !== 'object') return raw as ResumeProcessedData;
  const r = raw as Record<string, unknown>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return { ...(r.payload as Record<string, unknown>) } as unknown as ResumeProcessedData;
  }
  return raw as ResumeProcessedData;
}

function pickUploadId(data: any): string | null {
  for (const c of [data.upload_id, data.uploadId, data.etag, data.object_key, data.objectKey]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
function pickCandidateId(data: any): string | null {
  if (typeof data.candidate_id === 'string' && data.candidate_id.trim()) return data.candidate_id.trim();
  return null;
}
function pickEmployeeId(data: any): string | null {
  for (const c of [data.claimer_employee_id, data.employee_id, data.employeeId, data.operator_id, process.env.RAAS_DEFAULT_EMPLOYEE_ID]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
function pickRequisitionId(req: RequirementsAgentViewItem): string | null {
  for (const c of [(req as any).job_requisition_id, (req as any).requisition_id, (req as any).job_id, (req as any).id]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
function pickClientId(req: RequirementsAgentViewItem): string | undefined {
  for (const c of [(req as any).client_id, (req as any).clientId]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}
function buildResumeTextFromParsed(parsed: Record<string, unknown> | null | undefined): string {
  if (!parsed) return '';
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
}
function flattenRequirementForMatch(req: RequirementsAgentViewItem): string {
  const r = req as Record<string, any>;
  const lines: string[] = [];
  if (r.client_job_title || r.title) lines.push(`职位: ${r.client_job_title ?? r.title}`);
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.work_city || r.city) lines.push(`工作城市: ${r.work_city ?? r.city}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.interview_mode) lines.push(`面试形式: ${r.interview_mode}`);
  if (r.work_years != null) lines.push(`\n工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (r.education_requirement) lines.push(`专业要求: ${r.education_requirement}`);
  if (r.language_requirements) lines.push(`语言要求: ${r.language_requirements}`);
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  if (r.negative_requirement && r.negative_requirement !== '无') lines.push(`\n排除条件:\n${r.negative_requirement}`);
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}
function hasMatchableContent(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  return !!(r.job_responsibility?.toString().trim() || r.job_requirement?.toString().trim() ||
    (Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0));
}
function isRecruitingStatus(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  let raw: unknown = undefined;
  for (const c of [r.status, r.hc_status, r.requisition_status, r.spec_status, r.job_requisition_status]) {
    if (c != null && String(c).trim() !== '') { raw = c; break; }
  }
  if (raw === undefined) return true;
  const s = String(raw).toLowerCase().trim();
  return s === 'recruiting' || s === '招聘中' || s === 'active' || s === 'open';
}
function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}
function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) return t.trace_id;
  return undefined;
}
```

- [ ] **Step 3: 跑 build**

```bash
npm run build 2>&1 | tail -20
```
Expected: build OK。

- [ ] **Step 4: 跑测试**

```bash
npm run test 2>&1 | tail -30
```
Expected: 0 failures(rule-check tests + robohire tests + 已有 tests 全过)。

- [ ] **Step 5: 删除备份文件**

```bash
rm server/inngest/agents/match-resume-agent.ts.bak
```

- [ ] **Step 6: 提交**

```bash
git add server/inngest/agents/match-resume-agent.ts
git commit -m "refactor(match-resume): split into dual-trigger fn + switch to RoboHire direct

- Triggers: RESUME_PROCESSED (1st segment: emit RULE_CHECK_REQUESTED per JR)
           + RULE_CHECK_PASSED (2nd segment: RoboHire match + saveMatchResults)
- Delete inline rule-check block (step 4.0) + RULE_CHECK_ENABLED env gate
- matchResume call switches to matchResumeDirect (lib/robohire-client)
- POST /match-results stays (RAAS Postgres dual-write contract)

Pairs with ruleCheckAgent (workflow node 10.5) for the new event chain:
  RESUME_PROCESSED → matchResumeAgent(1st) → RULE_CHECK_REQUESTED →
  ruleCheckAgent → RULE_CHECK_PASSED → matchResumeAgent(2nd) →
  MATCH_PASSED_NEED_INTERVIEW"
```

### Task 4.5: 端到端验证

- [ ] **Step 1: 启动 Inngest dev + Next.js**

```bash
# Terminal 1
npm run inngest:up
# Terminal 2
npm run dev
```

- [ ] **Step 2: 触发测试事件**

```bash
# Terminal 3
npm run publish:test
```

- [ ] **Step 3: 在 Inngest dev UI 检查 run chain**

打开 http://localhost:8288 — 应该看到完整链路:

```
RESUME_DOWNLOADED → resumeParserAgent
RESUME_PROCESSED → matchResumeAgent (1st segment) → emits N RULE_CHECK_REQUESTED
RULE_CHECK_REQUESTED → ruleCheckAgent (×N) → emits RULE_CHECK_PASSED or RULE_CHECK_FAILED
RULE_CHECK_PASSED → matchResumeAgent (2nd segment) → emits MATCH_PASSED_NEED_INTERVIEW
```

Expected: 没有报错;每条 RULE_CHECK_REQUESTED 都有对应的 ruleCheckAgent run;PASS 的 JR 走到 matchResumeAgent 第二段且 emit MATCH_PASSED_NEED_INTERVIEW;FAIL 的 JR 停在 RULE_CHECK_FAILED。

- [ ] **Step 4: 检查 lib/rule-check/logs/YYYY-MM-DD.log**

```bash
tail -50 /Users/yuhancheng/Desktop/agenticOperator/lib/rule-check/logs/$(date +%Y-%m-%d).log
```
Expected: 有 `runRuleCheck.start` / `neo4j.graph.fetched` / `llm.response` / `runRuleCheck.done` 日志条目。

- [ ] **Step 5: 检查 RAAS POST /match-results 真实写入**

通过 RAAS API 或 RAAS dashboard 验证最新的 match-result 在 Postgres 里。或者看 step `save-match-*` 的 Inngest log 是否 success。

### Chunk 4 Wrap-up

- [ ] **完整 npm run test**:`npm run test`
- [ ] **完整 npm run build**:`npm run build`
- [ ] **回滚预案**:如果生产出问题,revert PR-4 那个 commit;PR-3 (resumeParser 切 RoboHire)可独立保留,因为它不依赖 PR-4

---

## Chunk 5 (Optional): PR-5 — `RULE_CHECK_BYPASS` env 改名

> **目标**:用 `RULE_CHECK_BYPASS=true` 取代原 `RULE_CHECK_ENABLED=false` 语义,并在 matchResumeAgent 第一段直接 emit `RULE_CHECK_PASSED` 跳过 ruleCheckAgent。
>
> **可选**。如果你不需要 bypass 路径,跳过本 chunk。

### Files

- Modify: `server/inngest/agents/match-resume-agent.ts`
- Modify: `.env.example`(注释加 bypass 说明)
- Modify: `docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md`(标注 PR-5 已实施)

### Task 5.1: 加 bypass 分支

- [ ] **Step 1: 在 matchResumeAgent 第一段加 bypass 分支**

`handleResumeProcessed` 函数,在 emit RULE_CHECK_REQUESTED 之前加:

```ts
const bypass = process.env.RULE_CHECK_BYPASS === 'true';

for (const req of requirements) {
  const jrid = pickRequisitionId(req);
  if (!jrid) continue;
  const stepKey = sanitizeStepKey(jrid);

  if (bypass) {
    // 直接 emit RULE_CHECK_PASSED 跳过 ruleCheckAgent
    const passedPayload: RuleCheckPassedData = {
      upload_id: uploadId ?? '',
      candidate_id: candidateId ?? '',
      resume_id: resumeId,
      job_requisition_id: jrid,
      client_id: pickClientId(req) ?? '',
      audit: {
        rules_evaluated: 0, graph_calls: 0,
        client_id: pickClientId(req) ?? '', business_group: null, studio: null,
        llm_model: 'bypass', llm_duration_ms: 0, llm_round_trips: 0,
        rule_source: 'json-fallback',
        fail_reason: 'bypassed',
      },
      job_requisition: req as unknown as Record<string, unknown>,
      parsed_resume: parsedData ?? null,
      runtime_context: {
        upload_id: uploadId ?? '', candidate_id: candidateId ?? '', resume_id: resumeId,
        employee_id: employeeId, trace_id: traceId ?? null,
      },
      employee_id: employeeId,
    };
    await step.sendEvent(`emit-bypass-passed-${stepKey}`, { name: 'RULE_CHECK_PASSED', data: passedPayload });
    logger.info(`[${AGENT_NAME}] ⏭ RULE_CHECK_BYPASS=true · directly emit RULE_CHECK_PASSED for JR=${jrid}`);
    requested += 1;
    continue;
  }

  // 原 emit RULE_CHECK_REQUESTED 路径
  // ... (already in place)
}
```

- [ ] **Step 2: 更新 .env.example**

```bash
# Set RULE_CHECK_BYPASS=true to skip rule-check entirely
# (replaces legacy RULE_CHECK_ENABLED=false semantic from PR-4)
RULE_CHECK_BYPASS=
```

- [ ] **Step 3: 测试 bypass**

```bash
RULE_CHECK_BYPASS=true npm run dev
# Trigger publish:test
# Verify: Inngest UI 显示 RULE_CHECK_PASSED 直接来自 matchResumeAgent
# (没有 ruleCheckAgent run)
```

- [ ] **Step 4: 提交**

```bash
git add server/inngest/agents/match-resume-agent.ts .env.example
git commit -m "feat(rule-check): add RULE_CHECK_BYPASS env to skip ruleCheckAgent

- When RULE_CHECK_BYPASS=true, matchResumeAgent 1st segment emits
  RULE_CHECK_PASSED directly (with audit.fail_reason='bypassed'),
  skipping ruleCheckAgent entirely.
- Replaces legacy RULE_CHECK_ENABLED=false bypass path."
```

---

## Full Plan Wrap-up

- [ ] **PR-1**: rule data migration + types + delete inferSeverity + UI badge → reviewed + merged
- [ ] **PR-2**: lib/robohire-client.ts → reviewed + merged
- [ ] **PR-3**: resumeParserAgent switch to direct RoboHire → reviewed + merged
- [ ] **PR-4**: ruleCheckAgent NEW + matchResumeAgent dual-trigger refactor + match-resume direct → reviewed + merged
- [ ] **PR-5** (optional): RULE_CHECK_BYPASS env → reviewed + merged

### Final smoke test (after all merged)

- [ ] `npm run test` — full suite passes
- [ ] `npm run build` — clean build
- [ ] Inngest end-to-end: trigger RESUME_DOWNLOADED → see complete chain emit
- [ ] `/rule-check` UI evaluation page still works
- [ ] Memory updated:`AO ↔ RAAS dual-write 契约` 仍 enforced(POST /candidates / /match-results 保留)

### Rollback strategy

每个 PR 独立,revert 即可。PR-4 是最大改动,如果出问题:
- revert PR-4 → 链路回到 matchResumeAgent 内嵌 rule-check + RAAS proxy match-resume
- PR-1/2/3 数据 + RoboHire 客户端可保留(独立无 regression)

---

## Open items (out of this plan's scope)

- JD 端直连 RoboHire(`createJdAgent` 仍走 RAAS POST /generate-jd)— 文档不完整,留 Phase 2
- RoboHire `/generate-jd` 完整 API 文档采集 — partner 协调
- 生产 rule-check 也落 Prisma 表(目前只评估页落)— Phase 2,设计 `RuleCheckProductionRun` 表
