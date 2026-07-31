# 监控基础设施全动态化 — 设计文档

> 作者: Claude(代 Steven)
> 日期: 2026-05-24
> 状态: 待 user review(写完直接走 user gate,不派 reviewer per user preference)
>
> **覆盖范围**: AO Fleet / Monitor / Events 三个监控页里所有"假动态"的静态硬编码,改为运行时从 Inngest live registry + Allmeta Ontology + 环境变量解析得到。**不**改 agent 业务逻辑、**不**改 LogEvent 设计(2026-05-22 spec 仍独立推进)。

---

## 0. 一句话目标

让 AO 的监控界面真正反映"现在系统里有什么、连的哪个 Inngest server、Allmeta 上线了哪些事件" — 删掉一切静态写死的 `AGENT_MAP` 子集 / `WSID_TO_*` 映射 / `INNGEST_REAL_SHORTS` Set / hardcoded `EVENT_CATALOG` 引用,所有"是几个、是哪几个、在哪儿"全部从 live 数据源派生。

---

## 1. 为什么改

### 1.1 用户原话

> 我们的 agentic Operator 的监控页面的基础设施,所有的配置显示都要具备动态的。比如我们的事件引擎 Inngest 换了 server,我们也要动态显示。智能体增加或者减少,也要动态显示。智能体舰队的"实装 4/24"显示安装了几个智能体 agent,没有实际动态显示真实 — 哪怕我上线和下线了几个 agent,这个依旧显示还是 4 个已经安装。事件是要实时从 Allmeta Ontology 里拉取。

### 1.2 当前"假动态"清单

| 现象 | 根因文件 | 真实数据源 |
|---|---|---|
| Fleet "实装 4/24" 永远是 4 | `lib/agent-mapping.ts:86` `INNGEST_REAL_SHORTS = new Set([...4 strings...])` | Inngest live `listFunctions()` 已存在 |
| wsId → Inngest 函数 slug 静态映射 | `lib/api/inngest-live-overlay.ts:22` `WSID_TO_INNGEST_SLUG` | 同上,可派生 |
| paused fallback 用第二份硬编码映射 | `app/api/inngest-admin/functions/route.ts:30` `REAL_ID_BY_SHORT` | 同上 |
| Monitor 拓扑 4 个 `if (short === "JDGenerator")` | `components/monitor/MonitorContent.tsx:429-432` | 同上 |
| `EventLogModal` 显示事件描述时用硬编码 28 事件 | `components/events/EventLogModal.tsx:12` `EVENT_CATALOG` | `prisma.eventDefinition` (Neo4j synced) 已存在 |
| Inngest server URL 从不在 UI 文字显示 | (缺失) | `getInngestUrl()` 已存在 |
| Allmeta 上次同步时间不暴露 | (缺失) | `prisma.emSystemStatus.lastNeo4jSyncAt` 已存在 |

### 1.3 已经正确的部分 ✅(不要碰)

- `getInngestUrl()` env-var 解析 — single source of truth,4 个 env var 名称兼容
- `useInngestLiveOverlay()` per-agent 运行时统计 — 已经活的
- `/api/inngest-admin/functions` 已经调 `listFunctions()` — 已经活的
- `/api/events` 主路径已读 `prisma.eventDefinition (source='neo4j')` — 已经活的,fallback 才是 hardcoded
- `/api/monitor/system-status` 已经活的(4 子系统健康探针)

**改动原则: 拓宽既有的活路径,不重复造轮子。**

---

## 2. After 架构

```
                    ┌──────────────────────────┐
   Inngest server ──┤                          │
   (live registry)  │  lib/inngest-registry.ts │── fetchLiveRegistry() ──┐
                    │  - listFunctions() + 5s  │                          │
                    │    in-memory cache       │                          │
                    │  - realness 推导规则      │                          │
                    └──────────────────────────┘                          │
                                                                          ▼
   Neo4j sync ────► prisma.eventDefinition ────► /api/events ─────┐  ┌─ /api/agents (enriched with realness)
                                                                   │  ├─ /api/system/config (NEW: URL + counts)
   env vars ──────► getInngestUrl() ──────────► /api/system/config├──┤
                                                                   │  └─ /api/em/sync/event-definitions/run-now (NEW)
                                                                          │
                                                                          ▼
                    ┌──────────────────────────────────────────────────────┐
                    │  UI                                                  │
                    │  - Fleet: SummaryChip "实装 X/Y" reads enriched      │
                    │  - Monitor + Fleet header: <InngestPill /> always on │
                    │  - Events: <AllmetaSyncStrip /> 顶部                  │
                    │  - EventLogModal: useEventCatalog() hook             │
                    └──────────────────────────────────────────────────────┘
```

**关键: 没有新的数据库表。所有改动是"重新接线" + 3 个新 API 端点 + 2 个新组件 + 1 个新 hook。**

---

## 3. 修复 A · realness 真实化 (杀掉 "4/24" bug)

### 3.1 新模块 `lib/inngest-registry.ts`

```typescript
// Live Inngest function registry — single source of truth for
// "which agents actually have an Inngest function registered, and
//  is it a real handler or a stub-factory shell?"
//
// Replaces three hardcoded structures:
//   - lib/agent-mapping.ts INNGEST_REAL_SHORTS
//   - lib/api/inngest-live-overlay.ts WSID_TO_INNGEST_SLUG
//   - app/api/inngest-admin/functions/route.ts REAL_ID_BY_SHORT
//
// Convention (single rule, no exception lists):
//   realness = 'real'    ⟺ fnId does NOT start with 'agent.'
//                           (i.e. explicit createFunction call from
//                            server/inngest/agents/*-agent.ts)
//   realness = 'shell'   ⟺ fnId starts with 'agent.'
//                           (stub-factory product)
//   realness = 'unbuilt' ⟺ AGENT_MAP entry has no matching Inngest fn

import { listFunctions } from '@/lib/inngest-admin-client';
import { AGENT_MAP, type AgentMeta } from '@/lib/agent-mapping';

export type Realness = 'real' | 'shell' | 'unbuilt';

export type LiveRegistryEntry = {
  short: string;            // canonical AGENT_MAP short
  fnId: string | null;      // Inngest function id (null when unbuilt)
  slug: string | null;      // full `<appId>-<fnId>` slug used by /api/inngest-admin
  realness: Realness;
  triggers: string[];       // event names this fn subscribes to (live, not AGENT_MAP)
  inngestName: string | null; // human name registered with Inngest
};

const CACHE_TTL_MS = 5_000;
let cached: { ts: number; entries: LiveRegistryEntry[] } | null = null;

export async function fetchLiveRegistry(opts?: { force?: boolean }): Promise<LiveRegistryEntry[]> {
  if (!opts?.force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.entries;
  }

  let liveFns: Array<{ id: string; slug: string; name: string; triggers: Array<{ value: string }> }> = [];
  try {
    liveFns = await listFunctions();
  } catch {
    // Inngest unreachable → registry is "empty live"; all AGENT_MAP entries
    // become unbuilt for this call. Caller decides UX (banner / retry).
  }

  // Index live fns by fnId for join
  const liveByFnId = new Map(liveFns.map(f => [f.id, f]));

  // Try to match each AGENT_MAP entry to a live fn:
  //   1. If AGENT_MAP entry has explicit `inngestId` override → use that
  //   2. Else try `agent.${short.toLowerCase()}` (stub-factory convention)
  //   3. Else try common `<short-with-dashes>-agent` for real handlers
  const entries: LiveRegistryEntry[] = AGENT_MAP.map(a => {
    const candidates = candidateFnIds(a);
    const hit = candidates.map(id => liveByFnId.get(id)).find(Boolean);
    if (!hit) {
      return { short: a.short, fnId: null, slug: null, realness: 'unbuilt' as const, triggers: [], inngestName: null };
    }
    const realness: Realness = hit.id.startsWith('agent.') ? 'shell' : 'real';
    return {
      short: a.short,
      fnId: hit.id,
      slug: hit.slug,
      realness,
      triggers: hit.triggers.map(t => t.value),
      inngestName: hit.name,
    };
  });

  // Pick up Inngest fns that have NO AGENT_MAP entry — surface them so
  // ops adding a brand-new Inngest function without touching AGENT_MAP
  // can still see it in /fleet (with stage='unknown' downstream).
  const knownFnIds = new Set(entries.map(e => e.fnId).filter(Boolean));
  for (const fn of liveFns) {
    if (knownFnIds.has(fn.id)) continue;
    const short = fn.id.replace(/^agent\./, '').replace(/-agent$/, '');
    entries.push({
      short,
      fnId: fn.id,
      slug: fn.slug,
      realness: fn.id.startsWith('agent.') ? 'shell' : 'real',
      triggers: fn.triggers.map(t => t.value),
      inngestName: fn.name,
    });
  }

  cached = { ts: Date.now(), entries };
  return entries;
}

function candidateFnIds(a: AgentMeta): string[] {
  const out: string[] = [];
  if (a.inngestId) out.push(a.inngestId); // explicit override (NEW optional field, see §3.3)
  out.push(`agent.${a.short.toLowerCase()}`); // stub-factory convention
  // common real-agent file → fn id heuristic
  const slug = a.short.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  out.push(`${slug}-agent`);
  return out;
}

// ── Convenience lookups (cached) ──
export async function findBySlugOrShort(key: string): Promise<LiveRegistryEntry | undefined> {
  const entries = await fetchLiveRegistry();
  return entries.find(e => e.slug === key || e.short === key);
}
export async function inngestSlugFromShort(short: string): Promise<string | null> {
  const entry = (await fetchLiveRegistry()).find(e => e.short === short);
  return entry?.slug ?? null;
}
export async function countByRealness(): Promise<{ real: number; shell: number; unbuilt: number; total: number }> {
  const entries = await fetchLiveRegistry();
  return {
    real: entries.filter(e => e.realness === 'real').length,
    shell: entries.filter(e => e.realness === 'shell').length,
    unbuilt: entries.filter(e => e.realness === 'unbuilt').length,
    total: entries.length,
  };
}
```

### 3.2 `AGENT_MAP` 增加可选 `inngestId` override

`lib/agent-mapping.ts` 的 `AgentMeta` 加一个 optional 字段:

```typescript
export type AgentMeta = {
  short: string;
  wsId: string;
  // … existing fields …
  /** Explicit Inngest function id; overrides convention-based matching.
   *  Use ONLY when an agent has a non-conventional id (e.g. legacy name).
   *  When absent, fetchLiveRegistry() tries:
   *    1. `agent.${short.toLowerCase()}`     (stub-factory)
   *    2. `${kebab-short}-agent`             (real handler convention)
   */
  inngestId?: string;
};
```

四个 real agent 用 inngestId 显式标注 (一行/agent):

```typescript
{ short: 'JDGenerator', ..., inngestId: 'create-jd-agent' },
{ short: 'ResumeParser', ..., inngestId: 'resume-parser-agent' },
{ short: 'Matcher', ..., inngestId: 'match-resume-agent' },
{ short: 'RuleCheck', ..., inngestId: 'rule-check-agent' },
```

(原因: real agent file 名跟 short 不规则对应 — `match-resume-agent.ts` 给 `Matcher`,`rule-check-agent.ts` 给 `RuleCheck`。Conventional fallback 不够。)

### 3.3 删除 / 改写

**删**:
- `INNGEST_REAL_SHORTS` (lib/agent-mapping.ts:86) — Set<string>
- `isReal(short)` 函数 — 改为 `isReal(short): Promise<boolean>` async,内部调 `fetchLiveRegistry()`;**所有调用方改 await**
- `WSID_TO_INNGEST_SLUG` (lib/api/inngest-live-overlay.ts:22) — 改读 `fetchLiveRegistry()`,或者让组件直接调 `inngestSlugFromShort()`
- `REAL_ID_BY_SHORT` (app/api/inngest-admin/functions/route.ts:30) — `MONITORED_FALLBACK` 整段改为基于 `fetchLiveRegistry()` 派生
- `MonitorContent.tsx:429-432` 4 个 `if (short === ...)` — 一个 helper `await inngestSlugFromShort(short)` 替代

**改 `/api/agents`** ([app/api/agents/route.ts](./app/api/agents/route.ts)):

```typescript
// before
const agents: AgentRow[] = AGENT_MAP.map((a) => ({ ..., realness: isReal(a.short) ? 'real' : 'stub' }));

// after
const registry = await fetchLiveRegistry();
const regByShort = new Map(registry.map(r => [r.short, r]));
const agents: AgentRow[] = AGENT_MAP.map((a) => {
  const live = regByShort.get(a.short);
  return {
    ...,
    realness: live?.realness ?? 'unbuilt',
    slug: live?.slug ?? null,
    inngestName: live?.inngestName ?? a.inngestName ?? a.short,
    liveTriggers: live?.triggers ?? a.triggersEvents, // live > static
  };
});
// 出现 live fn 不在 AGENT_MAP 的:additional row
for (const r of registry) {
  if (!AGENT_MAP.find(a => a.short === r.short)) {
    agents.push({ short: r.short, stage: 'unknown', ownerTeam: '—', realness: r.realness, ... });
  }
}
```

### 3.4 测试

新 `lib/inngest-registry.test.ts`:
- mock `listFunctions()` 返回 3 个 fn (1 real + 1 shell + 1 不在 AGENT_MAP)
- 断言 `fetchLiveRegistry()` 输出 3 类 realness 正确
- 断言 cache: 第二次调用 5s 内不 hit `listFunctions`
- 断言 `force: true` 跳过 cache
- 断言 `inngestSlugFromShort('JDGenerator')` 返回 live slug

新 case 加进 `app/api/agents/route.test.ts`:
- live registry 有 5 real → `agents.filter(a => a.realness === 'real').length === 5`(不再是硬编码 4)
- live registry 有 1 个不在 AGENT_MAP → 该 fn 出现在响应里,stage='unknown'

---

## 4. 修复 B · Inngest server 可见化

### 4.1 新 API `/api/system/config`

```typescript
// GET /api/system/config — runtime configuration snapshot for UI display.
// Tells the UI "what server am I currently talking to and where did the
// URL come from" so ops can verify env after deployment changes.

export type SystemConfigResponse = {
  inngest: {
    url: string;
    sourceEnv: 'INNGEST_BASE_URL' | 'INNGEST_DEV' | 'INNGEST_LOCAL_URL' | 'INNGEST_ADMIN_URL' | 'default';
    registeredFunctionCount: number;
    runsLast24h: number;
    healthy: boolean;
    lastProbeAt: string;
  };
  eventEngine: {                       // Allmeta Ontology sync state
    lastSyncAt: string | null;
    syncedEventCount: number;          // prisma.eventDefinition count
    staleSeconds: number | null;       // null if never synced
    staleness: 'fresh' | 'stale' | 'never';
  };
  raas: {
    apiUrl: string | null;             // env RAAS_API_BASE_URL
    inngestUrl: string;                // env RAAS_INNGEST_URL || getInngestUrl()
    healthy: boolean;
  };
  generatedAt: string;
};
```

实现要点: `sourceEnv` 用 `getInngestUrl()` 内部的优先级逻辑反查(把 `getInngestUrl()` 重构出一个 `getInngestUrlWithSource()` 同时返回 source)。

### 4.2 新组件 `components/shared/InngestPill.tsx`

```
┌──────────────────────────────────────────────────────┐
│ 🟢 Inngest · 192.168.1.103:8288 · 23 fn · 1.4k 24h   │
└──────────────────────────────────────────────────────┘
```

- 横向 pill,高度 28px,放在 Monitor / Fleet 顶部右侧 (`LiveIndicator` 旁边)
- 点击 → `<SystemConfigModal />`
- `🟢/🟡/🔴` 由 `healthy` 状态决定
- 5s poll `/api/system/config`

### 4.3 新 modal `components/shared/SystemConfigModal.tsx`

清单式:
- **Inngest server**
  - URL (mono): `http://192.168.1.103:8288`
  - 来源 env: `INNGEST_BASE_URL`
  - 备选 env: (lists the 3 unused ones with their current values, if any)
  - 健康: 🟢 healthy / 探测时间 2026-05-24 14:30:11
  - 已注册函数: 23
  - 24h 运行: 1,432
- **Event Engine (Allmeta Ontology)**
  - 上次同步: 2026-05-24 14:28:55 (3 min 前)
  - 同步状态: 🟢 fresh
  - 已同步事件: 28
  - `[手动刷新]` 按钮(调 §5.2 新端点)
- **RaaS partner**
  - API URL (mono)
  - Inngest URL (mono): 同 AO 时显示"复用 AO Inngest"
  - 健康: 🟢/🔴

### 4.4 接入点

- `components/fleet/FleetContent.tsx` 顶部 header — 在 `<LiveIndicator />` 右边加 `<InngestPill />`
- `components/monitor/MonitorHeader.tsx` — 同样位置加
- `components/audit/OverviewContent.tsx` (来自 2026-05-22 spec,如果已实现) — 顶部加一行

### 4.5 i18n key

```
config_inngest_label       "Inngest 引擎"
config_event_engine_label  "事件引擎 (Allmeta Ontology)"
config_raas_label          "RaaS 合作方"
config_source_env          "来源环境变量"
config_alt_envs            "备选环境变量"
config_last_probe          "最近探测"
config_last_sync           "上次同步"
config_fn_count            "已注册函数"
config_runs_24h            "24h 运行"
config_manual_refresh      "手动刷新"
config_url                 "URL"
```

---

## 5. 修复 C · 事件实时从 Allmeta Ontology 拉

### 5.1 `EventLogModal` 不再依赖 `EVENT_CATALOG`

新 hook `lib/hooks/useEventCatalog.ts`:

```typescript
// React hook — fetches /api/events once per mount, caches in module
// scope so repeated mounts don't re-fetch within 30s.
//
// Returns the same shape as /api/events response so call-sites that
// were importing EVENT_CATALOG directly can drop in without restructuring
// (just `const catalog = useEventCatalog()` and use catalog.events).

import { useState, useEffect } from 'react';
import type { EventsResponse, EventContract } from '@/lib/api/types';

const CACHE_TTL_MS = 30_000;
let cached: { ts: number; data: EventsResponse } | null = null;
const subscribers = new Set<(d: EventsResponse | null) => void>();

export function useEventCatalog(): {
  events: EventContract[];
  loading: boolean;
  lastSyncAt: string | null;
  staleness: 'fresh' | 'stale' | 'never';
} {
  const [data, setData] = useState<EventsResponse | null>(
    cached && Date.now() - cached.ts < CACHE_TTL_MS ? cached.data : null
  );

  useEffect(() => {
    subscribers.add(setData);
    if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) {
      fetch('/api/events').then(r => r.json()).then((d: EventsResponse) => {
        cached = { ts: Date.now(), data: d };
        subscribers.forEach(fn => fn(d));
      }).catch(() => {/* keep stale */});
    }
    return () => { subscribers.delete(setData); };
  }, []);

  return {
    events: data?.events ?? [],
    loading: !data,
    lastSyncAt: data?.meta.lastNeo4jSyncAt ?? null,
    staleness: deriveStaleness(data?.meta.lastNeo4jSyncAt),
  };
}

function deriveStaleness(iso: string | null | undefined): 'fresh' | 'stale' | 'never' {
  if (!iso) return 'never';
  const age = Date.now() - new Date(iso).getTime();
  if (age < 5 * 60 * 1000) return 'fresh';
  return 'stale';
}
```

改 `components/events/EventLogModal.tsx`:

```typescript
// before
import { EVENT_CATALOG, kindDot } from "@/lib/events-catalog";
const def = EVENT_CATALOG.find((e) => e.name === event.name);

// after
import { useEventCatalog } from "@/lib/hooks/useEventCatalog";
import { kindDot } from "@/lib/events-catalog"; // kindDot is pure helper, keep
const { events } = useEventCatalog();
const def = events.find((e) => e.name === event.name);
```

当 `def` 是 undefined → 显示 `"该事件未在 Allmeta Ontology 中找到 (可能是动态发布或已下架)"`,而不是空白。

### 5.2 Allmeta 手动刷新端点

新 `app/api/em/sync/event-definitions/run-now/route.ts`:

```typescript
// POST /api/em/sync/event-definitions/run-now
//
// Triggers the EventDefinition sync worker on-demand instead of waiting
// for NEO4J_SYNC_INTERVAL_MS. Used by the [手动刷新] button on /events
// and the SystemConfigModal.
//
// Returns the same shape as the interval worker emits so the UI can
// update its staleness pill in-place.

import { NextResponse } from 'next/server';
import { syncEventDefinitionsFromNeo4j } from '@/server/em/sync/event-definition-sync';

export async function POST(): Promise<Response> {
  try {
    const result = await syncEventDefinitionsFromNeo4j();
    return NextResponse.json({
      ok: true,
      syncedCount: result.upserted,
      retiredCount: result.retired,
      durationMs: result.durationMs,
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
```

### 5.3 `/events` 页加 `<AllmetaSyncStrip />`

`components/events/AllmetaSyncStrip.tsx` (新):

```
┌────────────────────────────────────────────────────────────────┐
│ 🟢 事件引擎 · 28 events · 同步于 12 秒前    [手动刷新]          │
└────────────────────────────────────────────────────────────────┘
```

- 状态: `fresh` (<5min) 绿、`stale` (>5min) 黄、`never` 红
- `[手动刷新]` 点击 → POST /api/em/sync/event-definitions/run-now,按钮变 loading,完成后刷新页面数据
- 接入 `components/events/EventsContent.tsx` 顶部

### 5.4 `EVENT_CATALOG` 文件命名警告

`lib/events-catalog.ts` 文件顶部已经有 `@deprecated` 注释,加强为:

```typescript
/**
 * @deprecated INTERNAL FALLBACK ONLY.
 * Do NOT import this outside app/api/events/route.ts cold-start path.
 * UI components must use the useEventCatalog() hook or fetch /api/events.
 *
 * Why this still exists: when the Neo4j sync worker has never succeeded
 * since cold boot (typically off-VPN dev), /api/events serves these so
 * the UI doesn't blank out. The sync worker overwrites the response on
 * its first success.
 */
```

(纯文档强化,无运行时影响。ESLint rule 留给未来 — 一行 import 容易 review 时抓住。)

---

## 6. 不做的事 (YAGNI)

- ❌ **不**让新 Inngest function 自动写入 AGENT_MAP — 仍需在 AGENT_MAP 加一行获得 stage/owner 元数据,只是不加之后也能在 Fleet 看到 (走 stage="unknown" 占位)
- ❌ **不**做 UI 反向推送到 Allmeta — UI 对事件目录只读
- ❌ **不**自动在每次页面加载触发 Allmeta 同步 — worker 按 interval 自己跑,UI 只显示状态 + 提供手动刷新
- ❌ **不**把 `AGENT_MAP` 整张表搬到 DB — stage/owner/version 这类元数据极少变,文件 source-of-truth 改起来更直观
- ❌ **不**重构 `useInngestLiveOverlay` — 它已经是活的,这次只换它内部的 slug 来源
- ❌ **不**做"agent 部署历史/版本回滚" — 那是 Manage pillar 的职责

---

## 7. 文件清单

### 新增 (8)

| 路径 | 用途 |
|---|---|
| `lib/inngest-registry.ts` | live registry + slug helpers |
| `lib/inngest-registry.test.ts` | vitest |
| `lib/hooks/useEventCatalog.ts` | 单例缓存的 events hook |
| `app/api/system/config/route.ts` | GET system config snapshot |
| `app/api/system/config/route.test.ts` | vitest |
| `app/api/em/sync/event-definitions/run-now/route.ts` | POST 手动触发 Allmeta 同步 |
| `components/shared/InngestPill.tsx` | 顶部 Inngest 永久 pill |
| `components/shared/SystemConfigModal.tsx` | 详情 modal |
| `components/events/AllmetaSyncStrip.tsx` | /events 顶部同步状态条 |

### 改动 (13)

| 路径 | 改动 |
|---|---|
| `lib/agent-mapping.ts` | 加 `inngestId?` 字段;**删** `INNGEST_REAL_SHORTS`、`isReal()` 同步版本(改 async 或下沉到 registry);4 个 real agent 补 `inngestId` |
| `lib/api/inngest-live-overlay.ts` | `WSID_TO_INNGEST_SLUG` 改为 `await fetchLiveRegistry()` lazy 派生;或直接删,消费者改调 `inngestSlugFromShort()` |
| `lib/inngest-url.ts` | 拆出 `getInngestUrlWithSource(): { url, sourceEnv }` 供 `/api/system/config` 用 |
| `app/api/agents/route.ts` | 用 `fetchLiveRegistry()` enrich;追加"AGENT_MAP 外的 live fn" |
| `app/api/agents/route.test.ts` | mock listFunctions,断言 realness 真实化 |
| `app/api/inngest-admin/functions/route.ts` | `MONITORED_FALLBACK` 改为基于 `fetchLiveRegistry()` 派生 |
| `components/fleet/FleetContent.tsx` | 顶部插 `<InngestPill />`;`liveCount` 直接读 enriched `realness === 'real'` |
| `components/fleet/AgentDetailContent.tsx` | `isReal` 改用 enriched data (从 `/api/agents` 获取),不再直接 import 静态判断 |
| `components/monitor/MonitorContent.tsx` | 删 4 个 `if (short === "...")`;改 `await inngestSlugFromShort(short)` |
| `components/monitor/MonitorHeader.tsx` | 顶部插 `<InngestPill />` |
| `components/events/EventsContent.tsx` | 顶部插 `<AllmetaSyncStrip />` |
| `components/events/EventLogModal.tsx` | `EVENT_CATALOG` import → `useEventCatalog()` hook |
| `lib/events-catalog.ts` | `@deprecated` 注释加强 |
| `lib/i18n.tsx` | +13 个新 i18n key (zh + en) |

### 删除 (3 个符号,不是文件)

| 符号 | 文件 |
|---|---|
| `INNGEST_REAL_SHORTS` Set | `lib/agent-mapping.ts:86` |
| `WSID_TO_INNGEST_SLUG` Record | `lib/api/inngest-live-overlay.ts:22` (酌情;若消费者全部改为 hook,可以删) |
| `REAL_ID_BY_SHORT` Record | `app/api/inngest-admin/functions/route.ts:30` (随 MONITORED_FALLBACK 整体改写) |

---

## 8. 迁移阶段

| Phase | 动作 | Rollback |
|---|---|---|
| **P0** | 加 `lib/inngest-registry.ts` + `inngestId` 字段 + 4 real agent 标注;`isReal()` 改 async wrapper(同步版本临时保留 → log warn) | `git revert` 单 PR |
| **P1** | `/api/agents` enrich + `/api/inngest-admin/functions` MONITORED_FALLBACK 改写 + Fleet/Monitor/AgentDetail callsites 改;删 `INNGEST_REAL_SHORTS` 等 3 个符号 | 单 PR revert |
| **P2** | `/api/system/config` + `<InngestPill />` + `<SystemConfigModal />` + Fleet/Monitor header 接入 | 单 PR revert |
| **P3** | `/api/em/sync/event-definitions/run-now` + `<AllmetaSyncStrip />` + `<EventLogModal />` 切 `useEventCatalog()` | 单 PR revert |

各 Phase 互不依赖,可并行。

---

## 9. Definition of Done

1. **真"4/24"**: 关掉 Inngest dev server,Fleet 顶部 SummaryChip 显示 "实装 0 / 24"。重启 Inngest,5 秒内显示恢复真实数。
2. **新 agent 自动出现**: 在 `server/inngest/agents/` 加一个新 `*-agent.ts`,**不**改 AGENT_MAP,新函数 5 秒内在 Fleet 出现 (stage='unknown',ownerTeam='—')。
3. **Inngest URL 显示**: Fleet/Monitor 顶部 pill 显示当前 URL host:port。修改 `INNGEST_BASE_URL` env 重启,显示更新。
4. **Inngest URL 详情**: 点 pill 打开 modal,看到来源 env var 名 + 备选 env var 当前值 + 健康状态 + 注册函数数 + 24h 运行数。
5. **Allmeta 事件实时**: 在 Allmeta Ontology 加一个新 `EventDefinition`,**不**改 `EVENT_CATALOG`,等同步 worker 跑一轮 (或点[手动刷新]),`/events` 页 5 秒内出现该事件。
6. **EventLogModal 不再硬编码**: 移除 `EVENT_CATALOG` 上线的事件,`EventLogModal` 显示 "未在 Allmeta 中找到" 而不是空白。
7. **零回归**: `/live`、`/audit/*`、`/workflow`、`/triggers`、`/correlations` 全部正常,vitest 全过。

---

## 10. Open questions

无 — 用户已确认 A + B + C 三项全做 + 事件来源 Allmeta Ontology。

实施细节(InngestPill 的具体颜色、staleness 阈值 5 min vs 10 min)在 writing-plans 阶段细化。
