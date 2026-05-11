# resume-parser-agent

Proof-of-concept event-driven agent built with **Next.js + Inngest** to validate
the agentic-workflow design with the partner's RAAS / Action_and_Event_Manager
platform. No LLM — deterministic parse stub.

## Behavior

```
resume.uploaded   (in,  published by RAAS / partner)
        │
        ▼
   logger.info("Received the resume — …")
        │
        ▼
   parse-resume step (250ms stub, deterministic)
        │
        ▼
resume.parse      (out, published by this agent)
```

Event payloads are declared via `EventSchemas` in
[lib/inngest/client.ts](lib/inngest/client.ts), so both the function and the
test publisher are type-safe.

## Stack

- Next.js 15 (App Router) on port **3020**
- Inngest 3.52 (serve handler at `app/api/inngest/route.ts`)
- TypeScript 5.9, Node.js 22+

## Run end-to-end (3 terminals)

```bash
# 1. Inngest Dev Server — the event bus shared by all services
#    Uses local inngest-cli (in devDependencies) — no @latest fetch.
npm install        # only the first time
npm run inngest:dev
#   UI: http://localhost:8288

# 2. This agent (Next.js)
cd resume-parser-agent
npm install        # only the first time
npm run dev
#   Next.js: http://localhost:3020
#   Inngest serve endpoint: http://localhost:3020/api/inngest

# 3. Register this agent's 3 functions with Inngest dev server
#    (resumeParserAgent / createJdAgent / matchResumeAgent)
#    必要,因为 inngest-cli 默认 autodiscovery 扫不到 3020 端口
cd resume-parser-agent
npm run register
#   ⇢ POST http://localhost:8288/fn/register { url: http://localhost:3020/api/inngest }
#   注册成功后 Inngest UI (http://localhost:8288 → Functions) 能看到 3 个 functions

# 4. Publish a test event (simulates the partner / RAAS)
npm run publish:test
#   or: npm run publish:test -- <resume_id> "Candidate Name"
```

### 用 Docker 启 Inngest 时(主仓 npm run inngest:up)

主仓 [`docker-compose.inngest.yml`](../docker-compose.inngest.yml) 已经
`-u http://host.docker.internal:3020/api/inngest` 自动同步本 SDK,
**不需要单独跑 `npm run register`**。
但如果你改了 docker-compose 的 -u 列表后想生效,要 `docker compose down && docker compose up -d` 重建容器
(`up -d` 检测到配置变化自动 recreate)。

In the Inngest Dev Server UI (http://localhost:8288 → **Stream**) you'll see:
1. `resume.uploaded` arrive
2. The `resume-parser` function execute
3. `resume.parse` published as a downstream event

Agent stdout prints the literal log line:
```
Received the resume — resume_id=… candidate=Ada Lovelace file=https://example.com/…
[resume-parser] parsing resume … (deterministic stub, no LLM)
[resume-parser] published resume.parse — resume_id=… skills=3 duration=257ms
```

## Wiring with the partner (RAAS / @aem/server)

The partner's server runs an Inngest client (`id: 'event-manager'`) registered
at `http://localhost:8000/api/inngest`. Both services hit the **same** local
Inngest Dev Server, so when their pipeline calls:

```ts
await inngest.send({ name: 'resume.uploaded', data: { … } });
```

Inngest fans out to every registered subscriber — including this agent. No
direct HTTP between the two services is needed; Inngest is the bus. This
proves the event-driven design works across independent services.
