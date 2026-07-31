# Domain Foundation — Phase 0 Design Spec

**Date:** 2026-06-01
**Authors:** Steven · Claude
**Scope:** Make AO's top-level "domain" concept data-driven and user-extensible. Surface the existing AppBar domain switcher as the single source of truth on Overview and Fleet. No new Codegen, deploy, or Manage behavior.
**Out of scope:** agent creation inside a domain (Phase 1 — Codegen integration), deploy/pause/delete actions (Manage axis spec), per-domain event/tool registries (Phase 1 chore), multi-user permissions.

---

## 1. Why this spec exists

`lib/domains.tsx` already models a top-level `DomainId = "raas" | "r7"` scope, with a React provider persisted to `localStorage` and an AppBar pill that switches the active domain. `/fleet` already filters its grid by it. But the concept is **hardcoded as a TypeScript literal union** — users can't create new domains. `r7` sits as a permanently-empty placeholder.

Per the user's vision: AO should host multiple business domains side-by-side (招聘, 采购报销, …), each with its own agent fleet. The codegen flow (Phase 1) will deposit newly-generated agents into the user's currently-selected domain.

This spec ships the **container layer only**: domains are data-driven and CRUD-able. Codegen-into-domain, deploy, and Manage actions remain placeholders (see [Fleet IA spec, §6](./2026-05-19-fleet-ia-design.md)).

Per `project_three_pillars` memory, AO has three pillars (Monitor / Manage / Behavior). This spec stays inside the existing Monitor surface — it extends the chrome but doesn't add any write-ops on agents themselves. Manage/Behavior placeholders are preserved verbatim.

---

## 2. Goal in one sentence

> After Phase 0, a user can create a new business domain from the AppBar; that domain appears alongside RAAS in every domain-scoped surface (Overview, Fleet) as an empty container, ready for Phase 1 codegen to fill.

---

## 3. Data model

New Prisma table on the local Postgres data layer (see [local-postgres design](./2026-05-28-local-postgres-inngest-archive-design.md)):

```prisma
model Domain {
  id          String   @id                       // slug. "raas" / "r7" seeded. User-created: lower-kebab from name.
  name        String                              // display name (single string, no zh/en split — user-created domains don't need bilingual)
  color       String                              // OKLCH literal, e.g. "oklch(0.65 0.18 250)"
  is_system   Boolean  @default(false)            // true for raas / r7 — protected from archive
  created_at  DateTime @default(now())
  archived_at DateTime?                            // soft delete; archived domains hidden from UI but rows kept

  @@map("domain")
}
```

**ID strategy:** the existing `raas` / `r7` slugs are seeded as the literal `Domain.id` values so localStorage `ao:domain="raas"` keeps working without migration. For user-created domains, slug is derived from `name` (lower-kebab, ASCII-only after pinyin/transliteration; collisions → 409 with the colliding slug surfaced).

**No agent_id FK.** `AGENT_MAP` stays hardcoded in TS for Phase 0. The Domain table is the source of truth for *what domains exist*; agent→domain is still resolved via the TS `AgentMeta.domain` field. Phase 1 will introduce a `DomainAgent` table when codegen-generated agents need to persist their domain.

**Color palette** (6 OKLCH values rotated for new domains when caller doesn't supply one):
- `oklch(0.65 0.18 250)` — blue (raas seed)
- `oklch(0.65 0.18 145)` — green (r7 seed)
- `oklch(0.65 0.18 30)` — amber
- `oklch(0.65 0.18 320)` — magenta
- `oklch(0.65 0.18 195)` — teal
- `oklch(0.55 0.16 285)` — violet

---

## 4. API surface

Route Handlers under `app/api/domains/`:

| Route | Method | Body | Returns | Notes |
|---|---|---|---|---|
| `/api/domains` | GET | — | `{ domains: Domain[] }` (active only) | sorted: system first, then by `created_at` asc |
| `/api/domains` | POST | `{ name, color? }` | `Domain` or 409 | derives `id` from `name`; collisions return `{ ok: false, reason: "slug_collision", existing_id }` (no auto-suffix — user must rename) |
| `/api/domains/[id]` | PATCH | `{ name?, color? }` | `Domain` | renaming a system domain is allowed; changing `id` is not exposed |
| `/api/domains/[id]` | DELETE | — | `{ ok: true }` or 422 | soft delete (sets `archived_at`); 422 if `AGENT_MAP.some(a => a.domain === id)` with `{ ok: false, reason: "has_agents", count }`; 403 with `{ reason: "is_system" }` for raas/r7 |

All routes are dynamic Route Handlers (`export const dynamic = 'force-dynamic'`) and return the same `{ ok, ... }` shape used elsewhere in `app/api/`.

---

## 5. `lib/domains.tsx` rewrite

The existing module already exposes the right surface (`useDomain()` + provider + `DOMAINS`). The rewrite swaps the data source and widens the type:

**Type changes:**
- `DomainId` widens from `"raas" | "r7"` literal union → `string` (since user-created slugs are unknown at compile time).
- `Domain` shape gains `is_system: boolean` and `archived_at: string | null` (carried through from API).

**Provider changes:**
- `DomainProvider` mounts, fetches `GET /api/domains`, populates state.
- During the brief pre-fetch window, the provider returns the seeded system domains as fallback (so child components don't see an empty list / loading flash).
- `setDomain(id)` validates the id against the fetched list before applying — silently no-ops if unknown (prevents stale localStorage from corrupting state).

**New exports:**
- `useDomainList(): { domains: Domain[], reload: () => Promise<void> }` — for the AppBar dropdown + management modal.
- `useDomainMutations(): { create, rename, archive }` — wraps the POST/PATCH/DELETE routes; on success invalidates the provider's cached list and triggers a re-fetch.

**localStorage hydration:**
- Read `ao:domain` slug.
- After fetch resolves, if the slug isn't in the active list, fall back to the first `is_system` domain (typically `raas`).
- No toast or warning — silent fallback to keep the chrome calm.

---

## 6. AppBar UX

The existing pill (currently a static "RAAS · 招聘中台") becomes a **dropdown trigger**. Clicking opens a small popover anchored under the pill:

```
┌────────────────────────────────────┐
│ ● RAAS · 招聘中台          ✓       │
│ ● R7 · ATS                          │
│ ● 采购报销 (新建的)                  │
├────────────────────────────────────┤
│ ✱ 新建领域…                          │
│ ⚙ 管理领域…                          │
└────────────────────────────────────┘
```

- Each row shows the domain color dot + name. Current domain has a check mark.
- `✱ 新建领域` opens a modal: name input + 6-swatch color picker (or "auto"). Submit → POST + provider reload + auto-switch to the new domain.
- `⚙ 管理领域` opens a list modal: every active domain rendered with rename and archive actions. System rows (raas, r7) have the archive action disabled with a tooltip "系统领域不可删除". Renaming any domain is allowed.

i18n keys are added under both `zh` and `en`. New zh strings live in the existing rule block; en mirrors them.

---

## 7. Overview integration

`/overview` (总览) currently shows `AGENT_MAP.filter((a) => a.short !== "Chatbot")` with no domain awareness. The fix is minimal: add `.filter((a) => a.domain === domain)` using `useDomain()`, matching Fleet's existing pattern at [components/fleet/FleetContent.tsx:206](../../../components/fleet/FleetContent.tsx#L206).

No new chip strip on the page itself — the AppBar pill is the single source of truth. Switching domains from the AppBar updates Overview in real time via the existing provider re-render.

For the new domain (which has zero agents in Phase 0), Overview renders the existing "no agents" empty state (the matrix grid simply has zero rows). No special "Phase 1 coming" copy on Overview — that hint lives on Fleet's empty state where the user is more likely to look for "add an agent".

---

## 8. Fleet integration

Fleet already filters by `useDomain()`. Only addition: a **new empty-state card** when the active domain has zero agents (the user-created, pre-Phase-1 case):

```
┌────────────────────────────────────────────────────┐
│  本领域暂无智能体                                    │
│  Codegen 上线后,可在此领域创建第一个智能体。         │
│                                                     │
│  [+ 部署智能体]  ← 现有占位按钮(待 Behavior 落地) │
└────────────────────────────────────────────────────┘
```

The "+ 部署智能体" button is the **same placeholder** that the [Fleet IA spec §6](./2026-05-19-fleet-ia-design.md) defined — no new handler. Clicking still shows "Behavior 模块未上线 — 现阶段请联系 RAAS".

Existing filters (group by team/status/stage/flat, status tabs, owner-team filter) all work identically — they just operate on the filtered-to-current-domain set. For the empty domain, those controls render as no-ops with the empty state card occupying the grid.

---

## 9. `AGENT_MAP` unchanged

All 22 current agents stay hardcoded as `domain: 'raas'`. New user-created domains start visibly empty (honest — there's no agent placement happening in Phase 0).

This keeps the spec minimal and avoids touching the agent registry, which is read by ~20 callers across the codebase. Phase 1 (Codegen integration) will be where agents start landing in non-raas domains.

---

## 10. Migration / boot

One Prisma migration:

```sql
CREATE TABLE "domain" (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  is_system    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMP NULL
);

INSERT INTO "domain" (id, name, color, is_system) VALUES
  ('raas', 'RAAS · 招聘中台', 'oklch(0.65 0.18 250)', true),
  ('r7',   'R7 · ATS',        'oklch(0.65 0.18 145)', true);
```

Seed runs as part of `prisma db push` per the existing data-layer flow ([CLAUDE.md](../../../CLAUDE.md)).

No client-side migration of `ao:domain` localStorage — values `"raas"` / `"r7"` map directly to seeded ids; stale values fall back silently per §5.

---

## 11. Error handling

| Case | Server response | UI behavior |
|---|---|---|
| `POST` with colliding slug | 409 `{ ok: false, reason: "slug_collision", existing_id }` | Create modal shows inline error: "领域名 '<existing.name>' 已存在,请改名" |
| `DELETE` system domain | 403 `{ ok: false, reason: "is_system" }` | Archive button disabled in the modal — never reached at runtime |
| `DELETE` non-empty domain | 422 `{ ok: false, reason: "has_agents", count }` | Modal shows "此领域下还有 N 个智能体,请先迁移或删除" |
| `PATCH` non-existent | 404 | Toast: "领域不存在(可能已被删除),刷新一下" |
| localStorage `ao:domain` stale | (client-only) | Silent fallback to first `is_system` domain |
| `GET /api/domains` fails | 500 | Provider keeps the seeded fallback (raas + r7); AppBar dropdown shows them only; create/archive disabled with tooltip "领域服务暂不可用" |

---

## 12. Testing

Vitest suites (all under `__tests__/` or co-located):

1. **`/api/domains` CRUD** — happy path for each verb + the three error cases above (slug collision, system-protect, archive-with-agents).
2. **`lib/domains` provider** — hydration with a known slug; hydration with a stale slug (falls back to first system); `useDomainMutations` create-then-list reflects the new row.
3. **`AGENT_MAP` integration** — assertion: `archive(id)` with `AGENT_MAP.some(a => a.domain === id)` returns 422.

No e2e in Phase 0 — the UX surface is small (one dropdown, two modals, one empty state). Manual walkthrough: "create domain → see it in AppBar → switch to it → Overview empty → Fleet shows empty-state card → switch back to RAAS → 22 agents visible" covers it.

---

## 13. Open items deferred to Phase 1

Tagged here so they don't sneak into Phase 0:

| Item | Where it lands |
|---|---|
| Codegen scoped to current domain (`/behavior/codegen?domain=<id>` + new agent persists its domain) | Phase 1 spec — extends [PromptGen-CodeGen spec](./2026-05-27-promptgen-codegen-design.md) |
| `DomainAgent` Prisma table — agents persist their domain (replacing hardcoded `AgentMeta.domain`) | Phase 1, when codegen needs it |
| `+ 部署智能体` button real handler | Behavior axis spec (not yet drafted for end-user agent deployment) |
| Per-agent `Pause / Roll back / Reassign / Deprecate` real handlers | Manage axis spec |
| Per-domain event/tool registries (codegen reads the right slice) | Phase 1 chore |
| Multi-user permissions, domain ownership, RBAC | Out of scope (single-user dev for now) |

---

## 14. Acceptance criteria

Phase 0 is correct if all of these hold:

1. `prisma db push` creates the `domain` table and seeds `raas` + `r7` with `is_system=true`.
2. `GET /api/domains` returns the two seeded rows on a fresh database; after `POST { name: "采购报销" }`, the list returns 3 rows.
3. Clicking the AppBar pill opens a dropdown with the 3 domains + the two action items.
4. Creating a new domain via the modal switches the active domain to the new one automatically. localStorage `ao:domain` is updated.
5. With "采购报销" active, `/overview` shows zero agents in its matrix; `/fleet` shows the empty-state card.
6. Switching back to RAAS via the AppBar restores the 22-agent view on both pages immediately (no reload).
7. Archiving "采购报销" succeeds and it disappears from the dropdown; localStorage falls back to `raas` silently.
8. Attempting to archive `raas` is rejected by the API (403) and disabled in the UI.
9. All 22 agents in `AGENT_MAP` remain `domain: 'raas'` — no edits to the agent registry.
10. The Fleet IA spec's placeholder behaviors (the `+ 部署智能体` modal, the per-agent Manage buttons) are unchanged.

---

## 15. Non-goals

- Agent creation, codegen, deploy, pause, delete — Phase 1 / Manage / Behavior spec.
- Per-domain event or tool registries — Phase 1 chore.
- Cross-domain analytics or comparisons — not in scope.
- Domain-level RBAC or multi-user — single-user dev for Phase 0.
- Visual redesign of AppBar — only the pill becomes a dropdown trigger; everything else stays.
- Mobile / responsive design for the modals — desktop only, same as the rest of AO.
