# Phase 0: Agent Version Table + Config Rollback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/fleet/[short]` 详情页里实现"版本"tab——可以把当前 `AgentConfig` 捕获成一个带名字的版本,可以选历史版本把 config 热回退回去。同时把"权限与数据"tab 从代码里删干净。**不含 LLM 调用、不含代码层 codegen**——这是后续 Phase 1+ 的物理前置依赖。

**Architecture:** 新建 `AgentVersion` DB 表(只填 config 相关字段,codeBlob/specJson 等留 nullable 给 Phase 1)。新建三条 API route(list / capture / deploy)。新建 `VersionsTab` UI 组件嵌入现有 `AgentDetailContent.tsx`。回退动作 = 把 `AgentVersion.configJson` 反序列化后 upsert 回 `AgentConfig`,同时复用现有的 `AgentConfigHistory` 审计机制。

**Tech Stack:** Next.js 16 App Router · Prisma 7 + better-sqlite3 · React 19 · vitest 4 · Tailwind 4(走 `var(--c-*)` token,不引新色)

**Background docs:**
- 研究文档:[docs/2026-05-25-ao-behavior-codegen-research.md](../../2026-05-25-ao-behavior-codegen-research.md) §8.1 / §9 Phase 0
- 现有 AgentConfig 写入路径(复用其 audit 机制):[app/api/manage/agents/[name]/config/route.ts](../../../app/api/manage/agents/[name]/config/route.ts)
- 详情页 tab 骨架:[components/fleet/AgentDetailContent.tsx](../../../components/fleet/AgentDetailContent.tsx)

**Constraints:**
- AO 工作于 `main` 分支(per user memory),不要建 worktree
- 所有 commit 使用 `git commit -- <pathspec>` 限定文件(避免 pre-commit hook 吞掉无关 staged changes)
- 不要 push 到任何 main;此 plan 只 commit 到本地 `main`

---

## File Structure

**Database:**
- Modify: [prisma/schema.prisma](../../../prisma/schema.prisma) — append `AgentVersion` model after `AgentConfigHistory`

**Lib (new):**
- Create: `lib/agent-versions/types.ts` — `AgentVersionRow`, `CaptureRequest`, `DeployResponse` 类型
- Create: `lib/agent-versions/snapshot.ts` — `snapshotAgentConfig(agentId)` 函数,把 `AgentConfig` 转成可存的 JSON
- Create: `lib/agent-versions/snapshot.test.ts`

**API routes (new, 3 routes):**
- Create: `app/api/agents/[short]/versions/route.ts` — `GET`(list) + `POST`(capture)
- Create: `app/api/agents/[short]/versions/route.test.ts`
- Create: `app/api/agents/[short]/versions/[id]/deploy/route.ts` — `POST`(restore)
- Create: `app/api/agents/[short]/versions/[id]/deploy/route.test.ts`

**UI (new):**
- Create: `components/fleet/versions/VersionsTab.tsx` — 主组件,渲染版本列表 + "Capture" 按钮
- Create: `components/fleet/versions/DeployConfirmDialog.tsx` — 部署前确认

**UI (modify):**
- Modify: [components/fleet/AgentDetailContent.tsx](../../../components/fleet/AgentDetailContent.tsx) — 引入 `VersionsTab`、从 `TAB_DEFS` 删 `perm` 那一行
- Modify: [lib/i18n.tsx](../../../lib/i18n.tsx) — 新增 `av_*` 字符串

---

## Chunk 1: Database + Helper Layer

### Task 1: 添加 AgentVersion Prisma model

**Files:**
- Modify: `prisma/schema.prisma` — 在 `AgentConfigHistory` 之后追加

- [ ] **Step 1.1: 在 `prisma/schema.prisma` 的 `AgentConfigHistory` model 之后追加新 model**

定位位置:找到 `model AgentConfigHistory { ... @@index([createdAt]) }` 的关闭花括号之后(约 line 282)。

追加内容(完整 block):

```prisma

// Phase 0: Agent 版本表 — 配置快照 + 未来 codegen 落库目标。
// 见 docs/2026-05-25-ao-behavior-codegen-research.md §8.1
model AgentVersion {
  id           String   @id @default(cuid())
  // short = AGENT_MAP 里的 short code (e.g. "JDGenerator")
  // slug  = Inngest function id (e.g. "create-jd-agent") — 也是 AgentConfig.id
  short        String
  slug         String
  versionLabel String   // 'v1.9.4' 或 '2026-05-25-1830' 自动生成
  status       String   @default("draft")  // 'draft' | 'active' | 'archived'

  // Phase 0 实际使用
  configJson   String?  // JSON: AgentConfig 快照(temperature/maxRetries/promptAppend/tier/maxOutputTokens/skillOverrides)
  configHash   String?  // sha256(configJson) — 用于去重
  capturedFrom String?  // 'current-config' | 'manual' | 'codegen' — 来源标识
  notes        String?

  // Phase 1+ 留空字段 (nullable,Phase 0 不写)
  codeBlob     String?
  codeHash     String?
  specJson     String?
  promptText   String?
  modelUsed    String?

  // Provenance
  generatedBy  String   @default("operator-unknown")
  createdAt    DateTime @default(now())
  deployedAt   DateTime?

  @@unique([short, versionLabel])
  @@index([short, createdAt])
  @@index([slug])
  @@index([status])
}
```

- [ ] **Step 1.2: 跑 db push 应用 schema 变更**

Run:
```bash
npm run db:push
```

Expected output 包含:
- `Your database is now in sync with your Prisma schema.`
- 或类似 `🚀  Your database is now in sync with your Prisma schema.`

如果出错:检查 schema.prisma 是否语法合法(花括号/字段类型)。

- [ ] **Step 1.3: 验证 Prisma client 已重新生成**

Run:
```bash
npx prisma generate 2>&1 | tail -5
```

Expected:`✔ Generated Prisma Client`

- [ ] **Step 1.4: 验证 typescript 能看到 AgentVersion 类型**

```bash
cat > /tmp/check-agent-version.ts <<'EOF'
import { prisma } from '@/server/db';
async function _check() {
  return prisma.agentVersion.findMany({});
}
EOF
npx tsc --noEmit -p tsconfig.json /tmp/check-agent-version.ts 2>&1 | head -10
rm /tmp/check-agent-version.ts
```

注意:这个临时文件不会真的能跑 — 它只验证 prisma client 暴露了 agentVersion property。Expected:无 "Property 'agentVersion' does not exist" 错误。如果有,回 Step 1.2。

- [ ] **Step 1.5: Commit**

```bash
git add prisma/schema.prisma
git commit -- prisma/schema.prisma -m "feat(db): add AgentVersion table for Phase 0 version history

config snapshot field used now; code/spec/prompt fields nullable for Phase 1+."
```

---

### Task 2: 写 snapshot helper + 类型定义

**Files:**
- Create: `lib/agent-versions/types.ts`
- Create: `lib/agent-versions/snapshot.ts`
- Create: `lib/agent-versions/snapshot.test.ts`

- [ ] **Step 2.1: 先写 types.ts(纯类型,无副作用)**

Create `lib/agent-versions/types.ts`:

```typescript
// Public types for /api/agents/[short]/versions and the VersionsTab UI.
// AgentVersion DB row → AgentVersionRow (serialized over JSON).

export type AgentConfigSnapshot = {
  enabled: boolean;
  temperature: number | null;
  maxRetries: number | null;
  tier: string | null;
  maxOutputTokens: number | null;
  promptAppend: string | null;
  skillOverrides: string | null;
  description: string | null;
};

export type AgentVersionRow = {
  id: string;
  short: string;
  slug: string;
  versionLabel: string;
  status: 'draft' | 'active' | 'archived';
  configJson: AgentConfigSnapshot | null;
  configHash: string | null;
  capturedFrom: string | null;
  notes: string | null;
  generatedBy: string;
  createdAt: string;
  deployedAt: string | null;
};

export type VersionsListResponse = {
  versions: AgentVersionRow[];
  activeVersionId: string | null;
  meta: { generatedAt: string };
};

export type CaptureVersionRequest = {
  versionLabel?: string;  // optional override; else auto-generated
  notes?: string;
};

export type CaptureVersionResponse = {
  ok: true;
  version: AgentVersionRow;
} | {
  ok: false;
  error: 'CONFLICT' | 'NO_CONFIG' | 'AGENT_NOT_FOUND' | 'INTERNAL';
  message: string;
};

export type DeployVersionResponse = {
  ok: true;
  version: AgentVersionRow;
  previousActiveId: string | null;
} | {
  ok: false;
  error: 'NOT_FOUND' | 'AGENT_NOT_FOUND' | 'INTERNAL';
  message: string;
};
```

- [ ] **Step 2.2: 先写 snapshot.test.ts(TDD)**

Create `lib/agent-versions/snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  snapshotAgentConfig,
  hashSnapshot,
  generateVersionLabel,
} from './snapshot';
import type { AgentConfigSnapshot } from './types';

vi.mock('@/server/db', () => ({
  prisma: {
    agentConfig: {
      findUnique: vi.fn(),
    },
  },
}));

describe('snapshotAgentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns AgentConfigSnapshot when AgentConfig exists', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentConfig.findUnique as any).mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: 'be concise',
      skillOverrides: null,
      description: 'JD generator',
    });

    const snap = await snapshotAgentConfig('create-jd-agent');
    expect(snap).toEqual({
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: 'be concise',
      skillOverrides: null,
      description: 'JD generator',
    });
  });

  it('returns null when AgentConfig row does not exist', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentConfig.findUnique as any).mockResolvedValue(null);
    const snap = await snapshotAgentConfig('nonexistent-agent');
    expect(snap).toBeNull();
  });
});

describe('hashSnapshot', () => {
  it('produces a stable hash for the same snapshot', () => {
    const snap: AgentConfigSnapshot = {
      enabled: true,
      temperature: 0.5,
      maxRetries: 2,
      tier: 'lite',
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    };
    expect(hashSnapshot(snap)).toEqual(hashSnapshot(snap));
  });

  it('produces a different hash when snapshot differs', () => {
    const a: AgentConfigSnapshot = {
      enabled: true, temperature: 0.5, maxRetries: 2,
      tier: 'lite', maxOutputTokens: null, promptAppend: null,
      skillOverrides: null, description: null,
    };
    const b = { ...a, temperature: 0.6 };
    expect(hashSnapshot(a)).not.toEqual(hashSnapshot(b));
  });

  it('is independent of object key ordering', () => {
    const a: AgentConfigSnapshot = {
      enabled: true, temperature: 0.5, maxRetries: 2,
      tier: 'lite', maxOutputTokens: null, promptAppend: null,
      skillOverrides: null, description: null,
    };
    // Same object but constructed with different key order
    const b: AgentConfigSnapshot = {
      description: null, skillOverrides: null, promptAppend: null,
      maxOutputTokens: null, tier: 'lite', maxRetries: 2,
      temperature: 0.5, enabled: true,
    };
    expect(hashSnapshot(a)).toEqual(hashSnapshot(b));
  });
});

describe('generateVersionLabel', () => {
  it('returns a label in YYYY-MM-DD-HHMM format', () => {
    const fixed = new Date('2026-05-25T18:30:00Z');
    const label = generateVersionLabel(fixed);
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
});
```

- [ ] **Step 2.3: 跑测试,确认全部 FAIL(snapshot.ts 还没创建)**

Run:
```bash
npm test -- lib/agent-versions/snapshot.test.ts 2>&1 | tail -15
```

Expected:`Error: Failed to load url ./snapshot` 或 `Cannot find module './snapshot'` 类似消息。✅ 这就是预期的 fail。

- [ ] **Step 2.4: 实现 snapshot.ts 让测试通过**

Create `lib/agent-versions/snapshot.ts`:

```typescript
import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import type { AgentConfigSnapshot } from './types';

/**
 * Snapshot the current AgentConfig row into a plain JSON object.
 * Returns null when no AgentConfig row exists for that agentId (slug).
 *
 * agentId here = Inngest function id (e.g. 'create-jd-agent'),
 * which is the primary key of AgentConfig.
 */
export async function snapshotAgentConfig(
  agentId: string,
): Promise<AgentConfigSnapshot | null> {
  const row = await prisma.agentConfig.findUnique({
    where: { id: agentId },
    select: {
      enabled: true,
      temperature: true,
      maxRetries: true,
      tier: true,
      maxOutputTokens: true,
      promptAppend: true,
      skillOverrides: true,
      description: true,
    },
  });
  if (!row) return null;
  return {
    enabled: row.enabled,
    temperature: row.temperature,
    maxRetries: row.maxRetries,
    tier: row.tier,
    maxOutputTokens: row.maxOutputTokens,
    promptAppend: row.promptAppend,
    skillOverrides: row.skillOverrides,
    description: row.description,
  };
}

/**
 * Stable hash of an AgentConfigSnapshot, sorting keys so equivalent
 * snapshots with different key orderings produce the same hash.
 */
export function hashSnapshot(snap: AgentConfigSnapshot): string {
  const sorted = Object.keys(snap)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (snap as unknown as Record<string, unknown>)[k];
      return acc;
    }, {});
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Auto-generate a version label from a date. Format: YYYY-MM-DD-HHMM
 * (UTC). Used when operator does not supply an explicit label.
 */
export function generateVersionLabel(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = when.getUTCFullYear();
  const m = pad(when.getUTCMonth() + 1);
  const d = pad(when.getUTCDate());
  const hh = pad(when.getUTCHours());
  const mm = pad(when.getUTCMinutes());
  return `${y}-${m}-${d}-${hh}${mm}`;
}
```

- [ ] **Step 2.5: 跑测试,确认 PASS**

Run:
```bash
npm test -- lib/agent-versions/snapshot.test.ts 2>&1 | tail -10
```

Expected:`Test Files  1 passed (1)`,`Tests  5 passed (5)`。

- [ ] **Step 2.6: Commit**

```bash
git add lib/agent-versions/types.ts lib/agent-versions/snapshot.ts lib/agent-versions/snapshot.test.ts
git commit -- lib/agent-versions/types.ts lib/agent-versions/snapshot.ts lib/agent-versions/snapshot.test.ts -m "feat(agent-versions): snapshot helper + types

snapshotAgentConfig reads AgentConfig.findUnique;
hashSnapshot is key-order-stable;
generateVersionLabel uses UTC YYYY-MM-DD-HHMM."
```

---

## Chunk 2: API Routes

### Task 3: GET /api/agents/[short]/versions(list)

**Files:**
- Create: `app/api/agents/[short]/versions/route.ts` — GET handler(POST 在 Task 4 加)
- Create: `app/api/agents/[short]/versions/route.test.ts`

**Approach note:** 这条路由要兼顾 `short` → `slug` 转换。`AGENT_MAP` 是源真理([lib/agent-mapping.ts](../../../lib/agent-mapping.ts)),从里面查到 agent 后,优先用 `inngestId` 作为 slug,其次按 short 推 kebab(`<short>-agent`)。

- [ ] **Step 3.1: 先写测试(只测 GET)**

Create `app/api/agents/[short]/versions/route.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentVersion: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/agent-mapping', () => ({
  AGENT_MAP: [
    {
      short: 'JDGenerator',
      wsId: '4',
      stage: 'jd',
      kind: 'auto',
      ownerTeam: 'HSM·交付',
      version: 'v1.9.4',
      triggersEvents: [],
      emitsEvents: [],
      terminal: false,
      inngestName: 'Create JD Agent',
      inngestId: 'create-jd-agent',
    },
  ],
}));

import { GET } from './route';

describe('GET /api/agents/[short]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns versions sorted by createdAt desc', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentVersion.findMany as any).mockResolvedValue([
      {
        id: 'v2',
        short: 'JDGenerator',
        slug: 'create-jd-agent',
        versionLabel: '2026-05-25-1900',
        status: 'active',
        configJson: '{"enabled":true,"temperature":0.7,"maxRetries":null,"tier":null,"maxOutputTokens":null,"promptAppend":null,"skillOverrides":null,"description":null}',
        configHash: 'abc',
        capturedFrom: 'current-config',
        notes: null,
        codeBlob: null,
        codeHash: null,
        specJson: null,
        promptText: null,
        modelUsed: null,
        generatedBy: 'operator-unknown',
        createdAt: new Date('2026-05-25T19:00:00Z'),
        deployedAt: new Date('2026-05-25T19:01:00Z'),
      },
      {
        id: 'v1',
        short: 'JDGenerator',
        slug: 'create-jd-agent',
        versionLabel: '2026-05-25-1800',
        status: 'archived',
        configJson: '{"enabled":true,"temperature":0.5,"maxRetries":null,"tier":null,"maxOutputTokens":null,"promptAppend":null,"skillOverrides":null,"description":null}',
        configHash: 'def',
        capturedFrom: 'current-config',
        notes: null,
        codeBlob: null,
        codeHash: null,
        specJson: null,
        promptText: null,
        modelUsed: null,
        generatedBy: 'operator-unknown',
        createdAt: new Date('2026-05-25T18:00:00Z'),
        deployedAt: null,
      },
    ]);

    const req = new Request('http://localhost/api/agents/JDGenerator/versions');
    const res = await GET(req, { params: Promise.resolve({ short: 'JDGenerator' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].id).toBe('v2');
    expect(body.versions[0].configJson).toEqual({
      enabled: true,
      temperature: 0.7,
      maxRetries: null,
      tier: null,
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    expect(body.activeVersionId).toBe('v2');
  });

  it('returns empty list + null activeVersionId when agent has no versions', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentVersion.findMany as any).mockResolvedValue([]);
    const req = new Request('http://localhost/api/agents/JDGenerator/versions');
    const res = await GET(req, { params: Promise.resolve({ short: 'JDGenerator' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.versions).toEqual([]);
    expect(body.activeVersionId).toBeNull();
  });

  it('returns 404 when short not in AGENT_MAP', async () => {
    const req = new Request('http://localhost/api/agents/Nonexistent/versions');
    const res = await GET(req, { params: Promise.resolve({ short: 'Nonexistent' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3.2: 跑测试确认 FAIL**

Run:
```bash
npm test -- app/api/agents/\\[short\\]/versions/route.test.ts 2>&1 | tail -10
```

Expected fail message:`Cannot find module './route'` 或类似。

- [ ] **Step 3.3: 实现 route.ts(只 GET)**

Create `app/api/agents/[short]/versions/route.ts`:

```typescript
// GET /api/agents/[short]/versions
//   → list all versions of an agent, descending by createdAt
//
// POST /api/agents/[short]/versions
//   → capture current AgentConfig as a new AgentVersion row (Task 4)

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';
import type {
  VersionsListResponse,
  AgentVersionRow,
  AgentConfigSnapshot,
} from '@/lib/agent-versions/types';

export const dynamic = 'force-dynamic';

/**
 * Resolve a short code from AGENT_MAP → (short, slug) pair.
 * slug = inngestId if present, else `<kebab-short>-agent` convention.
 * Returns null if short is not in AGENT_MAP.
 */
function resolveAgent(short: string): { short: string; slug: string } | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const slug =
    meta.inngestId ??
    short
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase() + '-agent';
  return { short: meta.short, slug };
}

function dbRowToApiRow(
  row: {
    id: string;
    short: string;
    slug: string;
    versionLabel: string;
    status: string;
    configJson: string | null;
    configHash: string | null;
    capturedFrom: string | null;
    notes: string | null;
    generatedBy: string;
    createdAt: Date;
    deployedAt: Date | null;
  },
): AgentVersionRow {
  let snap: AgentConfigSnapshot | null = null;
  if (row.configJson) {
    try {
      snap = JSON.parse(row.configJson) as AgentConfigSnapshot;
    } catch {
      snap = null;
    }
  }
  return {
    id: row.id,
    short: row.short,
    slug: row.slug,
    versionLabel: row.versionLabel,
    status: row.status as 'draft' | 'active' | 'archived',
    configJson: snap,
    configHash: row.configHash,
    capturedFrom: row.capturedFrom,
    notes: row.notes,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
    deployedAt: row.deployedAt ? row.deployedAt.toISOString() : null,
  };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ short: string }> },
): Promise<Response> {
  const { short } = await ctx.params;
  const resolved = resolveAgent(short);
  if (!resolved) {
    return NextResponse.json(
      { error: 'AGENT_NOT_FOUND', message: `Short '${short}' not in AGENT_MAP` },
      { status: 404 },
    );
  }

  try {
    const rows = await prisma.agentVersion.findMany({
      where: { short: resolved.short },
      orderBy: { createdAt: 'desc' },
    });
    const versions = rows.map(dbRowToApiRow);
    const active = versions.find((v) => v.status === 'active') ?? null;
    const body: VersionsListResponse = {
      versions,
      activeVersionId: active?.id ?? null,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 3.4: 跑测试确认 PASS**

Run:
```bash
npm test -- app/api/agents/\\[short\\]/versions/route.test.ts 2>&1 | tail -10
```

Expected:`Test Files  1 passed (1)`,`Tests  3 passed (3)`。

- [ ] **Step 3.5: Commit**

```bash
git add 'app/api/agents/[short]/versions/route.ts' 'app/api/agents/[short]/versions/route.test.ts'
git commit -- 'app/api/agents/[short]/versions/route.ts' 'app/api/agents/[short]/versions/route.test.ts' -m "feat(api): GET /api/agents/[short]/versions

lists AgentVersion rows for an agent, exposes activeVersionId."
```

---

### Task 4: POST /api/agents/[short]/versions(capture)

**Files:**
- Modify: `app/api/agents/[short]/versions/route.ts` — add POST handler
- Modify: `app/api/agents/[short]/versions/route.test.ts` — add POST tests

**Capture semantics:**
1. resolve short → slug
2. snapshot 当前 AgentConfig(用 Task 2 的 helper)
3. 若 snapshot null(无 AgentConfig 行)→ 返回 `NO_CONFIG`,但允许 operator 显式传 `force=true` 或 `empty=true` 来捕获一个空快照(为新 agent 先建版本)
4. 计算 hash
5. 检查 (short, configHash) 是否已存在 → CONFLICT
6. 计算 versionLabel(operator 传的优先;否则自动生成)
7. insert AgentVersion(status='draft')
8. 返回新 row

**Note**: 不要在 capture 里 set active=true,active 切换走 deploy 路径。

- [ ] **Step 4.1: 加测试 cases 到现有 test 文件**

在 `route.test.ts` 文件末尾 append:

```typescript
import { POST } from './route';

vi.mock('@/lib/agent-versions/snapshot', () => ({
  snapshotAgentConfig: vi.fn(),
  hashSnapshot: vi.fn(),
  generateVersionLabel: vi.fn(() => '2026-05-25-1830'),
}));

describe('POST /api/agents/[short]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma as any).agentVersion.findFirst = vi.fn();
    (prisma as any).agentVersion.create = vi.fn();
  });

  // Re-import after declaring mocks
  it('captures current AgentConfig as a new version', async () => {
    const { snapshotAgentConfig, hashSnapshot } = await import('@/lib/agent-versions/snapshot');
    const { prisma } = await import('@/server/db');
    (snapshotAgentConfig as any).mockResolvedValue({
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    (hashSnapshot as any).mockReturnValue('hash123');
    (prisma.agentVersion.findFirst as any).mockResolvedValue(null);
    (prisma.agentVersion.create as any).mockResolvedValue({
      id: 'new-id',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: '2026-05-25-1830',
      status: 'draft',
      configJson: '{"enabled":true,"temperature":0.7,"maxRetries":3,"tier":"standard","maxOutputTokens":4096,"promptAppend":null,"skillOverrides":null,"description":null}',
      configHash: 'hash123',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null, codeHash: null, specJson: null, promptText: null, modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-25T18:30:00Z'),
      deployedAt: null,
    });

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ short: 'JDGenerator' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.version.versionLabel).toBe('2026-05-25-1830');
    expect(body.version.configJson.temperature).toBe(0.7);
  });

  it('rejects with CONFLICT when same configHash already exists', async () => {
    const { snapshotAgentConfig, hashSnapshot } = await import('@/lib/agent-versions/snapshot');
    const { prisma } = await import('@/server/db');
    (snapshotAgentConfig as any).mockResolvedValue({
      enabled: true, temperature: 0.7, maxRetries: 3,
      tier: 'standard', maxOutputTokens: 4096, promptAppend: null,
      skillOverrides: null, description: null,
    });
    (hashSnapshot as any).mockReturnValue('hash-dup');
    (prisma.agentVersion.findFirst as any).mockResolvedValue({
      id: 'existing',
      versionLabel: 'v0',
    });

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ short: 'JDGenerator' }) });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('CONFLICT');
  });

  it('rejects with NO_CONFIG when no AgentConfig row exists', async () => {
    const { snapshotAgentConfig } = await import('@/lib/agent-versions/snapshot');
    (snapshotAgentConfig as any).mockResolvedValue(null);

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ short: 'JDGenerator' }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('NO_CONFIG');
  });
});
```

- [ ] **Step 4.2: 跑测试,确认 POST 测试 FAIL**

Run:
```bash
npm test -- app/api/agents/\\[short\\]/versions/route.test.ts 2>&1 | tail -15
```

Expected:GET 测试 PASS,POST 测试 FAIL with `POST is not a function` 或类似。

- [ ] **Step 4.3: 实现 POST handler**

在 `app/api/agents/[short]/versions/route.ts` 末尾 append:

```typescript
import {
  snapshotAgentConfig,
  hashSnapshot,
  generateVersionLabel,
} from '@/lib/agent-versions/snapshot';
import type { CaptureVersionRequest } from '@/lib/agent-versions/types';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ short: string }> },
): Promise<Response> {
  const { short } = await ctx.params;
  const resolved = resolveAgent(short);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: 'AGENT_NOT_FOUND', message: `Short '${short}' not in AGENT_MAP` },
      { status: 404 },
    );
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as CaptureVersionRequest;

  try {
    const snap = await snapshotAgentConfig(resolved.slug);
    if (!snap) {
      return NextResponse.json(
        {
          ok: false,
          error: 'NO_CONFIG',
          message: `No AgentConfig row exists for slug '${resolved.slug}'. Edit the agent config first to create one.`,
        },
        { status: 400 },
      );
    }
    const configHash = hashSnapshot(snap);

    // Reject silent duplicates — operator should know they're capturing
    // a config identical to a previous version.
    const dup = await prisma.agentVersion.findFirst({
      where: { short: resolved.short, configHash },
      select: { id: true, versionLabel: true },
    });
    if (dup) {
      return NextResponse.json(
        {
          ok: false,
          error: 'CONFLICT',
          message: `Identical config already captured as version '${dup.versionLabel}' (id ${dup.id}).`,
        },
        { status: 409 },
      );
    }

    const versionLabel = body.versionLabel?.trim() || generateVersionLabel();
    const row = await prisma.agentVersion.create({
      data: {
        short: resolved.short,
        slug: resolved.slug,
        versionLabel,
        status: 'draft',
        configJson: JSON.stringify(snap),
        configHash,
        capturedFrom: 'current-config',
        notes: body.notes ?? null,
      },
    });
    return NextResponse.json({ ok: true, version: dbRowToApiRow(row) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4.4: 跑测试,确认全部 PASS**

Run:
```bash
npm test -- app/api/agents/\\[short\\]/versions/route.test.ts 2>&1 | tail -10
```

Expected:`Tests  6 passed (6)`。

- [ ] **Step 4.5: Commit**

```bash
git add 'app/api/agents/[short]/versions/route.ts' 'app/api/agents/[short]/versions/route.test.ts'
git commit -- 'app/api/agents/[short]/versions/route.ts' 'app/api/agents/[short]/versions/route.test.ts' -m "feat(api): POST /api/agents/[short]/versions captures current config

rejects CONFLICT on duplicate configHash and NO_CONFIG when AgentConfig row missing."
```

---

### Task 5: POST /api/agents/[short]/versions/[id]/deploy

**Files:**
- Create: `app/api/agents/[short]/versions/[id]/deploy/route.ts`
- Create: `app/api/agents/[short]/versions/[id]/deploy/route.test.ts`

**Deploy semantics:**
1. 找到目标 AgentVersion(by id),验证 short 匹配
2. 解析 configJson 回 AgentConfigSnapshot
3. 找当前 active version,demote → 'archived' + clear deployedAt
4. upsert AgentConfig(用 snapshot 内容覆盖)
5. 把目标 version status='active',deployedAt=now
6. 写一行 AgentConfigHistory(复用现有审计机制)
7. 返回更新后的 row

**Note**: 这里复用了 [app/api/manage/agents/[name]/config/route.ts](../../../app/api/manage/agents/[name]/config/route.ts) 的 history-writing pattern。

- [ ] **Step 5.1: 先写测试**

Create `app/api/agents/[short]/versions/[id]/deploy/route.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentVersion: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    agentConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    agentConfigHistory: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn({
      agentVersion: {
        update: (prisma as any).agentVersion.update,
        updateMany: (prisma as any).agentVersion.updateMany,
      },
      agentConfig: {
        findUnique: (prisma as any).agentConfig.findUnique,
        upsert: (prisma as any).agentConfig.upsert,
      },
      agentConfigHistory: {
        create: (prisma as any).agentConfigHistory.create,
      },
    })),
  },
}));

vi.mock('@/lib/agent-mapping', () => ({
  AGENT_MAP: [
    {
      short: 'JDGenerator', wsId: '4', stage: 'jd', kind: 'auto',
      ownerTeam: 'HSM·交付', version: 'v1.9.4',
      triggersEvents: [], emitsEvents: [], terminal: false,
      inngestName: 'Create JD Agent', inngestId: 'create-jd-agent',
    },
  ],
}));

import { POST } from './route';
import { prisma } from '@/server/db';

describe('POST /api/agents/[short]/versions/[id]/deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('demotes current active + activates target + upserts AgentConfig + writes history', async () => {
    (prisma.agentVersion.findUnique as any).mockResolvedValue({
      id: 'v-target',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: 'v-target-label',
      status: 'draft',
      configJson: JSON.stringify({
        enabled: true,
        temperature: 0.4,
        maxRetries: 1,
        tier: 'lite',
        maxOutputTokens: 2048,
        promptAppend: 'short',
        skillOverrides: null,
        description: null,
      }),
      configHash: 'h-target',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null, codeHash: null, specJson: null, promptText: null, modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: null,
    });
    (prisma.agentVersion.findFirst as any).mockResolvedValue({
      id: 'v-currently-active', versionLabel: 'v-current',
    });
    (prisma.agentConfig.findUnique as any).mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true, temperature: 0.7, maxRetries: 3, tier: 'standard',
      maxOutputTokens: 4096, promptAppend: null, skillOverrides: null,
      description: null,
    });
    (prisma.agentConfig.upsert as any).mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true, temperature: 0.4, maxRetries: 1, tier: 'lite',
      maxOutputTokens: 2048, promptAppend: 'short', skillOverrides: null,
      description: null,
    });
    (prisma.agentVersion.update as any).mockResolvedValue({
      id: 'v-target',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: 'v-target-label',
      status: 'active',
      configJson: '{"enabled":true,"temperature":0.4,"maxRetries":1,"tier":"lite","maxOutputTokens":2048,"promptAppend":"short","skillOverrides":null,"description":null}',
      configHash: 'h-target',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null, codeHash: null, specJson: null, promptText: null, modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: new Date('2026-05-25T19:00:00Z'),
    });
    (prisma.agentVersion.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.agentConfigHistory.create as any).mockResolvedValue({});

    const req = new Request(
      'http://localhost/api/agents/JDGenerator/versions/v-target/deploy',
      { method: 'POST' },
    );
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator', id: 'v-target' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.previousActiveId).toBe('v-currently-active');
    expect(body.version.status).toBe('active');
    expect(body.version.id).toBe('v-target');

    // AgentConfig 用了快照覆盖
    expect((prisma.agentConfig.upsert as any).mock.calls[0][0].update.temperature).toBe(0.4);
    // History 写了一行
    expect((prisma.agentConfigHistory.create as any)).toHaveBeenCalled();
    // 旧 active 被 demote
    expect((prisma.agentVersion.updateMany as any).mock.calls[0][0].data.status).toBe('archived');
  });

  it('returns 404 when version id not found', async () => {
    (prisma.agentVersion.findUnique as any).mockResolvedValue(null);
    const req = new Request('http://localhost/api/agents/JDGenerator/versions/no-such/deploy', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ short: 'JDGenerator', id: 'no-such' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when version belongs to a different short', async () => {
    (prisma.agentVersion.findUnique as any).mockResolvedValue({
      id: 'v-other',
      short: 'SomeOtherAgent',
      slug: 'foo',
      versionLabel: 'x',
      status: 'draft',
      configJson: '{"enabled":true,"temperature":0.4,"maxRetries":1,"tier":"lite","maxOutputTokens":2048,"promptAppend":null,"skillOverrides":null,"description":null}',
      configHash: 'h',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null, codeHash: null, specJson: null, promptText: null, modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: null,
    });
    const req = new Request('http://localhost/api/agents/JDGenerator/versions/v-other/deploy', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ short: 'JDGenerator', id: 'v-other' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 5.2: 跑测试确认 FAIL**

Run:
```bash
npm test -- 'app/api/agents/\[short\]/versions/\[id\]/deploy/route.test.ts' 2>&1 | tail -10
```

Expected:`Cannot find module './route'`。

- [ ] **Step 5.3: 实现 deploy route**

Create `app/api/agents/[short]/versions/[id]/deploy/route.ts`:

```typescript
// POST /api/agents/[short]/versions/[id]/deploy
//   → restore this version's config snapshot to AgentConfig,
//     demote previous active version, write AgentConfigHistory.
//
// "Deploy" in Phase 0 = config-layer hot-swap only. Code-layer
// rollback requires git revert + redeploy and is out of scope here.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';
import type {
  DeployVersionResponse,
  AgentConfigSnapshot,
  AgentVersionRow,
} from '@/lib/agent-versions/types';

export const dynamic = 'force-dynamic';

function resolveAgent(short: string): { short: string; slug: string } | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const slug =
    meta.inngestId ??
    short.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '-agent';
  return { short: meta.short, slug };
}

function rowToApi(
  row: {
    id: string; short: string; slug: string; versionLabel: string;
    status: string; configJson: string | null; configHash: string | null;
    capturedFrom: string | null; notes: string | null; generatedBy: string;
    createdAt: Date; deployedAt: Date | null;
  },
): AgentVersionRow {
  let snap: AgentConfigSnapshot | null = null;
  if (row.configJson) {
    try { snap = JSON.parse(row.configJson); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    short: row.short,
    slug: row.slug,
    versionLabel: row.versionLabel,
    status: row.status as 'draft' | 'active' | 'archived',
    configJson: snap,
    configHash: row.configHash,
    capturedFrom: row.capturedFrom,
    notes: row.notes,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
    deployedAt: row.deployedAt ? row.deployedAt.toISOString() : null,
  };
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ short: string; id: string }> },
): Promise<Response> {
  const { short, id } = await ctx.params;
  const resolved = resolveAgent(short);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: 'AGENT_NOT_FOUND', message: `Short '${short}' not in AGENT_MAP` },
      { status: 404 },
    );
  }

  const target = await prisma.agentVersion.findUnique({ where: { id } });
  if (!target || target.short !== resolved.short) {
    return NextResponse.json(
      { ok: false, error: 'NOT_FOUND', message: `Version '${id}' not found for short '${short}'` },
      { status: 404 },
    );
  }
  if (!target.configJson) {
    return NextResponse.json(
      { ok: false, error: 'NOT_FOUND', message: `Version '${id}' has no configJson to deploy` },
      { status: 400 },
    );
  }

  let snap: AgentConfigSnapshot;
  try {
    snap = JSON.parse(target.configJson);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL', message: `configJson parse failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  try {
    // Capture previous active before we change anything,
    // so the response can tell the UI what just got demoted.
    const previousActive = await prisma.agentVersion.findFirst({
      where: { short: resolved.short, status: 'active' },
      select: { id: true },
    });

    const result = await prisma.$transaction(async (tx: any) => {
      // 1. Demote any currently active version(s) for this agent.
      await tx.agentVersion.updateMany({
        where: { short: resolved.short, status: 'active' },
        data: { status: 'archived' },
      });

      // 2. Snapshot the BEFORE AgentConfig (for history audit).
      const before = await tx.agentConfig.findUnique({
        where: { id: resolved.slug },
      });

      // 3. Upsert AgentConfig with the snapshot's fields.
      const after = await tx.agentConfig.upsert({
        where: { id: resolved.slug },
        create: {
          id: resolved.slug,
          enabled: snap.enabled,
          temperature: snap.temperature ?? null,
          maxRetries: snap.maxRetries ?? null,
          tier: snap.tier ?? null,
          maxOutputTokens: snap.maxOutputTokens ?? null,
          promptAppend: snap.promptAppend ?? null,
          skillOverrides: snap.skillOverrides ?? null,
          description: snap.description ?? null,
        },
        update: {
          enabled: snap.enabled,
          temperature: snap.temperature ?? null,
          maxRetries: snap.maxRetries ?? null,
          tier: snap.tier ?? null,
          maxOutputTokens: snap.maxOutputTokens ?? null,
          promptAppend: snap.promptAppend ?? null,
          skillOverrides: snap.skillOverrides ?? null,
          description: snap.description ?? null,
        },
      });

      // 4. Mark target version active.
      const updated = await tx.agentVersion.update({
        where: { id: target.id },
        data: { status: 'active', deployedAt: new Date() },
      });

      // 5. Audit row in AgentConfigHistory (reuses existing pattern).
      await tx.agentConfigHistory.create({
        data: {
          agentId: resolved.slug,
          changedBy: 'operator-unknown',
          before: JSON.stringify(before ?? {}),
          after: JSON.stringify(after),
          reason: `Deploy AgentVersion ${target.versionLabel} (id=${target.id})`,
        },
      });

      return updated;
    });

    const body: DeployVersionResponse = {
      ok: true,
      version: rowToApi(result),
      previousActiveId: previousActive?.id ?? null,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 5.4: 跑测试确认 PASS**

Run:
```bash
npm test -- 'app/api/agents/\[short\]/versions/\[id\]/deploy/route.test.ts' 2>&1 | tail -10
```

Expected:`Tests  3 passed (3)`。

- [ ] **Step 5.5: 跑全套测试,确认前面的也没坏**

Run:
```bash
npm test -- lib/agent-versions 'app/api/agents/\[short\]/versions' 2>&1 | tail -15
```

Expected:全 PASS。

- [ ] **Step 5.6: Commit**

```bash
git add 'app/api/agents/[short]/versions/[id]/deploy/route.ts' 'app/api/agents/[short]/versions/[id]/deploy/route.test.ts'
git commit -- 'app/api/agents/[short]/versions/[id]/deploy/route.ts' 'app/api/agents/[short]/versions/[id]/deploy/route.test.ts' -m "feat(api): POST /api/agents/[short]/versions/[id]/deploy

restores config snapshot to AgentConfig, demotes previous active version,
and writes AgentConfigHistory row for audit trail."
```

---

## Chunk 3: UI Layer

### Task 6: i18n strings

**Files:**
- Modify: [lib/i18n.tsx](../../../lib/i18n.tsx) — 加 `av_*` 键(中英)

- [ ] **Step 6.1: 加中文键(在 `ad_stub_tab` 附近,line ~213)**

在 [lib/i18n.tsx](../../../lib/i18n.tsx) 的中文字典里(`ad_stub_tab` 之后)加:

```typescript
    av_capture_btn: "捕获当前配置为新版本",
    av_capture_hint: "把现在 AgentConfig 表的内容存为一份带名字的快照",
    av_deploy_btn: "部署",
    av_deploy_confirm_title: "部署此版本?",
    av_deploy_confirm_body: "这会用该版本的配置覆盖当前 AgentConfig,下次 agent 运行时生效。代码层不受影响。",
    av_deploy_active: "已激活",
    av_status_active: "已激活",
    av_status_draft: "草稿",
    av_status_archived: "已归档",
    av_col_label: "版本",
    av_col_status: "状态",
    av_col_captured: "捕获时间",
    av_col_by: "操作人",
    av_col_actions: "操作",
    av_empty_title: "尚无版本",
    av_empty_hint: "点击右上"捕获当前配置"创建第一个版本。",
    av_capture_success: "已捕获版本",
    av_capture_conflict: "当前配置和已有版本一致,未创建新版本",
    av_capture_no_config: "该 agent 还没有 AgentConfig 记录,无法捕获",
    av_deploy_success: "版本已激活",
    av_note_code_layer: "注意:此处只回退配置层(temperature / promptAppend 等)。代码层需要 git revert + 重新部署。",
```

- [ ] **Step 6.2: 加英文键(line ~1365 附近,英文字典里 `ad_stub_tab` 之后)**

```typescript
    av_capture_btn: "Capture current config as new version",
    av_capture_hint: "Save the current AgentConfig snapshot under a label",
    av_deploy_btn: "Deploy",
    av_deploy_confirm_title: "Deploy this version?",
    av_deploy_confirm_body: "This will overwrite the current AgentConfig with this version's snapshot. Next agent run will pick it up. Code layer is unaffected.",
    av_deploy_active: "Active",
    av_status_active: "Active",
    av_status_draft: "Draft",
    av_status_archived: "Archived",
    av_col_label: "Version",
    av_col_status: "Status",
    av_col_captured: "Captured",
    av_col_by: "By",
    av_col_actions: "Actions",
    av_empty_title: "No versions yet",
    av_empty_hint: "Click 'Capture current config' on the top right to create the first version.",
    av_capture_success: "Version captured",
    av_capture_conflict: "Current config matches an existing version; nothing new was created.",
    av_capture_no_config: "This agent has no AgentConfig row; cannot capture.",
    av_deploy_success: "Version activated",
    av_note_code_layer: "Note: only the config layer (temperature / promptAppend / etc.) is restored. The code layer requires git revert + redeploy.",
```

- [ ] **Step 6.3: 验证 build 通过(typecheck)**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -E "error|TS" | head -20
```

Expected:无 error 输出(或只有跟此次改动无关的旧 error)。

- [ ] **Step 6.4: Commit**

```bash
git add lib/i18n.tsx
git commit -- lib/i18n.tsx -m "feat(i18n): av_* keys for Versions tab"
```

---

### Task 7: VersionsTab UI 组件

**Files:**
- Create: `components/fleet/versions/VersionsTab.tsx`

**Design notes:**
- 走现有 atoms(`Btn`, `Card`, `Badge`, `EmptyState`)
- 用 `.tbl` class 或新建一个 grid 表格(看现有怎么写就跟着写)
- 列:Version label / Status badge / Captured(rel time)/ By / Actions
- 顶部:`Capture` 按钮 + 一段 hint 文案

- [ ] **Step 7.1: 写组件骨架(纯渲染,不带 fetch 逻辑)**

Create `components/fleet/versions/VersionsTab.tsx`:

```tsx
'use client';

import React from 'react';
import { useApp } from '@/lib/i18n';
import { Btn, EmptyState } from '@/components/shared/atoms';
import { Ic } from '@/components/shared/Ic';
import { fetchJson } from '@/lib/api/client';
import type {
  AgentVersionRow,
  VersionsListResponse,
  CaptureVersionResponse,
  DeployVersionResponse,
} from '@/lib/agent-versions/types';
import { DeployConfirmDialog } from './DeployConfirmDialog';

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function StatusBadge({ status, t }: { status: 'draft' | 'active' | 'archived'; t: (k: string) => string }) {
  const styles: Record<typeof status, { bg: string; fg: string; border: string }> = {
    active:   { bg: 'var(--c-ok-bg)',  fg: 'var(--c-ok)',  border: 'color-mix(in oklab, var(--c-ok) 25%, transparent)' },
    draft:    { bg: 'var(--c-panel)',  fg: 'var(--c-ink-2)', border: 'var(--c-line)' },
    archived: { bg: 'transparent',     fg: 'var(--c-ink-3)', border: 'var(--c-line)' },
  };
  const s = styles[status];
  const label = t(`av_status_${status}`);
  return (
    <span className="inline-flex items-center gap-1 rounded border" style={{
      padding: '2px 8px', fontSize: 11,
      background: s.bg, color: s.fg, borderColor: s.border,
    }}>
      {status === 'active' && (
        <span className="rounded-full" style={{ width: 5, height: 5, background: 'var(--c-ok)' }} />
      )}
      {label}
    </span>
  );
}

export function VersionsTab({ short }: { short: string }) {
  const { t } = useApp();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<VersionsListResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<VersionsListResponse>(`/api/agents/${encodeURIComponent(short)}/versions`);
      setData(res);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [short]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const onCapture = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(short)}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as CaptureVersionResponse;
      if (body.ok) {
        setFlash({ kind: 'ok', msg: `${t('av_capture_success')}: ${body.version.versionLabel}` });
        reload();
      } else if (body.error === 'CONFLICT') {
        setFlash({ kind: 'err', msg: t('av_capture_conflict') });
      } else if (body.error === 'NO_CONFIG') {
        setFlash({ kind: 'err', msg: t('av_capture_no_config') });
      } else {
        setFlash({ kind: 'err', msg: body.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const onDeploy = async (id: string) => {
    setBusy(true);
    setConfirmId(null);
    setFlash(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(short)}/versions/${id}/deploy`, {
        method: 'POST',
      });
      const body = (await res.json()) as DeployVersionResponse;
      if (body.ok) {
        setFlash({ kind: 'ok', msg: `${t('av_deploy_success')}: ${body.version.versionLabel}` });
        reload();
      } else {
        setFlash({ kind: 'err', msg: body.message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 500, letterSpacing: '-0.01em' }}>
            版本历史
          </h2>
          <div className="text-ink-3 mt-1" style={{ fontSize: 12 }}>{t('av_capture_hint')}</div>
        </div>
        <Btn size="sm" variant="primary" onClick={onCapture} disabled={busy}>
          + {t('av_capture_btn')}
        </Btn>
      </div>

      <div className="text-ink-3" style={{ fontSize: 11.5, padding: '8px 10px', background: 'var(--c-panel)', border: '1px solid var(--c-line)', borderRadius: 6 }}>
        ⚠ {t('av_note_code_layer')}
      </div>

      {flash && (
        <div className="rounded border" style={{
          padding: '8px 12px', fontSize: 12.5,
          background: flash.kind === 'ok' ? 'var(--c-ok-bg)' : 'var(--c-err-bg)',
          color: flash.kind === 'ok' ? 'var(--c-ok)' : 'var(--c-err)',
          borderColor: flash.kind === 'ok'
            ? 'color-mix(in oklab, var(--c-ok) 25%, transparent)'
            : 'color-mix(in oklab, var(--c-err) 25%, transparent)',
        }}>
          {flash.msg}
        </div>
      )}

      {loading && <div className="text-ink-3" style={{ fontSize: 12.5 }}>加载中…</div>}
      {error && <div className="text-err" style={{ fontSize: 12.5 }}>{error}</div>}

      {!loading && !error && data && data.versions.length === 0 && (
        <EmptyState
          icon={<Ic.workflow />}
          title={t('av_empty_title')}
          hint={t('av_empty_hint')}
          variant="info"
        />
      )}

      {!loading && !error && data && data.versions.length > 0 && (
        <div className="border border-line rounded-lg overflow-hidden">
          <div className="grid items-center text-ink-3 border-b border-line" style={{
            gridTemplateColumns: '1.4fr 0.8fr 0.9fr 1fr 0.6fr',
            padding: '10px 16px', fontSize: 11.5, background: 'var(--c-panel)',
          }}>
            <div>{t('av_col_label')}</div>
            <div>{t('av_col_status')}</div>
            <div>{t('av_col_captured')}</div>
            <div>{t('av_col_by')}</div>
            <div className="text-right">{t('av_col_actions')}</div>
          </div>
          {data.versions.map((v) => (
            <VersionRow
              key={v.id}
              v={v}
              onDeployClick={() => setConfirmId(v.id)}
              busy={busy}
              t={t}
            />
          ))}
        </div>
      )}

      {confirmId && (
        <DeployConfirmDialog
          version={data?.versions.find((x) => x.id === confirmId) ?? null}
          onConfirm={() => confirmId && onDeploy(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

function VersionRow({ v, onDeployClick, busy, t }: {
  v: AgentVersionRow;
  onDeployClick: () => void;
  busy: boolean;
  t: (k: string) => string;
}) {
  return (
    <div className="grid items-center border-b border-line last:border-b-0" style={{
      gridTemplateColumns: '1.4fr 0.8fr 0.9fr 1fr 0.6fr',
      padding: '10px 16px', fontSize: 12.5,
    }}>
      <div className="text-ink-1 tabular-nums">{v.versionLabel}</div>
      <div><StatusBadge status={v.status} t={t} /></div>
      <div className="text-ink-2">{relTime(v.createdAt)}</div>
      <div className="text-ink-3 truncate" title={v.generatedBy}>{v.generatedBy}</div>
      <div className="text-right">
        {v.status === 'active' ? (
          <span className="text-ink-4" style={{ fontSize: 11 }}>{t('av_deploy_active')}</span>
        ) : (
          <Btn size="sm" variant="ghost" onClick={onDeployClick} disabled={busy}>
            {t('av_deploy_btn')}
          </Btn>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7.2: 跑 tsc 验证编译**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -E "VersionsTab|versions/Versions" | head -10
```

Expected:无 error。如果有 atoms 缺 `EmptyState` 之类的 export,检查 `@/components/shared/atoms` 的实际 exports(可能要换成 `Card` 包裹之类的)。

- [ ] **Step 7.3: Commit**

```bash
git add components/fleet/versions/VersionsTab.tsx
git commit -- components/fleet/versions/VersionsTab.tsx -m "feat(ui): VersionsTab component for /fleet/[short]?tab=versions"
```

---

### Task 8: DeployConfirmDialog

**Files:**
- Create: `components/fleet/versions/DeployConfirmDialog.tsx`

- [ ] **Step 8.1: 实现 dialog**

Create `components/fleet/versions/DeployConfirmDialog.tsx`:

```tsx
'use client';

import React from 'react';
import { useApp } from '@/lib/i18n';
import { Btn } from '@/components/shared/atoms';
import type { AgentVersionRow } from '@/lib/agent-versions/types';

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

export function DeployConfirmDialog({ version, onConfirm, onCancel }: {
  version: AgentVersionRow | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  if (!version) return null;

  // Render the diffable fields so the operator can visually scan them.
  const snap = version.configJson;
  const fields: Array<[string, string]> = snap ? [
    ['enabled', String(snap.enabled)],
    ['temperature', snap.temperature == null ? '—' : String(snap.temperature)],
    ['maxRetries', snap.maxRetries == null ? '—' : String(snap.maxRetries)],
    ['tier', snap.tier ?? '—'],
    ['maxOutputTokens', snap.maxOutputTokens == null ? '—' : String(snap.maxOutputTokens)],
    ['promptAppend', snap.promptAppend ?? '—'],
  ] : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'color-mix(in oklab, var(--c-ink-1) 40%, transparent)' }}
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-line rounded-lg shadow-sh-3"
        style={{ width: 480, maxWidth: '90vw', padding: '20px 22px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 500 }}>
          {t('av_deploy_confirm_title')}
        </h3>
        <div className="mt-2 text-ink-2" style={{ fontSize: 13 }}>
          {t('av_deploy_confirm_body')}
        </div>

        <div className="mt-4 border-t border-line">
          <div className="text-ink-3 mt-3 mb-2" style={{ fontSize: 11.5 }}>
            版本 <span className="text-ink-1 tabular-nums">{version.versionLabel}</span> 的配置:
          </div>
          {fields.map(([k, v]) => (
            <div key={k} className="grid items-center" style={{
              gridTemplateColumns: '140px 1fr', padding: '4px 0', fontSize: 12,
            }}>
              <span className="text-ink-3">{k}</span>
              <span className="text-ink-1 tabular-nums">{v}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn size="sm" variant="ghost" onClick={onCancel}>取消</Btn>
          <Btn size="sm" variant="primary" onClick={onConfirm}>{t('av_deploy_btn')}</Btn>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8.2: 编译验证**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -i "DeployConfirm" | head -5
```

Expected:无 error。

- [ ] **Step 8.3: Commit**

```bash
git add components/fleet/versions/DeployConfirmDialog.tsx
git commit -- components/fleet/versions/DeployConfirmDialog.tsx -m "feat(ui): DeployConfirmDialog shows snapshot field-by-field before deploy"
```

---

### Task 9: Wire VersionsTab into AgentDetailContent + 删 perm tab

**Files:**
- Modify: [components/fleet/AgentDetailContent.tsx](../../../components/fleet/AgentDetailContent.tsx)

**Changes:**
1. import `VersionsTab`
2. 删 `TAB_DEFS` 里的 `{ id: "perm", labelK: "ad_tab_perm" }` 一行
3. 在 `tab === "versions"` 时渲染 `<VersionsTab short={short} />`

- [ ] **Step 9.1: 删除 perm tab + 引入 VersionsTab**

在 [components/fleet/AgentDetailContent.tsx](../../../components/fleet/AgentDetailContent.tsx) 修改两处:

**改动 A:** import 段顶部(line ~10 附近),import:
```typescript
import { VersionsTab } from "./versions/VersionsTab";
```

**改动 B:** `TAB_DEFS` 数组(line ~46),删除 `perm` 那行:

before:
```typescript
const TAB_DEFS = [
  { id: "overview", labelK: "ad_tab_overview" },
  { id: "versions", labelK: "ad_tab_versions" },
  { id: "runs", labelK: "ad_tab_runs" },
  { id: "alerts", labelK: "ad_tab_alerts" },
  { id: "events", labelK: "ad_tab_events" },
  { id: "perm", labelK: "ad_tab_perm" },
  { id: "audit", labelK: "ad_tab_audit" },
] as const;
```

after(删 perm 行):
```typescript
const TAB_DEFS = [
  { id: "overview", labelK: "ad_tab_overview" },
  { id: "versions", labelK: "ad_tab_versions" },
  { id: "runs", labelK: "ad_tab_runs" },
  { id: "alerts", labelK: "ad_tab_alerts" },
  { id: "events", labelK: "ad_tab_events" },
  { id: "audit", labelK: "ad_tab_audit" },
] as const;
```

**改动 C:** 渲染分支(找现有 `{tab === "overview" && <OverviewTab .../>}` 之后,line ~196):

before:
```tsx
{tab === "overview" && <OverviewTab agent={agent} t={t} />}
{tab !== "overview" && <StubTab tabId={tab} t={t} />}
```

after:
```tsx
{tab === "overview" && <OverviewTab agent={agent} t={t} />}
{tab === "versions" && <VersionsTab short={short} />}
{tab !== "overview" && tab !== "versions" && <StubTab tabId={tab} t={t} />}
```

- [ ] **Step 9.2: 验证 typecheck**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -E "AgentDetailContent|VersionsTab" | head -10
```

Expected:无 error。

- [ ] **Step 9.3: Commit**

```bash
git add components/fleet/AgentDetailContent.tsx
git commit -- components/fleet/AgentDetailContent.tsx -m "feat(fleet-detail): wire VersionsTab + remove unimplemented perm tab"
```

---

### Task 10: 端到端手动验证

- [ ] **Step 10.1: 启动 dev server**

Run:
```bash
npm run dev
```

监听 port 3002 启动成功的输出。

- [ ] **Step 10.2: 浏览器访问 `http://localhost:3002/fleet`**

预期:Fleet 页正常打开,没回归。

- [ ] **Step 10.3: 点进任意一个 `real`-realness agent(比如 JDGenerator)的详情页**

预期:看到顶部 tab bar 现在只有 6 个 tab:概览 / 版本 / 运行 / 告警 / 事件 / 审计(perm 已删)。

- [ ] **Step 10.4: 点"版本" tab**

预期:
- 看到"版本历史"标题 + "+ 捕获当前配置为新版本"按钮
- 警告条:"注意:此处只回退配置层…"
- 表格区域显示 EmptyState"尚无版本"(因为该 agent 还没版本行)

- [ ] **Step 10.5: 点"+ 捕获当前配置为新版本"**

预期一个二选:
- 若该 agent 已有 AgentConfig 行 → flash 显示"已捕获版本: 2026-MM-DD-HHMM",表格出现一行 status='draft'
- 若该 agent 没有 AgentConfig 行 → flash 显示"该 agent 还没有 AgentConfig 记录,无法捕获"

If "no config" path:用 prisma studio 手动建一行 AgentConfig 给该 agent slug,再点捕获。

- [ ] **Step 10.6: 再点一次"+ 捕获"**

预期:flash 显示"当前配置和已有版本一致,未创建新版本"(因为 hash 一样)。

- [ ] **Step 10.7: (可选)改一下 AgentConfig 的某个字段(用 prisma studio),再捕获,确认新版本进表**

- [ ] **Step 10.8: 点其中一个非 active 版本的"部署"按钮**

预期:弹出 DeployConfirmDialog,显示该版本的 enabled / temperature / maxRetries / tier / maxOutputTokens / promptAppend 6 个字段。

- [ ] **Step 10.9: 点 dialog 里的"部署"**

预期:
- Dialog 关闭
- flash 显示"版本已激活: <label>"
- 表格刷新,刚部署的版本 status='active'(绿色徽章),前一个 active(如有)被标 'archived'
- (额外验证)在 prisma studio 里 AgentConfig 行的 temperature/maxRetries 已经被覆盖成被部署版本里的值
- (额外验证)AgentConfigHistory 表新增一行,reason 字段含 "Deploy AgentVersion <label>"

- [ ] **Step 10.10: 测 404 路径**

浏览器地址栏访问 `http://localhost:3002/api/agents/NotARealShort/versions`

预期:404 JSON `{ error: "AGENT_NOT_FOUND", ... }`。

- [ ] **Step 10.11: 关闭 dev server**(Ctrl-C)

- [ ] **Step 10.12: 跑全套测试再确认无回归**

Run:
```bash
npm test 2>&1 | tail -20
```

Expected:全部 PASS。如果有 flaky 失败,记在 notes 里但不算 Phase 0 阻断(除非是 versions / agent-versions / fleet 相关)。

- [ ] **Step 10.13: 最后一个 wrap-up commit(如果有 stray 改动)**

```bash
git status
# 若有,提交;若无,跳过
```

---

## 完成标准

✅ Phase 0 完成等于:
1. `npm test` 跑过(至少 `lib/agent-versions/` + `app/api/agents/[short]/versions/` 相关测试全 PASS)
2. `npx tsc --noEmit` 无 error
3. `/fleet/[short]?tab=versions` 能渲染:
   - EmptyState(无版本)
   - 表格(有版本时)
   - Capture 按钮跑通
   - Deploy + Dialog 跑通
   - 部署后 AgentConfig 真的被覆盖、AgentConfigHistory 真的新增了一行
4. `权限与数据` tab 在 UI 上已经不存在

✅ Phase 0 NOT 包含(留给后续 phase):
- LLM 调用
- 代码层回退
- AgentVersion.codeBlob / specJson / promptText 的写入
- 多版本 diff
- Library codegen

---

## Risks & 已知开放问题

1. **AgentConfig 还没有时**:对于尚未编辑过 config 的 agent(老 agent + 默认值),POST capture 会返回 NO_CONFIG。**预期行为**——但 UI 可以未来加"用 AGENT_MAP 默认值初始化"的快捷动作(此 phase 不做)。
2. **vitest mock `$transaction`**:Task 5 测试里的 $transaction mock 是简化版,实际数据库的事务行为在测试中不会真的回滚。这是 trade-off——E2E 验证在 Step 10.9 兜底。
3. **TAB_DEFS 删 perm 后,旧 URL `?tab=perm`** 现在会落到 `StubTab`,显示"该 Tab 待 spec 完成后实装"。**预期行为**(soft fallback)。
4. **`generatedBy` 始终是 `operator-unknown`**:复用了 [/api/manage/agents/[name]/config/route.ts](../../../app/api/manage/agents/[name]/config/route.ts) 的同一 placeholder,等 auth 中间件落地再换。

---

## End of plan
