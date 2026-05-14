# AO ↔ RAAS:`RESUME_INFO_MISSING` 闭环集成手册

> **读者**:RAAS partner 后端 / `resume_info_repair` flow 实现者
>
> **目的**:让 partner 端正确订阅并处理 AO 发出的 `RESUME_INFO_MISSING` 事件,让用户在 RAAS UI 上补全后**重新触发 rule-check**,完成数据缺失 → 补全 → 重判的闭环。
>
> **基于实测**:本文 §5 端到端测试已在 AO 本地完整跑通(2026-05-12,见 §5 实测数据),partner 这边只需要按 §3/§6 实现订阅 + 重发即可。

---

## 1. 一张图看清整条链路

```
[RAAS] 上传简历
   │
   └─→ emit RESUME_DOWNLOADED
          │
          ▼
   [AO resumeParserAgent]  下载 → 调 RAAS /api/v1/parse-resume → 解析
          │
          └─→ emit RESUME_PROCESSED (带 parsed.data)
                │
                ▼
   [AO matchResumeAgent]  rule-check (Gemini 3 Flash 评估 27 条规则)
                │
                ├─ LLM 评估时发现"简历未提供 X" / "缺 Y"
                │       │
                │       └─→ AO emit  RESUME_INFO_MISSING ★
                │              │
                │              ▼
                │      [RAAS] subscribe → flow_runtime `resume_info_repair`
                │              │
                │              ├─ partner UI 提示用户填写缺失字段
                │              │
                │              └─→ 用户填完 → RAAS 把字段写进 RAAS DB
                │                     │
                │                     └─→ RAAS 重新 emit RESUME_PROCESSED
                │                            (parsed.data 含新填字段)
                │                            ↑ 回到 matchResumeAgent
                │
                └─ 否则正常折叠:
                   ├─ PASS → emit RULE_CHECK_PASSED → matchResume RAAS API
                   └─ FAIL → emit RULE_CHECK_FAILED → 中止
```

---

## 2. AO 端何时发 `RESUME_INFO_MISSING`

AO 在 [matchResumeAgent](../server/inngest/agents/match-resume-agent.ts) 跑完 rule-check 后,会扫 `rule_flags[]`,把这些情况识别成"信息缺失":

- `result = "NOT_APPLICABLE"`
- evidence 文本里包含 `简历未提供 <字段>` / `未提供 <字段>` / `缺 <字段>` / `缺失 <字段>` 中的任一

抠出来的字段会按"哪些规则被这个字段卡住"聚合,然后单独 emit。

**只要有 1 条规则被字段缺失卡住,就 emit。不管整体 decision 是 PASS 还是 FAIL**(典型场景:整体 FAIL 因为 10-5 学历不符,但 10-47 婚育规则缺性别 → 仍然发 RESUME_INFO_MISSING 给 partner,因为下次该候选人匹配不同 JR 这些字段可能用得上)。

---

## 3. `RESUME_INFO_MISSING` Payload Schema

事件名:`RESUME_INFO_MISSING`(跟 `lib/events-catalog.ts:128` + partner ontology 对齐)

### data 顶层(AO 实际产出格式)

```json
{
  "upload_id": "f6e2f978-a092-d3cd-b2c2-694fcd309be2",
  "candidate_id": "04bcaedb-b1e8-4863-bee9-3e5c16e0caa3",
  "resume_id": "1e319239-1f71-a2f4-ce6a-22559248d668",
  "job_requisition_id": "JRQ-f592f8ce-...-R20260401429",
  "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
  "missing_fields": [
    {
      "field": "利益冲突声明",
      "rule_ids": ["10-27"],
      "rule_names": ["腾讯亲属关系回避规则"],
      "evidence_excerpt": "简历中未提供利益冲突声明。"
    },
    {
      "field": "性别",
      "rule_ids": ["10-47"],
      "rule_names": ["腾讯婚育风险审视与推荐要点"],
      "evidence_excerpt": "简历未提供性别，无法判定婚育风险。"
    }
  ],
  "audit_id": "rca_01KRDTF74P2T72YK5CMZG56VYH_1omrdxe_0bc0y1d",
  "occurred_at": "2026-05-12T10:07:30.522Z"
}
```

### 字段含义

| 字段 | 类型 | 说明 |
|---|---|---|
| `upload_id` | string | 上传批次 ID,RAAS 端找到原 candidate 记录的主键 |
| `candidate_id` | string | RAAS DB 里的 Candidate 主键 |
| `resume_id` | string | RAAS DB 里的 Resume 主键 |
| `job_requisition_id` | string | 当前匹配的 JR,**信息缺失是相对这条 JR 的规则集来说的** |
| `client_id` | string | 客户 UUID(如 `f592f8ce-...`) |
| `missing_fields[]` | array | 缺的字段列表,见下表 |
| `audit_id` | string | 本次 rule-check 的 audit ID,partner 想追溯可在 AO `/rule-check` UI 查看完整 prompt + LLM 响应 |
| `occurred_at` | ISO8601 | AO 检测到缺失的时间 |

### `missing_fields[i]` 子字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `field` | string | 缺的字段名(LLM evidence 里抠出来,**中文,可能跟 RAAS 字段名不一致 — 见 §4 字段映射**) |
| `rule_ids[]` | string[] | 哪些规则被这个字段卡住(没法判定),例 `["10-27"]` |
| `rule_names[]` | string[] | 同上,规则名(中文) |
| `evidence_excerpt` | string | LLM 原文 evidence 节选(≤120 字符),方便 RAAS UI 给用户解释"为什么要填这个" |

---

## 4. ⚠️ 字段命名对齐(关键 — 实测踩坑)

LLM 输出的 `missing_fields[].field` 是**中文字段名**(从规则文本抠出来),不是 RAAS DB / parsed.data 的英文字段名。Partner 实现 `resume_info_repair` 时**必须做字段映射**。

### AO 实测下来 LLM 期待的字段 → parsed.data 实际字段名

| LLM 输出中文字段 | 应填到 `parsed.data.<key>` | 数据格式 | 触发规则 |
|---|---|---|---|
| `性别` | `parsed.data.gender` | string,"男" / "女" | 10-47 婚育风险 |
| `婚育情况` | `parsed.data.marital_status` | string,"未婚" / "已婚" / "离异" | 10-47 |
| `国籍` | `parsed.data.nationality` | string,"中国" / `<其他>` | 10-35 外籍候选人 |
| `期望薪资` / `期望薪资范围` | `parsed.data.expected_salary_range` | string,如 `"15k-18k"` | 10-7 期望薪资校验 |
| `出生年份` | `parsed.data.birth_year` 或 `parsed.data.birth_date` | string/int,"1996" 或 ISO date | 10-12 学历年龄逻辑 |
| `利益冲突声明` | `parsed.data.conflict_of_interest_declaration` + `parsed.data.conflict_of_interest_summary`(同时给) | object + string,见下 | 10-27 亲属关系回避 |

### `conflict_of_interest_declaration` 对象建议格式

```json
"conflict_of_interest_declaration": {
  "has_relatives_in_client_company": false,
  "declared": true,
  "declared_at": "2026-05-12T10:00:00Z",
  "source": "manual_fill_by_recruiter"
},
"conflict_of_interest_summary": "候选人声明无亲属关系冲突 (declared at 2026-05-12 by recruiter)"
```

**⚠️ 实测发现**:即使补了 `conflict_of_interest_declaration` 对象,LLM 在下次评估时还会要求"利益冲突声明数据"(字段名稍变)。原因:LLM 看 parsed.data 里 key 名 + 字符串值,**对嵌套对象的内容不敏感**。所以 partner **必须同时加一个字符串 summary 字段**让 LLM 在原文里能看到关键信息。

**长期方案**:跟 AO 协调把 LLM prompt 里要求的字段名固化(目前是 LLM 从规则文本自由抠词),partner 按固定 schema 填。

---

## 5. 实测端到端 trace(2026-05-12 已在 AO 本地跑通)

### Round 1 — 原始事件(部分字段缺失)

发原始 RESUME_PROCESSED(江银行 5 年抖音运营简历,parsed.data 没有 gender / marital_status / expected_salary 等):

```bash
curl -X POST http://localhost:8288/e/dev \
  -H "Content-Type: application/json" \
  --data @docs/requirement-logged-raw-payload.json
```

**Round 1 audit 输出**:
- `audit_id`: `rca_01KRDTF74P2T72YK5CMZG56VYH_1omrdxe_0bc0y1d`
- decision: `FAIL`
- failure_reasons: `["10-5:DEGREE_MISMATCH", "10-7:EXPECTED_SALARY_UNKNOWN"]`
- AO emit `RESUME_INFO_MISSING`(2 条 missing_fields):
  ```json
  { "missing_fields": [
    { "field": "利益冲突声明", "rule_ids": ["10-27"] },
    { "field": "性别",       "rule_ids": ["10-47"] }
  ]}
  ```

### Round 2 — 模拟 partner 补全(把字段加到 parsed.data 重发)

```javascript
// 模拟 partner 的 resume_info_repair flow 处理完用户表单后做的事
parsed.data.gender = "男";
parsed.data.marital_status = "未婚";
parsed.data.nationality = "中国";
parsed.data.expected_salary_range = "15k-18k";
parsed.data.conflict_of_interest_declaration = {
  has_relatives_in_client_company: false,
  declared: true,
  declared_at: new Date().toISOString(),
  source: "manual_fill_by_recruiter",
};

// 标记本次 emit 是补全后的重发(给 AO 审计用)
data.source_channel = "raas_resume_info_repair";
data.enrichment_applied = {
  filled_fields: ["gender", "marital_status", "nationality",
                  "expected_salary_range", "conflict_of_interest_declaration"],
  parent_audit_id: prevAuditId,
  retry_count: 1,
};

// 重发 RESUME_PROCESSED
await inngest.send({ name: "RESUME_PROCESSED", data });
```

**Round 2 audit 输出对比**:

| 规则 | Round 1 | Round 2 | 变化 |
|---|---|---|---|
| `10-5` 学历 | FAIL `DEGREE_MISMATCH` | FAIL `DEGREE_MISMATCH` | 不变(hard fact,partner 无法补) |
| `10-7` 期望薪资 | FAIL `EXPECTED_SALARY_UNKNOWN`(缺数据) | **FAIL `SALARY_MISMATCH`**(15k-18k > 16k 上限) | ✓ **从"缺数据"到"可判定"** |
| `10-35` 外籍 | NOT_APPLICABLE / 缺 | **PASS** "国籍为中国,不涉及外籍通道限制" | ✓ 补 nationality 后可评估 |
| `10-47` 婚育 | NOT_APPLICABLE(缺性别) | (LLM 已能评估,跑出 PASS/FAIL) | ✓ 补 gender 后可评估 |

→ **enrichment 验证成功**:补字段后 LLM 评估的 evidence 从"未提供 X"变成"X 是 <具体值>, 判定结果是 Y"。

### Round 2 仍然 emit 的 RESUME_INFO_MISSING

```json
{ "missing_fields": [
  { "field": "利益冲突声明数据", "rule_ids": ["10-27"] }
]}
```

→ `性别` 已补齐(不再 missing);但 `利益冲突声明` LLM 没识别 `conflict_of_interest_declaration` 对象 → **见 §4 字段命名对齐建议**(加 `conflict_of_interest_summary` 字符串字段)。

---

## 6. Partner 实施清单

### 6.1 订阅事件

partner Inngest function(加在 `raas_v4/backend/apps/api/src/modules/inngest/functions/`)订阅 `RESUME_INFO_MISSING`:

```typescript
export const resumeInfoRepair = inngest.createFunction(
  { id: "resume-info-repair", retries: 0 },
  { event: "RESUME_INFO_MISSING" },
  async ({ event, step, logger }) => {
    const { upload_id, candidate_id, resume_id, job_requisition_id, missing_fields, audit_id } = event.data;

    // 1. 在 RAAS DB 新建 ResumeRepairTask
    const task = await step.run("create-repair-task", async () => {
      return await prisma.resumeRepairTask.create({
        data: {
          candidate_id,
          resume_id,
          job_requisition_id,
          missing_fields_json: JSON.stringify(missing_fields),
          source_audit_id: audit_id,
          status: "pending",
          created_at: new Date(),
        },
      });
    });

    // 2. 通知招聘专员(InApp / Email)— 用 missing_fields[i].evidence_excerpt 解释原因
    await step.run("notify-recruiter", async () => {
      return await notificationService.send({
        recipient: "recruiter",
        candidate_id,
        title: `候选人简历需补全 ${missing_fields.length} 项信息`,
        body: missing_fields.map(m => `- ${m.field}(规则:${m.rule_names.join('、')})`).join('\n'),
        link: `/repair/${task.id}`,
      });
    });

    return { task_id: task.id, missing_field_count: missing_fields.length };
  },
);
```

### 6.2 UI 提示用户补全

partner UI 拿到 task 后,用 `missing_fields[].field` + `rule_names[]` 渲染表单:

> **岗位 「文秘行政专员」 需要补充以下信息才能继续匹配**:
>
> - [ ] 性别 *(规则:腾讯婚育风险审视与推荐要点)*  下拉:男 / 女
> - [ ] 利益冲突声明 *(规则:腾讯亲属关系回避规则)*  下拉:有亲属在客户公司 / 无亲属在客户公司
>
> _evidence: 简历未提供性别,无法判定婚育风险_

### 6.3 用户填完后 — 重发 `RESUME_PROCESSED`

```typescript
// 接 partner UI 表单 submit
async function onRepairTaskCompleted(taskId: string, userInput: RepairFormData) {
  const task = await prisma.resumeRepairTask.findUnique({ where: { id: taskId } });
  
  // 1. 把字段更新到 RAAS DB(canonical source)
  await prisma.candidate.update({
    where: { candidate_id: task.candidate_id },
    data: {
      gender: userInput.gender,
      marital_status: userInput.marital_status,
      nationality: userInput.nationality,
    },
  });
  await prisma.candidate_expectation.upsert({
    where: { candidate_id: task.candidate_id },
    update: { expected_salary_range: userInput.expected_salary_range },
    create: { /* ... */ },
  });
  
  // 2. 重新拉一次 parsed.data + 拼上 enrichment
  const original = await getOriginalParsedData(task.resume_id);
  const enrichedParsed = {
    ...original,
    gender: userInput.gender,
    marital_status: userInput.marital_status,
    nationality: userInput.nationality,
    expected_salary_range: userInput.expected_salary_range,
    conflict_of_interest_declaration: userInput.coiDeclaration,
    // ⚠️ 关键:也加 summary 字段让 LLM 在原文里能看到关键信息
    conflict_of_interest_summary: buildCoiSummaryText(userInput.coiDeclaration),
  };
  
  // 3. 重发 RESUME_PROCESSED(带 enrichment_applied 元数据)
  await inngest.send({
    name: "RESUME_PROCESSED",
    data: {
      bucket, objectKey, upload_id: task.candidate.upload_id,
      candidate_id: task.candidate_id,
      resume_id: task.resume_id,
      employee_id: task.candidate.recruiter_id,
      job_requisition_id: task.job_requisition_id,
      parsed: { data: enrichedParsed },
      source_channel: "raas_resume_info_repair",
      enrichment_applied: {
        filled_fields: Object.keys(userInput),
        parent_audit_id: task.source_audit_id,
        retry_count: (task.retry_count ?? 0) + 1,
        filled_at: new Date().toISOString(),
      },
    },
  });
  
  await prisma.resumeRepairTask.update({
    where: { id: taskId },
    data: { status: "completed", completed_at: new Date() },
  });
}
```

### 6.4 避免无限循环 — 重试限次

如果 enriched 数据 LLM 还是说"缺",会再 emit 一次 RESUME_INFO_MISSING,可能死循环。Partner 端建议:

```typescript
// 在 resume_info_repair 函数顶部
const retryCount = event.data.enrichment_applied?.retry_count ?? 0;
if (retryCount >= 3) {
  await step.run("escalate-to-human", async () => {
    return await prisma.hitlTask.create({
      data: {
        candidate_id: event.data.candidate_id,
        type: "manual_review_resume_info_unrecoverable",
        priority: "high",
        message: `已重试 ${retryCount} 次仍缺信息:${missing_fields.map(m => m.field).join('/')}`,
        assigned_to_role: "HSM",
      },
    });
  });
  return { skipped: true, reason: "retry_limit_exceeded" };
}
```

AO 端这边不做 retry,纯监控并 emit。

---

## 7. 不在本期范围(已知限制)

- ❌ **AO 不自动重判**:partner 重发 `RESUME_PROCESSED` 后,**会自动触发新的一轮 rule-check**(matchResumeAgent 订阅了 RESUME_PROCESSED)。partner 不需要发额外事件让 AO 重判,自然形成闭环。
- ❌ **AO 不发 ACK**:`RESUME_INFO_MISSING` 是 fire-and-forget,partner 不需要回 ACK。AO 通过下次 RESUME_PROCESSED 是否带 `enrichment_applied` 元数据来知道是补全后的重发。
- ❌ **没有跨 JR 字段缓存**:同一个 candidate 在不同 JR 触发的 `RESUME_INFO_MISSING` 是独立的。Partner 第一次补了 gender 之后,第二次匹配如果还差 gender,**应该直接从 Candidate 表读**(不应该再问用户)。
- ❌ **AO 当前不对 enriched 数据做特殊标记** — 重发 RESUME_PROCESSED 走的还是 matchResumeAgent 正常路径。partner 端可以通过 `source_channel="raas_resume_info_repair"` 区分。

---

## 8. 联调验证脚本

```bash
# 1. 让 AO 触发一次 RESUME_INFO_MISSING(用真实 partner JR + 故意缺字段的 parsed.data)
curl -X POST http://<AO_LAN_IP>:8288/e/<INNGEST_EVENT_KEY> \
  -H "Content-Type: application/json" \
  --data @<resume_processed_with_missing_fields.json>

# 2. 等 30-60s 看 partner Inngest dashboard 是否触发 resume-info-repair
#    应该能看到 1 个 RESUME_INFO_MISSING event + 1 个 resume-info-repair function run

# 3. partner 模拟用户填表完成后,重发 RESUME_PROCESSED
curl -X POST http://<AO_LAN_IP>:8288/e/<INNGEST_EVENT_KEY> \
  -H "Content-Type: application/json" \
  --data '{
    "name": "RESUME_PROCESSED",
    "data": {
      "upload_id": "<同 R1>", "candidate_id": "<同 R1>", "resume_id": "<同 R1>",
      "job_requisition_id": "<同 R1>",
      "parsed": { "data": { /* 补 4 个字段后的完整 parsed.data */ } },
      "source_channel": "raas_resume_info_repair",
      "enrichment_applied": { "retry_count": 1, "parent_audit_id": "<R1 audit_id>" }
    }
  }'

# 4. 在 AO 这边查最新 audit,看 missing_fields 是否消失 / 减少
curl http://<AO_LAN_IP>:3002/api/rule-check-audits?candidate_id=<id> | jq '.rows[0]'
# 看 R2 audit 的 audit_id,然后:
curl http://<AO_LAN_IP>:3002/api/rule-check-audits/<R2_audit_id> | jq '.detail.flags'
```

---

## 9. 元数据 — 事件 catalog 注册

`lib/events-catalog.ts:128` 已有定义,对齐 partner ontology:

```typescript
{
  name: "RESUME_INFO_MISSING",
  stage: "resume",
  kind: "gate",
  desc: "解析发现关键核心字段缺失，无法满足匹配要求。",
}
```

partner ontology(`raas_v4/backend/packages/events/src/ontology-events.ts:45`):
```typescript
RESUME_INFO_MISSING: "RESUME_INFO_MISSING",
```

partner flow runtime 已配置触发(`raas_v4/backend/packages/domain/src/flow/flow-runtime.service.ts:13`):
```typescript
["RESUME_INFO_MISSING", "resume_info_repair", "Recruiter", "resume-ops", "high"]
```

→ **partner 这条流程已经 stub 在 ontology 里,只差 function 实现。本文 §6 是实现指南。**

---

## 10. 联调对齐清单(联调前 partner 确认)

- [ ] **Partner SDK 升级到 ≥3.54.0**(避免 CVE-2026-42047 被 Inngest server 拒同步,见 [memory: reference_inngest_opcode_mismatch.md](../../.claude/projects/-Users-yuhancheng-Desktop-agenticOperator/memory/reference_inngest_opcode_mismatch.md))
- [ ] **Partner Inngest serve URL 可从 AO 这边 reach**(目前 `192.168.1.105:3001/api/inngest`)
- [ ] **Partner `resume_info_repair` function 实现**(订阅 + 处理 + 重发)
- [ ] **字段映射 §4 跟 partner DB schema 对齐**(尤其 `conflict_of_interest` 这种结构化字段,记得加 `_summary` 字符串)
- [ ] **Retry 限次策略 §6.4** — partner 端实现重试计数 + 上限后转 HSM 人工

跑通后,可以在 [http://localhost:3002/rule-check](http://localhost:3002/rule-check) UI 看到 round 1 → round 2 → round N 的 audit 链(通过 `audit_id` / `parent_audit_id` 串)。

---

## 11. 附:本次实测 audit_id 对照表(给 partner 调试参考)

| Round | event_id | audit_id | RESUME_INFO_MISSING missing_fields |
|---|---|---|---|
| R1 (原始) | `01KRDTF74P2T72YK5CMZG56VYH` | `rca_01KRDTF74P2T72YK5CMZG56VYH_1omrdxe_0bc0y1d` | `["利益冲突声明", "性别"]` |
| R2 (enriched) | `01KRDTHJSFY72569EQAB2ZTM4M` | `rca_01KRDTHJSFY72569EQAB2ZTM4M_1omrdxe_0bc0y1d` | `["利益冲突声明数据"]` ← 性别已补齐 |

→ 数据存活在 AO 本地 Neo4j(`bolt://localhost:7688`),partner 那边可以让我跑 query 反查具体字段。

---

## 12. 关于 Neo4j 连接(answer:**不是**陈洋 Allmeta)

> 用户问:"我们现在调用 Neo4j,是通过陈洋的 allmetaOntology 的链接方式吗?"

**当前 AO 用 2 个 Neo4j,角色不同**:

| Env | URI | 角色 | 用途 |
|---|---|---|---|
| `NEO4J_INSTANCE_URI` | `bolt://localhost:7688` | **本地实例图(优先)** | rule-check 拉 `:Rule`(248 条) + 写 audit/flag/candidate/resume/JR 节点 |
| `RAAS_LINKS_NEO4J_URI` | `neo4j://10.100.0.70:7687` | **陈洋 / Allmeta Ontology(fallback + EM sync)** | EM Event Definition sync(拉 `:Event` schema)+ rule-check 的 fallback 路径 |

→ **rule-check 当前用本地 Neo4j 拉规则**(从 ontology JSON snapshot 灌入的拷贝)。陈洋的 Allmeta(10.100.0.70:7687)只用于 EM sync。

**长期切换计划**:等陈洋在 Allmeta 上给每条 `:Rule` 节点加显式 `gating_severity` 字段(目前 AO 用文本启发式推断,见 [lib/rule-check/ontology-source.ts:125](../lib/rule-check/ontology-source.ts#L125))后,rule-check 切到 Allmeta 直查,本地拷贝退役。

partner 那边的 Inngest function 如果需要查规则定义,跟陈洋的 Allmeta 对接,**不要查 AO 本地 7688**(那是 AO 的工作数据)。
