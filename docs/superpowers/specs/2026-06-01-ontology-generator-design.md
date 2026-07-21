# 本体智能体生成器 (Ontology Generator) — Design

Date: 2026-06-01
Status: Approved (design), pending spec review gate
Author: Steven + Claude

## Summary

Replace the **Codegen / Library Codegen** feature with a new **Ontology Generator**
(本体智能体生成器) page: a 3-step wizard that reads a business domain's ontology
(rules / data objects / actions / events / workflow), **infers** which AI agents the
domain is missing, lets the operator select them, **generates** them (persisted as
drafts), and lands a success screen that routes onward to the fleet.

The page is visually driven by the handoff screenshots: a stepper header
(推断 → 生成 → 部署), a left ontology panel with five element-category counts, an
idle hero with an "推断智能体" CTA, two "agents running" animation stages
(inferring / generating), inferred-agent cards with confidence rings + ontology
rationale, and a green-check deploy-result screen.

Backing model (per brainstorm decisions):
- **Real ontology + curated results.** A thin API route reads real ontology / event /
  agent libs and runs real "dangling event / unbound action" gap analysis, then
  overlays curated demo data so the recruitment domain converges to the two agents in
  the design (岗位撮合 96%, 面试邀约 92%). Generate/deploy are animated simulations
  whose output is persisted as **draft** `AgentVersion` rows.
- **Full physical deletion** of the Codegen tree, verified by `knip` + `build`.
- **Switchable domain dropdown** driven by a self-contained domain-profile catalog.

## Goals / Non-goals

**Goals**
- Remove Codegen / Library Codegen entirely (routes, components, API, lib, i18n,
  dev smoke page, npm script) with a clean `build`.
- Ship `/behavior/ontology-generator` matching the screenshots, with minimalist +
  "cool" animations during the inferring and generating waits that visibly convey
  "agents are running".
- Persist generated agents as `status:"draft"` `AgentVersion` rows.

**Non-goals (explicitly out of scope this iteration)**
- Surfacing the generated drafts inside `/fleet`. The fleet list (`/api/agents`)
  keeps reading `AGENT_MAP` + live Inngest; "前往舰队部署 →" is **navigation only**.
- Real LLM code generation / real Inngest deployment (the codegen pipeline that did
  this is being deleted).
- Importing the out-of-repo 费控 / 能源调度 ontologies; those domains are curated
  static profiles.

## Part 1 — Deletion (Codegen / Library Codegen)

Physically delete:

| Path | Notes |
|---|---|
| `app/behavior/codegen/` (incl. `library/`) | 2 routes |
| `app/api/codegen/` (incl. `library/`) | 9 route handlers |
| `components/behavior/codegen/` (incl. `library/`) | ~15 components |
| `lib/agent-codegen/` (whole tree) | ~40 files |
| `app/dev/compile/page.tsx` | imports `agent-codegen/compiler/types`, calls `/api/codegen/compile` |
| `scripts/codegen-eval.ts` | imports `agent-codegen/eval/*` |

Edits:
- `package.json` — remove the `codegen:eval` script.
- `components/shared/LeftNav.tsx` — remove the two items (lines 82-83) and add the new
  Ontology Generator item (see Part 2).
- `lib/i18n.tsx` — remove `nav_codegen`, `nav_lib_codegen`, and the
  `codegen_*` / `lib_*` / `eval_*` / `autoiter_*` / `fix_*` blocks **by enumerated key,
  not by blind prefix** (a `lib_`/`eval_` prefix can collide with unrelated keys).

**Safety procedure** (i18n key removal is invisible to `tsc` — `t("missing")` just
returns the key):
1. Delete trees + files.
2. For each candidate i18n key, grep the whole repo for `"<key>"`; only remove keys
   with zero surviving references.
3. `npx knip` — confirm no new unreachable/broken entries.
4. `npm run build` — must pass typecheck + lint clean.

`app/dev/generate-prompt` uses `lib/ontology-gen` (NOT `agent-codegen`) and stays.

## Part 2 — Navigation + route

- Route: `app/behavior/ontology-generator/page.tsx` (thin Shell wrapper,
  `crumbs={["Behavior","Ontology Generator"]}`, renders `<OntologyGeneratorContent />`).
- LeftNav: in the **构建 / Build** group, replace the two removed items with:
  ```ts
  { type: "item", id: "ontology-gen", icon: "branch",
    label: t("nav_ontology_gen"), href: "/behavior/ontology-generator" },
  ```
  (`branch` = the connected-node icon matching the hero graphic; shared with
  `correlations`, which is acceptable.)
- i18n: add `nav_ontology_gen` ("本体智能体生成器" / "Ontology Generator") and an
  `og_*` namespace for all page strings, under both `zh` and `en`.

## Part 3 — Component architecture

Follows the app's `Shell + *Content` skeleton. All under
`components/behavior/ontology-generator/`:

- **`OntologyGeneratorContent.tsx`** — orchestrator. Holds wizard state and renders the
  stepper + current phase view. State:
  ```ts
  type Phase = "idle" | "inferring" | "inferred" | "generating" | "deployed";
  // domainId, ontology counts, candidates[], selectedKeys:Set, generated[] (drafts)
  ```
- **`StepRail.tsx`** — the 推断 / 生成 / 部署 header: numbered circles, connectors,
  done-check states (driven by `Phase`).
- **`OntologyPanel.tsx`** — left card "Ontology · 本体": five rows
  (规则 Rules / 数据对象 Data Objects / 动作 Actions / 事件 Events / 工作流 Workflow)
  with per-category icon chips + counts, and the total "N 元素" badge. Hidden during
  the full-bleed running/deploy stages (matching the screenshots).
- **`InferIntro.tsx`** — idle hero: big node-graph icon, "从本体推断智能体" title,
  blurb, primary "推断智能体" button.
- **`RunningStage.tsx`** — the shared "agents running" animation shell, used by BOTH
  `inferring` and `generating` with different captions (see Part 5). Props:
  `{ title, subtitle, ticker }`.
- **`InferredAgentCard.tsx`** — one inferred candidate: category icon chip, Chinese
  name + monospace agent id, description, event-transition badges `A → B`, a
  「本体依据」rationale box, a `ConfidenceRing`, and a selection checkbox.
- **`ConfidenceRing.tsx`** — SVG ring gauge (reuses the `rc-gauge-arc` stroke-draw
  pattern), color green/amber by confidence.
- **`DeployResult.tsx`** — success screen: green-check pop, "N 个智能体已生成并验证",
  a compact list of the generated drafts with 草稿 status badges, and the
  「再建一批」/「前往舰队部署 →」buttons.

Small/one-off bits may be co-located in their parent rather than split into files.

## Part 4 — Data layer + API

### Types (`lib/ontology-generator/types.ts`)
```ts
export type OntologyCounts = {
  rules: number; dataObjects: number; actions: number;
  events: number; workflow: number;        // total = sum
};

export type InferredAgentCandidate = {
  key: string;                 // stable id for selection
  short: string;               // AGENT_MAP short code (AgentVersion.short)
  slug: string;                // inngest id (AgentVersion.slug)
  nameZh: string; nameEn: string;
  agentId: string;             // mono display id, e.g. "MatchResumeAgent"
  descZh: string; descEn: string;
  triggerEvent: string; emitEvent: string;   // A → B badges
  rationaleZh: string; rationaleEn: string;   // 「本体依据」 = the gap description
  confidence: number;          // 0..100
  iconChar: string; iconColor: string;        // card icon chip
};

export type DomainProfile = {
  id: string; nameZh: string; nameEn: string;
  counts: OntologyCounts;
  candidates: InferredAgentCandidate[];
};
```

### Domain profiles (`lib/ontology-generator/profiles.ts`)
`DOMAIN_PROFILES: Record<string, DomainProfile>` powering the dropdown:
- **招聘交付 (`raas`)** — counts + candidates aligned with real libs (see infer logic);
  this is the screenshot domain (2 candidates, 96% / 92%).
- **费控 / 能源调度** — curated static profiles (their ontologies live outside the repo,
  per the ontology-gen deliverables). Each surfaces its own 2-3 candidates so switching
  domains visibly changes the result.

### Inference (`lib/ontology-generator/infer.ts`)
For `raas`, runs **real** gap analysis as the source of the candidate rationales:
- From `lib/events-catalog.ts`: find events with non-empty `publishers` but empty
  `subscribers` (dangling/unconsumed) → these motivate a consumer agent.
- Cross-check against `lib/agent-mapping.ts` (which `triggersEvents`/`emitsEvents` are
  already bound) to avoid proposing an agent that already exists.
- Overlay the curated `DomainProfile.candidates` to converge to the designed two and
  to supply display copy (names, confidence, icons). The gap finding fills/validates
  the `rationale*` text. For non-`raas` domains, return the curated profile directly.

Unit-tested in isolation against the static catalog (no network).

### API routes
- **`POST /api/ontology-generator/infer`** → `{ domainId }` ⇒
  `{ domainId, counts, candidates }`. Thin handler over `infer.ts`.
- **`POST /api/ontology-generator/generate`** → `{ domainId, selectedKeys }` ⇒
  for each selected candidate, upsert an `AgentVersion`:
  ```ts
  { short, slug,
    versionLabel: <generated, e.g. "2026-06-01-1830-og">,   // unique with short
    status: "draft",
    capturedFrom: "ontology-gen",          // new provenance value
    generatedBy: <operator>,
    notes: `inferred from ${domainId} ontology` }
  ```
  Returns the created/updated draft rows. `@@unique([short, versionLabel])` is satisfied
  by the timestamped label; re-running yields a new draft label (idempotency is not a
  goal — each generate run is its own draft batch).
  **Fallback:** if mapping a candidate to required `AgentVersion` fields is not clean
  for a curated (non-raas) domain whose `short`/`slug` don't exist in `AGENT_MAP`, that
  domain's generate persists nothing and the success screen shows an in-session draft
  list instead (decided per-domain in the plan).

## Part 5 — Animations

Add `og-*` keyframes to `app/globals.css`, reusing the existing
`cubic-bezier(.22,1,.36,1)` vocabulary and **all gated by
`@media (prefers-reduced-motion: reduce)`** like the current animations:

- `ogGridPulse` — faint grid backdrop breathing.
- `ogOrbit` — small dots orbiting the central node.
- `ogScanLine` — a horizontal sweep line crossing the stage.
- `ogProgressFlow` — bottom progress bar fill + flowing node dots.
- Confidence ring draw — reuse `rc-gauge-arc`.
- Inferred-card entrance — reuse `ao-pop-in` / `rc-verify-reveal` (stagger via
  `--ao-i`).
- Final green check — reuse `rc-verdict-pop`.

`RunningStage` captions:
- inferring → title "正在推断智能体", subtitle "分析「<domain>」本体中的 N 个元素",
  ticker "推断智能体并评估置信度".
- generating → title "正在生成 N 个智能体", subtitle "合成提示词 · 生成运行时 · 沙箱验证",
  ticker "注册到事件总线".

Each running stage enforces a **minimum dwell** (inferring ~2s, generating ~2.5s) so the
animation reads fully even if the API returns instantly; the phase advances on
`max(apiDone, minDwell)`.

## Part 6 — State transitions

```
idle ──(推断智能体)──▶ inferring ──(max(infer API, ~2s))──▶ inferred
inferred ──(生成 N 个)──▶ generating ──(max(generate API, ~2.5s))──▶ deployed
inferred ──(重新推断)──▶ inferring
deployed ──(再建一批)──▶ idle (clear candidates/selection)
deployed ──(前往舰队部署 →)──▶ router.push("/fleet")
domain change (any phase) ──▶ idle
```
Default selection = all candidates checked. The generate button label reflects the
selected count ("生成 N 个智能体"); disabled when zero selected.

## Part 7 — i18n

All chrome/labels via `t()` under `og_*` + `nav_ontology_gen`, added to both `zh` and
`en`. Per project convention, **data-like tokens stay literal**: monospace agent ids
(`MatchResumeAgent`), event names (`MATCH_RULE_CHECK_PASSED`), and confidence percentages
are not translated. Curated domain/candidate display copy that is mock-data-only
(domain names, agent descriptions) lives in `profiles.ts`, not `t()`, matching how other
pages hardcode domain copy.

## Part 8 — Testing + verification

- **Unit (vitest):** `lib/ontology-generator/infer.ts` selects the correct dangling
  events from `events-catalog` and returns well-formed candidates; `profiles.ts`
  integrity (every candidate has required `AgentVersion` fields for persistable
  domains).
- **Deletion:** `npx knip` clean + `npm run build` clean.
- **Visual:** `npm run dev` (:3002) — manually verify the stepper, both running
  animations, card reveal, confidence rings, and the deploy screen across light/dark
  and zh/en, plus a domain switch changing the result.

## Open recommendations (locked unless changed at review)
- Route `/behavior/ontology-generator`, nav icon `branch`.
- Drafts persist to `AgentVersion` with `capturedFrom:"ontology-gen"`.
- "前往舰队部署 →" navigates to `/fleet`; fleet listing is not modified.

## Part 9 — Agent lifecycle (Phase 2, added 2026-06-01)

Extension: generated agents persist per business domain as drafts, are managed
from the Fleet「部署智能体」store, and move through a deploy → online/offline →
back-to-draft lifecycle. Real-runtime intervention is allowed for the genuine
agents, but generated agents are **sandboxed shells** that can never affect the
real production runtime.

**Sandboxing.** Every generated agent's `slug` is `og-…` (e.g. `og-match-resume`)
— never a real Inngest function id. Its `short` is the display agent id
(`MatchResumeAgent`). So deploying / onlining / offlining a shell writes only its
own `AgentVersion` row; it never matches a real function and never touches a real
`AgentConfig`. Verified: shell ops create no `AgentConfig` row and leave the real
`match-resume-agent` config untouched.

**Schema.** `AgentVersion` gains `domain String?` (set for shells) and a
`status` value `offline` (draft | active | offline | archived), plus an
`@@index([capturedFrom, domain, status])`.

**Persistence.** `POST /api/ontology-generator/generate` writes every selected
candidate as `status:"draft"`, `capturedFrom:"ontology-gen"`, `domain:<profile>`,
with the display card stashed as JSON in `configJson`. All domains persist
(the earlier curated-domain in-session fallback is removed).

**Lifecycle API** (`/api/agent-drafts`, guarded to `capturedFrom='ontology-gen'`
+ `domain != null`):
- `GET /api/agent-drafts[?domain=X]` → `{ rows }` of shells (drafts + deployed).
- `POST /api/agent-drafts/[id]/transition { to: 'draft'|'active'|'offline' }` →
  updates only `AgentVersion.status` (+ `deployedAt` on activate). 403 if the row
  isn't an ontology-gen shell.

**Fleet UI.** The existing top-right `部署智能体` button now opens
`DraftStorePanel` (a right drawer): a 草稿 section (deploy) and a 已部署 section
(online/offline + 放回草稿), each card tagged with its business domain. The
generator's "前往舰队部署 →" routes to `/fleet?drafts=open`, which auto-opens it.

**Real-agent online/offline** reuses the existing Fleet per-row pause/resume
(`/api/inngest-admin/functions/[slug]/toggle`) — that is the real, reversible
runtime intervention for the genuine agents. No new real-toggle endpoint is
added. `放回草稿` applies only to shells (real agents are not drafts).

**Placement note.** Per-agent lifecycle controls live in the Fleet (the agent
registry), not `/monitor` (which is runs-only by IA: "no agent registry →
/fleet"). Mirroring controls onto `/monitor` is a follow-up if desired.

**Operational note.** The `domain` column is a schema change — the dev server
must be restarted (`npm run dev`) to load the regenerated Prisma client before
the HTTP routes persist. Data-layer + sandbox safety verified directly via the
fresh client; production `npm run build` is green.
