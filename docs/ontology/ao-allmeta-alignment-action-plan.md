# AO ↔ Allmeta DataObject 对齐操作手册

> # ★★★ v0_1_010 终稿(2026-05-14 21:15 敲定)★★★
>
> **本节是阅读全文的入口** — 经过 4 轮决策探索后,5 个 DataObject 的最终 schema **以 [docs/data/objects_v0_1_010.json](../data/objects_v0_1_010.json) 为单一真相源(SSoT)**。下文 §3 旧的"选项 A / 选项 B / 推荐 ★" 讨论是**决策过程**的留档,不再是规范 — 每个 §3.x 末尾新加的 **"v0_1_010 终稿"** 子节才是 final spec。
>
> ## 关键收敛(跟早期讨论的差异)
>
> | DataObject | 早期方案(§3.x 主体)| **v0_1_010 终稿** |
> |---|---|---|
> | Candidate | 提案改 28→32 字段,加 linkedin/portfolio/summary/current_company/current_title 等 | **31 字段**:仅加 `github` / `ethnicity` / `native_place`;`mobile→phone` / `current_location→address`(跟 vendor);**不加** linkedin / portfolio / summary / current_company / current_title |
> | Candidate_Expectation | 提案拆 List<String> + 拆 salary min/max | **11 字段**:复数命名(`expected_positions / _locations / _industries`)**但类型仍是 String**(不拆 List);salary 不拆 |
> | Resume | 提案 21→26 字段,加 upload_id / current_company / current_title / additional_sections_json | **24 字段**:全部跟 RoboHire vendor 顶级字段名对齐(`experience / projects / education / languages / skills / certifications / portfolio / publications / patents / awards / summary`);**不加** upload_id / current_company / current_title |
> | Job_Requisition | 提案改名 5 处 + 拆 salary + city→List | **39 字段,完全未改** — 所有改名 / 改类型 / 拆字段提案被否决 |
> | Candidate_Match_Result | 提案 6→40 字段(含 disqualified / has_credibility_red_flags / 复合可信度 26 字段)| **8 字段**:仅加 4 个核心结论 `overall_match_score / overall_fit_verdict / overall_fit_summary / overall_match_grade`;**所有复合可信度信号 / rule-check 审计 / match_breakdown_json 都不进 MR**(留 AO Prisma SQLite + RAAS) |
>
> ## 总改动收敛
>
> | 维度 | 早期估算 | **v0_1_010 终稿** | 收敛幅度 |
> |---|---|---|---|
> | Allmeta 改名 | 15 处 | **3 处**(experience_years/marital_fertility_status/conflict_interest_declaration on Candidate) | -80% |
> | Allmeta 改类型 | 2 处 | **0 处** | -100% |
> | Allmeta 拆字段 | 2 处 | **0 处** | -100% |
> | Allmeta 加字段 | 46 字段 | **13 字段**(Candidate 3 / Expectation 1 / Resume 5 / MR 4) | -72% |
> | **总动作** | **65 处** | **16 处** | **-75%** |
>
> ## 设计哲学转向
>
> - **★ Allmeta DataObject 跟 RoboHire vendor 字段名对齐**(experience / projects / education / phone / address 等),不再让 vendor 跟 Allmeta — partner 跨服务排查 bug 时 Allmeta 节点字段名跟 RoboHire 响应一一对应,更直观。
> - **★ MR 节点极简化** — 只存"匹配结论"4 字段;详细可信度信号 / rule-check 审计 / 大块 breakdown 留 **AO Prisma SQLite**(已有 RuleCheckAudit 表)+ RAAS 私有 DB,**不进 Neo4j ontology**。
> - **★ List 类型尽量不用** — 多值字段(positions / locations / industries / salary_range)统一用 String + 分隔符,partner UI 用字符串 contains 查询(比 List<String> 跨实体筛选简单)。
> - **★ JR 完全保持不变** — JR 是 RAAS 写入,改 ontology 等于让 partner 改 mapper,代价大于收益;新接入的 partner 跟齐现有命名。
>
> 下面 §3.x 每节末尾的"v0_1_010 终稿"子节是 AO mapper + Allmeta validation 的**唯一参考**。早期 §3.x 主体内容可用来理解"为什么这么决定"。

---

> **目的**:把 Agentic Operator(AO)实例数据写入 Allmeta Ontology(再落 Neo4j)这条链路打通。当前由于 AO 端字段名 / 类型 / 位置和 Allmeta DataObject 声明不一致,**Allmeta 默认开启的 property-name validation 会用 `400 validation-failed` 把整个 POST 拒掉**,链路完全跑不通。本文给出每个字段的对齐方案、双向选项、推荐改动方,并给 Allmeta 端(陈洋)和 AO 端(Steven)各一份操作清单。
>
> **更新(2026-05-14)**:基于 RoboHire `POST /parse-resume` **实际响应样本**(秦嘉阔)重新锚定字段对齐。`current_company` / `current_title` 从 Candidate 迁到 Resume(原因见 §3.1 / §3.3)+ 新增 6 个 RoboHire 顶级字段处理(linkedin/github/portfolio/summary/otherSections-派生 ethnicity/native_place)。
>
> **依赖文档**:
> - 流程对照:[docs/ao-runtime-vs-allmeta-alignment-v2.md](./ao-runtime-vs-allmeta-alignment-v2.md)
> - 字段速查表:[docs/ao-allmeta-field-alignment-table.md](./ao-allmeta-field-alignment-table.md)
> - Allmeta API 契约:`/Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`

---

## 0. ★ RoboHire 响应锚定(事实标准,字段对齐的源头)

> 任何对齐讨论都要以 **RoboHire `POST /parse-resume` 实际返回的字段名 / 类型 / 嵌套结构**为锚 — vendor schema 我们改不了,只能让下游 Allmeta DataObject 去贴合。
>
> **调用路径**(回顾 §1.1):AO **不直接调** RoboHire,走 RAAS API Server `POST /api/v1/parse-resume` 透传 — 但 RAAS 是 transparent proxy,响应体 1:1 是 RoboHire 原文,所以下方 schema 就是 AO 看到的真实 schema。
>
> 下面是 2026-05 真实采样(候选人:秦嘉阔):

```json
{
  "success": true,
  "data": {
    // ─── 顶级标量(候选人身份 / 联系方式 / 画像)── 全部归 Candidate ──
    "name": "秦嘉阔",
    "email": "2282515772@qq.com",
    "phone": "17839688051",           // → Allmeta mobile(AO mapper 改名)
    "address": "北京顺义",             // → Allmeta current_location(AO mapper 改名)
    "linkedin": "", "github": "", "portfolio": "",   // → 3 个 Allmeta 待加字段
    "summary": "本人工作认真负责...",  // → Allmeta 待加 Candidate.summary

    // ─── 嵌套 object: skills(6 子分类)── 拍平后归 Resume.skill_tags ──
    "skills": {
      "technical": ["Excel", "PPT", ...],
      "soft": ["数据分析能力", ...],
      "languages": [],
      "tools": [...], "frameworks": [], "other": []
    },

    // ─── 数组: experience(已按时间倒序)── 归 Resume,首元素派生 current_* ──
    "experience": [
      { "company": "北京翼飞文化传媒", "role": "商务 bd",         // ★ [0] = 最新
        "startDate": "2025.02", "endDate": "2025.12", ...},
      { "company": "北京京惠科技", "role": "商务 bd",
        "startDate": "2024.06", "endDate": "2025.01", ...}
    ],

    "education": [...],          // → Resume.education_history (序列化 String)
    "projects": [],              // → Resume.project_history
    "certifications": [{ "name": "平面设计师证书", ... }],   // → Resume.certificate (JSON String)
    "languages": [{ "language": "普通话", "proficiency": "持有普通话等级证书"}],  // → Resume.language_skills
    "awards": [], "volunteerWork": [], "publications": [], "patents": [],   // → Resume.additional_sections_json (合并)

    // ─── ★ 散装中文 key 字段:otherSections ─── 需要解析后路由到多个 DataObject ───
    "otherSections": {
      "个人信息补充": "民族:汉族;生日:2002-10-10;籍贯:河南省驻马店市",
                     // → 拆 ";" + ":" → Candidate { ethnicity, birth_date, native_place }
      "求职意向": "商务 bd",          // → Candidate_Expectation.expected_position
      "期望薪资": "6k-8k",           // → Candidate_Expectation.expected_salary_range
      "skillsRaw": "熟练使用 Excel PPT PS..."
                     // → Resume.highlight_keywords(或丢弃)
    },

    // ─── vendor 元数据(不进 ontology)──
    "rawText": "...",
    "cached": false,
    "documentId": "resume_xxx",
    "savedAs": "...",
    "requestId": "req_xxx"
  }
}
```

### 关键发现(决定 §3 对齐方案)

| RoboHire 模式 | 含义 | 对齐影响 |
|---|---|---|
| **顶级标量 8 个**(name/email/phone/address/linkedin/github/portfolio/summary)| 候选人身份 + 画像 | 归 `:Candidate`,但 4 个是 Allmeta 当前没的(linkedin/github/portfolio/summary)→ **Allmeta 加 4 字段** |
| **嵌套 object: `skills`** | 6 类技能 | Neo4j 不支持 nested,**AO mapper 扁平化**写 `Resume.skill_tags: List<String>` |
| **数组按时间倒序: `experience[]`** | `[0]` = 最新工作 | **Resume 加 2 字段** `current_company` / `current_title`(派生自 [0])— Resume 而非 Candidate(见 §3.3 注释)|
| **散装中文 keys: `otherSections`** | 民族/生日/籍贯/求职意向/期望薪资 等混塞 | **AO mapper 解析后路由**到 Candidate(派生 ethnicity/native_place)+ Candidate_Expectation(expected_position/salary)|
| **vendor 元数据**(rawText/cached/documentId/savedAs/requestId)| RoboHire 内部 | 不进 ontology,AO mapper 丢弃 |

### 字段流向总图(参考用)

```
RoboHire response.data
   │
   ├── 顶级标量 ──────────────►  :Candidate    (8 个,部分需改名 / 部分待 Allmeta 加)
   │
   ├── skills 嵌套 object  ───►  :Resume.skill_tags (扁平化为 List<String>)
   │
   ├── experience[]  ───────►   :Resume.work_history (序列化 String)
   │                            :Resume.current_company / current_title (派生自 [0])
   │
   ├── education[]   ───────►   :Resume.education_history
   │                            :Candidate.highest_acquired_degree (派生)
   │
   ├── projects/certifications/  ─► :Resume.{project_history/certificate/language_skills}
   │   languages
   │
   ├── awards/volunteerWork/   ──► :Resume.additional_sections_json (合并为 JSON String)
   │   publications/patents
   │
   ├── otherSections.个人信息补充 ─► (parse) → :Candidate {ethnicity, birth_date, native_place, gender, current_location}
   │
   ├── otherSections.{求职意向,    ─► :Candidate_Expectation
   │                  期望薪资}
   │
   └── rawText/cached/documentId  ─► ❌ 丢弃(vendor 元数据)
       /savedAs/requestId
```

下面 §3 各 DataObject 的对齐方案,都以这张图为依据。

---

## 1. 链路全景与失败现场

### 1.1 4 个独立服务的职责(再清晰一遍)

**关键事实**:这条链路涉及 **4 个独立服务 + 1 个共享存储 + 1 个 vendor**,**不是 2 个或 3 个**。各自职责说清楚:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ① AO (Agentic Operator) — 中枢编排                                            │
│  ─────────────────────────                                                    │
│  - AO-main (:3002)         control plane(UI + EM gateway + RAAS bridge)      │
│                            ★ functions = [] · 不跑 Inngest agent              │
│  - resume-parser-agent     Inngest 3 个 agent(createJD / parser / match)    │
│    (:3020,子项目)                                                            │
│  - scripts/rule-check-poc  rule-check 5-agent pipeline(POC,未集成)          │
│  - 私有存储:Prisma SQLite                                                    │
│    · RuleCheckAudit / RuleCheckFlag(LLM 推理审计,AO 私有)                    │
│  - 调外部:RAAS API + Allmeta API                                             │
│  - ★ 不直接调 RoboHire(走 RAAS proxy,ADR-0011)                              │
└──────────────────────────────────────────────────────────────────────────────┘
                       │ HTTP                              │ HTTP
            ┌──────────┘                                    └──────────┐
            ▼                                                          ▼
┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
│  ② RAAS Platform                      │    │  ③ Allmeta Ontology @ :3500           │
│  ────────────────                     │    │  ─────────────────────────            │
│  ② a. API Server (:3001)              │    │  - studio app(:3500 主 API)           │
│     - HTTP gateway                    │    │  - 唯一通向 Neo4j 实例数据的入口        │
│     - 代理 4 个 RoboHire 端点(必要)   │    │  - 提供:                               │
│       · /parse-resume                 │    │     · DataObject schema 定义(GET/POST)│
│       · /match-resume                 │    │     · instance CRUD(POST/GET/PATCH)   │
│       · /generate-jd                  │    │     · Links(关系)                     │
│       · /requirements/*               │    │     · matchResume/results 特化端点    │
│     - 持久化 partner workflow state    │    │  - 默认开启 property-name validation │
│       (legacy,可能去掉)              │    │    (这是本文 §1.2 的失败点)           │
│       · /candidates                   │    │  - ★ 自己不存数据,只是 Neo4j 网关     │
│       · /jd/sync-generated            │    │                                      │
│       · /match-results                │    │  - other builders :3501-:3510         │
│     - HITL 事件 ingest                │    │    (objects/rules/actions builder)   │
│       · /events/ingest                │    │    跟 AO 无关,可以不跑                │
│                                      │    └─────────────────┬────────────────────┘
│  ② b. RAAS Inngest (:8288)            │                      │
│     - 共享 event bus                  │                      │ writes
│     - AO + RAAS 都 consume / emit    │                      │
│                                      │                      ▼
│  ② c. RAAS Dashboard                  │    ┌─────────────────────────────────────┐
│     - 工作台 UI                       │    │  Neo4j(bolt://localhost:7688)       │
│     - ★ 自己不存 candidate/resume/jr │    │  ─────────────────────────────────  │
│       从 Neo4j(经 Allmeta API)读     │    │  - 共享实例图(经 Allmeta 写,所有人读)│
│       显示工作台                      │    │  - 4 类业务实例 + ontology schema    │
│     - 内部存 hitl_task / event_outbox │    │    · :Candidate(经 Allmeta 写)      │
│       (partner workflow 私有状态)     │    │    · :Resume                         │
└──────────────┬───────────────────────┘    │    · :Job_Requisition                │
               │ proxies                    │    · :Candidate_Match_Result          │
               ▼                            │    · :Action / :Rule / :Event /       │
┌─────────────────────────────────────┐     │      :DataObject(schema 节点)        │
│  ④ RoboHire (vendor)                 │     │                                     │
│  https://api.robohire.io             │     └─────────────────────────────────────┘
│  ─────────────                       │
│  - /parse-resume(简历解析)            │
│  - /match-resume(打分)                │
│  - /generate-jd                      │
│  - ★ AO 不直接调,只能经 RAAS proxy   │
│  - 字段 schema 见 §0                  │
└─────────────────────────────────────┘
```

### 1.1.1 数据归属总表

| 数据 | 真源(写入入口) | 读法 | 备注 |
|---|---|---|---|
| Candidate / Resume / Job_Requisition / Candidate_Match_Result | **Allmeta API**(`POST /instances/{label}`)| Allmeta API 或 Neo4j Cypher | ★ Neo4j 是唯一真源 |
| `:Action / :Rule / :Event / :DataObject`(ontology schema) | Allmeta studio UI 编辑 | Allmeta API | 由陈洋维护 |
| MinIO 简历 PDF 文件 | RAAS 上传 | AO `GET /api/v1/resumes/uploads/:id/raw` | 文件 ID = `upload_id` |
| RoboHire 解析 / 评分原始结果 | RoboHire 返回 → RAAS DB 留底 → AO 加工后写 Allmeta | 一般不直读 RAAS DB,以 Neo4j 派生为准 | RAAS DB 是 legacy |
| `hitl_task` / `event_outbox`(partner 工作台状态)| RAAS API Server 内部 | RAAS Dashboard | partner 私有,AO 不读 |
| `RuleCheckAudit` / `RuleCheckFlag`(LLM 推理审计)| AO Prisma SQLite | AO drawer UI / API | AO 私有,partner 不读 |

### 1.1.2 数据流(以简历进系统为例)

```
HR 上传简历(PDF)
       │
       ▼ RAAS dashboard 触发上传
   [RAAS API ②a] 接收文件 → 存 MinIO → emit RESUME_DOWNLOADED
       │
       ▼ RAAS Inngest ②b
   RESUME_DOWNLOADED 事件
       │
       ▼ 共享 Inngest 投递到 AO
   ┌────────────────────────────────────────────────────────────────────┐
   │  AO resume-parser-agent (:3020) ① resumeParserAgent                │
   │                                                                     │
   │  Step 1.  GET /api/v1/resumes/uploads/{id}/raw                      │
   │           ──────► [RAAS API ②a]  → 返回 PDF 字节                    │
   │                                                                     │
   │  Step 2.  POST /api/v1/parse-resume  (multipart)                    │
   │           ──────► [RAAS API ②a]                                     │
   │                       │  RAAS 内部 proxy 调                          │
   │                       └──► [RoboHire ④]  /parse-resume              │
   │                            ←── 返回解析 JSON(见 §0)                 │
   │                       │                                              │
   │                       ★ RAAS 同时可能在自己 DB 留底(实现细节)        │
   │           ←──────  返回解析 JSON 给 AO                                │
   │                                                                     │
   │  Step 3.  AO mapper:RoboHire shape → Allmeta-ontology shape         │
   │           (这是本文 §3 / §4 的核心内容)                              │
   │                                                                     │
   │  Step 4.  POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1  │
   │           POST /api/v1/ontology/instances/Resume?domain=RAAS-v1     │
   │           POST /api/v1/ontology/instances/Candidate_Expectation     │
   │           POST /api/v1/ontology/links                                │
   │           ──────► [Allmeta ③]                                       │
   │                       │                                              │
   │                       │  Allmeta property-name validation           │
   │                       │  (本文 §1.2 失败点)                           │
   │                       │                                              │
   │                       ▼  validation 通过后                          │
   │                   [Neo4j]  MERGE (:Candidate {domainId: 'RAAS-v1'}) │
   │                                                                     │
   │  Step 5.  emit RESUME_PROCESSED → 共享 Inngest                       │
   └────────────────────────────────────────────────────────────────────┘
       │
       ▼ 触发 matchResumeAgent(同 :3020),走类似 Step 1-5 链路:
   matchResumeAgent → RAAS API /match-resume(代理 RoboHire 打分)
                    → AO 内部 rule-check(POC 5-agent pipeline)
                    → Allmeta POST /actions/matchResume/results
                    → emit MATCH_*
```

### 1.1.3 关键澄清(防误解)

- **AO 不直接调 RoboHire**。所有 RoboHire 调用全经 RAAS API Server `/api/v1/parse-resume` 等 4 个端点透传(ADR-0011 跨服务边界约束)。AO 端 `lib/robohire.ts` 存在但不被使用。
- **RAAS Dashboard 不存 candidate/resume/jr 实例数据**。Dashboard 是 UI 层,从 Neo4j(经 Allmeta API)读出来显示。partner 仪表盘看到的"候选人列表" / "JD 列表" / "匹配结果"都来源于 Neo4j。
- **RAAS API Server 内部 DB(肯定存在的部分)**:`hitl_task / event_outbox / outbound dispatcher state` 等 partner 工作流私有状态。AO 不直接访问这部分。
- **RAAS API Server 内部 DB(legacy 部分,将来去掉)**:`/candidates / /jd/sync-generated / /match-results` 这 3 个端点写的内容。**目的曾经是给 partner 看,但有了 Neo4j 实例图后这部分就是冗余**。短期 AO 双写(写一份给 RAAS legacy DB + 写一份给 Allmeta),长期可能完全切到 Allmeta。
- **`scripts/rule-check-poc` 当前不在生产链路上**。matchResumeAgent 还没集成 rule-check,直接调 RAAS `/match-resume`。POC 是 standalone 验证用,roadmap 上会集成回去。

### 1.2 当前阻塞点 — Allmeta validation 默认行为

**[Allmeta API guide §5 Validation](file:///Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md):**

> Property-name validation runs on every write — **default mode included**.
> A POST/PUT/PATCH body containing a key that isn't in `properties[]` (or
> the PK or `domainId`) is rejected with `400 validation-failed` and
> `details.unknown: [<field-names>]`. This is true whether or not
> `?validate=strict` is set.

**翻译成大白话**:不需要 `?validate=strict`,默认就会拒绝任何 `properties[]` 里没声明的字段。AO 当前如果直接拿 `CandidateNested` 整段 POST,会被 4xx 拒绝 — 链路上线前必须先对齐字段名。

### 1.3 各 DataObject 写入会失败的字段(预测的 400 错)

如果今天 AO 直接 `POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1` 把 `CandidateNested` 整段发过去,Allmeta 会返回:

```json
{
  "error": "validation-failed",
  "details": {
    "unknown": ["work_years", "current_company", "current_title", "skills"]
  }
}
```

5 个 DataObject 的"必死字段"清单:

| DataObject | AO 会发的字段 | Allmeta `properties[]` 没有 | 预测 400 拒绝 |
|---|---|---|---|
| Candidate | `work_years` `current_company` `current_title` `skills` | 全部缺 | 4 字段 |
| Candidate_Expectation | `expected_salary_monthly_min/max` `expected_cities` `expected_industries` `expected_roles` `expected_work_mode` | 全部命名不一致 | 6 字段 |
| Resume | `skills_extracted` `work_history` `education_history` `project_history` `summary` `upload_id` | 改名 + 缺字段 | 6 字段 |
| Job_Requisition | (基本对齐,但若用 RAAS 64 字段直发,会被拒 ~30 字段)| | 30 字段 |
| Candidate_Match_Result | 全部 23+ RoboHire camelCase 字段 + 8 rule-check 字段 | 几乎全缺(L3 只有 6 字段)| 31 字段 |

**总计 ~77 字段**会触发拒绝。

### 1.4 分析框架确认 — 这是一个二元选择题

**前提**:RoboHire / RAAS 是上游 vendor,字段名 / 类型 / 结构由 vendor 决定,**我们改不了源头**。所以对齐的"调节杆"只有两个:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   RoboHire vendor (L1)         AO mapper layer (L2)             │
│   ──────────────────  ──────►  ────────────────                 │
│   matchScore: 0.82             match_score: 0.82                │
│   recommendation:              recommendation:                   │
│     "GOOD_MATCH"                 "GOOD_MATCH"                   │
│   (改不了)                       │                              │
│                                  │  ★ 调节杆 1:改 AO mapper      │
│                                  │  (改字段名/类型/位置)         │
│                                  ▼                              │
│                          Allmeta DataObject (L3)                │
│                          ──────────────────────                 │
│                          properties[]: [match_score, ...]       │
│                          ★ 调节杆 2:改 properties_json          │
│                          (改字段名/类型 + 加/删字段)             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**两个调节杆,每个字段差异必须选一个动**:

| 选项 | 操作位置 | 改动文件 | 影响范围 |
|---|---|---|---|
| A | 改 AO payload schema(L2)| `resume-parser-agent/lib/mappers/ao-to-allmeta.ts` (新建)+ `lib/inngest/client.ts` 类型定义 | 仅 AO 内部 |
| B | 改 Allmeta DataObject(L3)| Allmeta `properties_json`(陈洋的 ontology 仓)| 所有 Allmeta consumer(AO + partner 仪表盘 + hsm UI + 未来接入的 agent)|

**vendor 字段不能改 ≠ AO mapper 不能改**。AO mapper 本身就是 L1→L2 的翻译层,可以做改名 / 序列化 / 拆分 / 合并 / 丢弃 — vendor 给什么,mapper 都能加工。所以**实际选择是"AO mapper 翻译" vs "Allmeta ontology 跟齐"**。

**何时选 A、何时选 B**(展开见 §2 决策原则):
- vendor 命名行业通用 + Allmeta 命名是自造 → ★ B(让 ontology 跟 vendor)
- vendor 命名差 / 数据结构 vendor 决定不合理 → ★ A(AO mapper 净化)
- AO 自创字段(rule-check audit 等)→ 业务必要的 ★ B(Allmeta 加),低价值的 ★ A(AO 丢弃)
- 同一字段两边都有但语义略不同 → 两边都明确化(加新字段而不是改名)

---

## 2. 对齐决策原则(读下面的表前先读这个)

### 2.1 五条铁律

| # | 原则 | 应用 |
|---|---|---|
| 1 | **Vendor 源头字段名 → Allmeta 跟齐** | RoboHire / RAAS 返回的字段名是 vendor 决定的,AO 改不了源头。如果 vendor 命名行业通用、Allmeta 命名是自造,优先 ★ Allmeta 改 |
| 2 | **AO 自创字段名 → Ontology 主导** | AO 业务自定义的字段名(如 rule-check 审计)如果 ontology 想要别的,★ AO 改 mapper |
| 3 | **类型分歧 → 用更结构化的那个** | String 装 List 一律 ★ Allmeta 改 List;String 装数值一律 ★ Allmeta 拆 min/max Float — 数值/列表才能筛选排序 |
| 4 | **位置分歧 → 跟 ontology 设计** | 同一份数据 AO 放 Candidate / Allmeta 放 Resume,以 ontology 设计为准(因为 ontology 是经过实体建模的)→ ★ AO 改 mapper 写到对的位置 |
| 5 | **缺字段 → 评估去留再决定** | Allmeta 没字段:看是不是核心业务数据,核心 ★ Allmeta 加字段;低用率/vendor 内部 ★ AO 丢弃 |

### 2.2 谁该改的判断流程图

```
┌──────────────────────────────────┐
│  AO 端这个字段从哪来?            │
└────────┬─────────────────────────┘
         │
    ┌────┴────────────────────────┐
    │                             │
    ▼                             ▼
[Vendor 源头]                [AO 自创业务字段]
(RoboHire / RAAS)            (rule-check audit / final_decision)
    │                             │
    ▼                             ▼
比 Allmeta 命名好?           Allmeta 有同语义字段?
    │                             │
   ┌┴┐                           ┌┴┐
   是 否                         是 否
   │  │                          │  │
   ▼  ▼                          ▼  ▼
★ All ★ AO mapping            ★ AO ★ Allmeta 加字段
metaOK 接受 vendor 命名       改名  (评估业务必要性)
改名
```

### 2.3 不该做的事

- ❌ 不要为了"AO 改最少"就把所有事推 Allmeta — ontology 是经过设计的,有些选择(skills 放 Resume 而不是 Candidate)是对的,AO 应该跟。
- ❌ 不要为了"Allmeta 不动"就让 AO 把 8 个数据序列化成 1 个大 JSON — 失去结构化检索能力,partner 仪表盘做不出筛选。
- ❌ 不要在 AO 端做"双写"(同时按 vendor 名和 ontology 名各写一份)— 维护成本高,而且 Allmeta strict 会拒绝多余字段。
- ❌ 不要把 vendor 的内部 metadata 字段(RoboHire `documentId / cached / savedAs`)当 ontology 字段加 — 这是 vendor 实现细节,不属于业务实体。

---

## 3. 逐 DataObject 详细对齐方案

### 3.0 写入路径速查(每个 DataObject 都在这条路径上)

下面 5 个 DataObject 在 4 组件链路上的路径不完全一样,别混:

| DataObject | 原始数据来源 | AO 怎么拿到 | AO 写到哪里 | 备注 |
|---|---|---|---|---|
| Candidate | RoboHire `parse-resume` 顶级 + `otherSections` 派生 | **AO ← RAAS proxy ← RoboHire** | **AO → Allmeta** | 不经 RAAS DB |
| Candidate_Expectation | RoboHire `otherSections.求职意向 / 期望薪资` 派生 | 同上 | **AO → Allmeta** | 同上 |
| Resume | RoboHire `experience[] / education[] / skills` 等数组 | 同上 | **AO → Allmeta** | 同上 |
| Job_Requisition | partner 系统(客户提供)| **AO ← RAAS API `/requirements/:id`**(RAAS 自有数据,**不经 RoboHire**)| **AO → Allmeta** | RAAS 同时存自己内部 DB(legacy)|
| Candidate_Match_Result | RoboHire `match-resume` 响应 + AO rule-check 自产 | **AO ← RAAS proxy ← RoboHire** + AO 本地 rule-check | **AO → Allmeta** | rule-check audit 详细数据留 AO Prisma SQLite |

★ **关键**:所有 5 个 DataObject **写入都是 AO 直连 Allmeta**,不经 RAAS。读取路径才有差异(JR 必经 RAAS;Candidate/Resume/MR 的原始数据经 RAAS proxy 拿 RoboHire 输出)。

---

### 3.1 Candidate

#### Schema 总览 — 现状 vs 对齐后

**(a) Allmeta DataObject 现状(28 字段,来自 [dataobjects_20260408.json:766](file:///Users/yuhancheng/allmetaOntology/apps/events-builder/data%20copy/dataobjects_20260408%20%281%29.json))**

```typescript
type AllmetaCandidate_NOW = {
  candidate_id: string;                    // PK
  employee_id: string;                     // FK→Employee
  is_locked: boolean;
  lock_start_time: timestamp;
  referrer_employee_id: string;            // FK→Employee
  id_number: string;
  name: string;
  nationality: string;
  gender: string;
  birth_date: date;
  mobile: string;
  email: string;
  current_location: string;
  highest_acquired_degree: string;
  unified_enrollment: boolean;
  experience_years: float;                 // ← 待改名
  flight_risk_level: string;
  max_salary_limit: float;
  status: string;
  state: string;
  blacklist_status: boolean;
  marital_fertility_status: string;        // ← 待改名
  conflict_interest_declaration: string;   // ← 待改名(漏 of)
  conflict_clearance_deadline: date;
  gap_reason: string;
  previous_level: string;
  expected_degree: string;
  expected_graduation_date: date;
  // ✗ current_company 缺
  // ✗ current_title 缺
};
```

**(b) AO Runtime payload 现状([CandidateNested](../../resume-parser-agent/lib/inngest/client.ts#L23),11 字段)**

```typescript
type CandidateNested_NOW = {
  name: string | null;
  mobile: string | null;
  email: string | null;
  gender: string | null;          // 永远 null(RoboHire 不返)
  birth_date: string | null;      // 永远 null
  current_location: string | null;
  highest_acquired_degree: string | null;
  work_years: number | null;      // ← Allmeta 叫 experience_years
  current_company: string | null; // ← Allmeta 没字段
  current_title: string | null;   // ← Allmeta 没字段
  skills: string[];               // ← Allmeta 没字段(在 Resume.skill_tags)
};
```

**直接 POST 会被拒的字段**:`work_years` / `current_company` / `current_title` / `skills`(4 字段)

**(c) 对齐后 Allmeta DataObject(28 → 32 字段)**

★ 修正(2026-05-14):`current_company` / `current_title` **不放 Candidate**,因为它们是 RoboHire `experience[0]` 的派生 — **每份简历提交是一次快照**,跟 `work_experience(序列化历史)`同源同生命周期。改放 `:Resume`(见 §3.3)。Candidate 端保留 `previous_level`(单调累积)和 `experience_years`(单调累积)这些"人状态"派生即可。

```diff
type AllmetaCandidate_ALIGNED = {
  candidate_id: string;                       // PK
  employee_id: string;                        // FK→Employee
  is_locked: boolean;
  lock_start_time: timestamp;
  referrer_employee_id: string;               // FK→Employee
  id_number: string;
  name: string;
  nationality: string;
  gender: string;
  birth_date: date;
  mobile: string;
  email: string;
  current_location: string;
  highest_acquired_degree: string;
  unified_enrollment: boolean;
- experience_years: float;
+ work_years: float;                          // 改名
  flight_risk_level: string;
  max_salary_limit: float;
  status: string;
  state: string;
  blacklist_status: boolean;
- marital_fertility_status: string;
+ family_status: string;                      // 改名
- conflict_interest_declaration: string;
+ conflict_of_interest_declaration: string;   // 改名(补 of)
  conflict_clearance_deadline: date;
  gap_reason: string;
  previous_level: string;                     // 保留 — 跟 current_title 不同语义(累积式职级 vs 当前职位)
  expected_degree: string;
  expected_graduation_date: date;

  // ★ 新增 4 字段(RoboHire 顶级直返,Allmeta 当前没)
+ linkedin: string;                           // 新增 — RoboHire.linkedin
+ github: string;                              // 新增 — RoboHire.github
+ portfolio: string;                           // 新增 — RoboHire.portfolio
+ summary: string;                             // 新增 — RoboHire.summary(候选人自我评价)

  // ★ 新增 2 字段(从 RoboHire.otherSections.个人信息补充 派生)
+ ethnicity: string;                           // 新增 — "民族:汉族" → "汉族"
+ native_place: string;                        // 新增 — "籍贯:河南省驻马店市" → "河南省驻马店市"

  // ✗ current_company 不放这(移到 :Resume,见 §3.3)
  // ✗ current_title   不放这(移到 :Resume,见 §3.3)
};
```

**(d) 对齐后 AO Runtime payload(11 → 12 字段,删 skills + current_company/current_title + 加 linkedin/github/portfolio/summary/ethnicity/native_place)**

```diff
type CandidateNested_ALIGNED = {
  name: string | null;
  mobile: string | null;
  email: string | null;
  gender: string | null;             // 从 otherSections.个人信息补充 派生(若有)
  birth_date: string | null;         // 从 otherSections.个人信息补充 派生(若有)
  current_location: string | null;   // 优先 otherSections.现居 > RoboHire.address
  highest_acquired_degree: string | null;
  work_years: number | null;         // 命名已对齐(Allmeta 改)

  // ★ 新增字段
+ linkedin: string | null;
+ github: string | null;
+ portfolio: string | null;
+ summary: string | null;
+ ethnicity: string | null;          // RoboHire 派生
+ native_place: string | null;       // RoboHire 派生

- current_company: string | null;    // 移到 ResumeNested
- current_title: string | null;      // 移到 ResumeNested
- skills: string[];                   // 删除 — 改写 Resume.skill_tags
};
// + RuntimeNested 整个删除(空壳,跟 candidate 重复)
```

#### A. 当前 AO 写入 payload(假设直接 spread `CandidateNested`)

```http
POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1
Content-Type: application/json
Authorization: Bearer ${AO_API_KEY}

{
  "domainId": "RAAS-v1",
  "candidate_id": "C-100023",       // AO 自己生成或 RAAS 回填
  "name": "张三",
  "mobile": "13800138000",
  "email": "zhangsan@example.com",
  "gender": null,
  "birth_date": null,
  "current_location": "深圳",
  "highest_acquired_degree": "本科",
  "work_years": 5.2,                // ❌ 拒
  "current_company": "字节跳动",     // ❌ 拒
  "current_title": "高级研发工程师",  // ❌ 拒
  "skills": ["Java", "MySQL"]        // ❌ 拒
}
```

**预测 Allmeta 响应**:
```json
{
  "error": "validation-failed",
  "details": { "unknown": ["work_years", "current_company", "current_title", "skills"] }
}
```

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `phone: string` | `mobile: String` | RoboHire.phone | **AO mapper 改名 phone→mobile** | Allmeta `mobile→phone` | **★ A (AO 改 mapping)** | 原则 ②:`mobile` 是 HR 行业通用名,Allmeta 命名好 |
| `address: string` | `current_location: String` | RoboHire.address | **AO mapper 改名 address→current_location** | Allmeta 改名 | **★ A (AO 改 mapping)** | 原则 ②:`current_location` 更准确(候选人可能多地址)|
| `work_years: number` | `experience_years: Float` | 都是自创(RoboHire 不返,AO 算)| AO mapper 改名 | Allmeta 改名 | **★ B (Allmeta 改 `experience_years → work_years`)** | 原则 ②:JR 已经叫 work_years,行业通用;Allmeta 内部都不一致,自己跟齐 |
| `linkedin: string` | (无)| RoboHire.linkedin 直返 | AO 不写 | Allmeta 加 | **★ B (Allmeta 加 `linkedin: String`)** | 原则 ①:简历常见字段,ontology 该有 |
| `github: string` | (无)| RoboHire.github 直返 | 同上 | Allmeta 加 | **★ B (Allmeta 加 `github: String`)** | 同上 |
| `portfolio: string` | (无)| RoboHire.portfolio 直返 | 同上 | Allmeta 加 | **★ B (Allmeta 加 `portfolio: String`)** | 同上 |
| `summary: string` | (无)| RoboHire.summary 直返 | 同上 | Allmeta 加 | **★ B (Allmeta 加 `summary: String`)** | 同上,简历摘要 — Greenhouse / 行业都有 |
| `ethnicity: string`(派生)| (无)| RoboHire.otherSections.个人信息补充 解析后派生 | AO 不写 | Allmeta 加 | **★ B (Allmeta 加 `ethnicity: String`)** | 国内 HR 场景常用字段;AO mapper 已经派生,Allmeta 该接住 |
| `native_place: string`(派生)| (无)| 同上 | 同上 | Allmeta 加 | **★ B (Allmeta 加 `native_place: String`)** | 同上(籍贯)|
| ~~`current_company: string`~~ | ~~(无)~~ | ~~RoboHire experience[0]~~ | ~~AO 不写~~ | ~~Allmeta 加~~ | **★ 移除 — 不放 Candidate**(改放 :Resume,见 §3.3 原因表) | 原则 ④:Resume 的字段语义,Candidate 上只放累积量 |
| ~~`current_title: string`~~ | ~~(无)~~ | 同上 | 同上 | 同上 | **★ 移除 — 不放 Candidate**(改放 :Resume) | 同上 |
| `skills: string[]` | (无,Allmeta 在 `Resume.skill_tags`)| RoboHire.skills 嵌套 | AO 不写 Candidate.skills,只写 Resume.skill_tags | Allmeta 加 Candidate.skill_tags 冗余字段 | **★ A (AO 改:Candidate 不写 skills)** | 原则 ④:ontology 设计正确(简历多版,技能跟简历走);AO 当前 mapper 重复挂 Candidate + Resume 是 bug |
| `gender: string`(可能从 otherSections 派生)| `gender: String` | RoboHire 顶级不返,但 otherSections.个人信息补充 可能有"性别:男" | AO mapper 解析 otherSections 派生 | — | ✅ A | 派生填,有就填,没就 null |
| `birth_date: string`(派生)| `birth_date: Date` | otherSections.个人信息补充 派生(例 "生日:2002-10-10")| AO mapper 解析派生 | — | ✅ A | 同上 |

#### C. 配套改动:删除 RuntimeNested 空壳

[`RuntimeNested`](../../resume-parser-agent/lib/inngest/client.ts#L65) 只装 `current_title / current_company` 两字段,和 `CandidateNested` 重复。当前 mapper 的 [robohire-to-raas.ts:152](../../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L152) 也是直接复制 candidate 的两个字段过去 — 这是历史 bug。

→ 删除 `RuntimeNested`,事件 payload 也删 `runtime` 字段。

---

#### ★ 3.1.X v0_1_010 终稿 — Candidate(31 字段)

**Allmeta DataObject(SSoT:[objects_v0_1_010.json:Candidate](../data/objects_v0_1_010.json))**

```typescript
type AllmetaCandidate_v0_1_010 = {
  candidate_id: string;                          // PK
  employee_id: string;                           // FK→Employee — 跟进招聘专员
  is_locked: boolean;
  lock_start_time: timestamp;
  referrer_employee_id: string;                  // FK→Employee
  id_number: string;
  name: string;
  nationality: string;
  gender: string;
  birth_date: date;
  phone: string;                                 // ★ 改名 mobile→phone(跟 RoboHire vendor)
  email: string;
  address: string;                               // ★ 改名 current_location→address(跟 RoboHire vendor)
  highest_acquired_degree: string;
  unified_enrollment: boolean;
  work_years: float;                             // ★ 改名 experience_years→work_years
  flight_risk_level: string;
  max_salary_limit: float;
  status: string;                                // 候选人活跃状态(在职/离职中/积极求职)
  state: string;                                 // pipeline 位置(已推客户/终面中)
  blacklist_status: boolean;
  marital_status: string;                        // ★ 改名 marital_fertility_status→marital_status
  conflict_of_interest_declaration: string;      // ★ 改名(补 of)
  conflict_clearance_deadline: date;
  gap_reason: string;
  previous_level: string;
  expected_degree: string;
  expected_graduation_date: date;
  github: string;                                // ★ 新增 — RoboHire.github 顶级直返
  ethnicity: string;                             // ★ 新增 — 派生 otherSections.个人信息补充"民族"
  native_place: string;                          // ★ 新增 — 派生 otherSections.个人信息补充"籍贯"
};
```

**AO Runtime payload(`CandidateNested` v0_1_010)**

```typescript
export type CandidateNested = {
  name: string | null;
  phone: string | null;                          // ★ 改名 mobile → phone
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  address: string | null;                        // ★ 改名 current_location → address
  highest_acquired_degree: string | null;
  work_years: number | null;
  github: string | null;                         // ★ 新增
  ethnicity: string | null;                      // ★ 新增(派生 otherSections)
  native_place: string | null;                   // ★ 新增(派生 otherSections)
  // ❌ 删除:current_company / current_title(放别处或不存)
  // ❌ 删除:skills(技能跟简历走,在 Resume.skills)
};
```

**未采纳的早期提案**:linkedin / portfolio(在 Resume) / summary(在 Resume) / current_company / current_title — 这 5 个字段决定**不进 Candidate**。

---

### 3.2 Candidate_Expectation

#### Schema 总览 — 现状 vs 对齐后

**(a) Allmeta DataObject 现状(9 字段)**

```typescript
type AllmetaCandidateExpectation_NOW = {
  candidate_expectation_id: string;        // PK
  candidate_id: string;                    // FK→Candidate
  expected_position: string;               // ← 单数 + String,应是 List
  expected_location: string;               // ← 单数 + String
  expected_salary_range: string;           // ← String 装数值,应拆 min/max Float
  outsourcing_acceptance_level: string;    // 中软外包专用,留 hsm 填
  expected_industry: string;               // ← 单数 + String
  expected_company_size: string;
  constraints: string[];                   // List<String> ✅
  updated_time: timestamp;
  // ✗ expected_work_mode 缺(remote/hybrid/onsite)
};
```

**(b) AO Runtime payload 现状([CandidateExpectationNested](../../resume-parser-agent/lib/inngest/client.ts#L37),6 字段)**

```typescript
type CandidateExpectationNested_NOW = {
  expected_salary_monthly_min: number | null;  // ← Allmeta 是 expected_salary_range String
  expected_salary_monthly_max: number | null;  // ← Allmeta 没拆
  expected_cities: string[];                   // ← Allmeta 是 expected_location 单数
  expected_industries: string[];               // ← Allmeta 是 expected_industry 单数
  expected_roles: string[];                    // ← Allmeta 是 expected_position
  expected_work_mode: string | null;           // ← Allmeta 没字段
};
```

> ⚠️ 当前 mapper 6 个字段全写死 null/[](RoboHire 没**顶级**解析期望),但 schema 形状先要对齐。
>
> ★ **2026-05-14 更新**:RoboHire 其实**有**期望相关字段 — 在 `otherSections` 散装中文 key 里:
>
> ```json
> "otherSections": {
>   "求职意向": "商务 bd",        // → expected_positions[0]
>   "期望薪资": "6k-8k"           // → expected_salary_range 或拆成 min/max
> }
> ```
>
> AO mapper 应该解析 `otherSections.求职意向` / `otherSections.期望薪资` 填入 `expected_positions` / `expected_salary_*` 字段,不再写死 null。

**直接 POST 会被拒的字段**:全部 6 个字段(命名 / 类型 / 缺失 — **0 字段能通过**)

**(c) 对齐后 Allmeta DataObject(9 → 12 字段)**

```diff
type AllmetaCandidateExpectation_ALIGNED = {
  candidate_expectation_id: string;
  candidate_id: string;
- expected_position: string;
+ expected_positions: string[];                // 改名 + 改类型
- expected_location: string;
+ expected_locations: string[];                // 改名 + 改类型
- expected_salary_range: string;
+ expected_salary_range: string;               // 保留兼容
+ expected_salary_monthly_min: float;          // 拆字段
+ expected_salary_monthly_max: float;          // 拆字段
+ salary_currency: string;                     // 拆字段
  outsourcing_acceptance_level: string;
- expected_industry: string;
+ expected_industries: string[];               // 改名 + 改类型
  expected_company_size: string;
  constraints: string[];
  updated_time: timestamp;
+ expected_work_mode: string;                  // 新增 (remote/hybrid/onsite)
};
```

**(d) 对齐后 AO Runtime payload(6 字段,改 1 个名)**

```diff
type CandidateExpectationNested_ALIGNED = {
  expected_salary_monthly_min: number | null;  // 命名已对齐(Allmeta 拆字段)
  expected_salary_monthly_max: number | null;
  expected_cities: string[];                   // 命名仍用 cities(写入时映射 expected_locations)
                                               // 或者 AO 也跟改成 expected_locations
  expected_industries: string[];
- expected_roles: string[];
+ expected_positions: string[];                // 改名(roles → positions)
  expected_work_mode: string | null;
};
```

> 💡 推荐 AO 端把 `expected_cities` 也改成 `expected_locations`,完全和 Allmeta 一致 — mapper 写入时就不用做 alias 翻译。

#### A. 当前 AO 写入 payload(全部 null/[],因为 RoboHire 不解析期望)

```json
{
  "domainId": "RAAS-v1",
  "candidate_expectation_id": "ce_C-100023",
  "candidate_id": "C-100023",
  "expected_salary_monthly_min": null,    // ❌ 拒(Allmeta 字段叫 expected_salary_range)
  "expected_salary_monthly_max": null,    // ❌ 拒
  "expected_cities": [],                  // ❌ 拒(Allmeta 叫 expected_location 单数 String)
  "expected_industries": [],              // ❌ 拒
  "expected_roles": [],                   // ❌ 拒
  "expected_work_mode": null              // ❌ 拒
}
```

**这个对象问题最大** — 6 个 AO 字段,**0 个能通过 validation**。

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `expected_salary_monthly_min: number` + `..._max: number` | `expected_salary_range: String`("15K-25K/月") | **派生自 RoboHire.otherSections.期望薪资**(例 "6k-8k")| AO mapper 解析字符串 + 拆 min/max | Allmeta 拆字段 | **★ B (Allmeta 拆 `expected_salary_monthly_min / max: Float` + `salary_currency: String`)** + AO mapper 解析"6k-8k"模板填两数 | 原则 ③:数值才能筛选排序("我要 15K 以上"用 String 实现不了)。可同时保留 `expected_salary_range` 原 String 供 UI 直接展示 |
| `expected_cities: string[]` | `expected_location: String` | 暂无(RoboHire 顶级不输出)| AO `.join(',')` | Allmeta 改 List + 复数 | **★ B (Allmeta 改 `expected_locations: List<String>`)** | 原则 ③:候选人多选地点是常态,String 单值是错误设计 |
| `expected_industries: string[]` | `expected_industry: String` | 暂无 | 同上 | 同上 | **★ B (Allmeta 改 `expected_industries: List<String>`)** | 同上 |
| `expected_roles: string[]` | `expected_position: String` | **派生自 RoboHire.otherSections.求职意向**(例 "商务 bd",可能多个用 `/` `、` 分隔)| AO 改名 + 拆分 join | Allmeta 改 List + 复数 | **★ 双改:AO `expected_roles → expected_positions` + Allmeta `expected_position → expected_positions: List<String>`** + mapper 按 `/、,` 分隔符拆 | 原则 ②:`position` 比 `role` 准(role 容易和 Standard_Job_Role 混) |
| `expected_work_mode: string` (remote/hybrid/onsite) | `outsourcing_acceptance_level: String` | **完全不同语义**(AO 指办公模式,Allmeta 指外包接受度) | AO 不发 outsourcing | Allmeta 加 `expected_work_mode` | **★ B (Allmeta 加 `expected_work_mode: String`)** | 原则 ⑤:`outsourcing_acceptance_level` 是中软外包业务字段,留给 hsm 填,AO 别动 |

#### C. AO mapper 当前问题

[robohire-to-raas.ts:128](../../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L128) 6 个字段全写死 null/[] — RoboHire prompt 里压根没要候选人期望。这一节短期内 AO 都是发空值,**对齐工作主要是把字段名/类型先对上**,等 RoboHire 加期望解析能力后这些字段才有真值。

---

#### ★ 3.2.X v0_1_010 终稿 — Candidate_Expectation(11 字段)

**Allmeta DataObject(SSoT:[objects_v0_1_010.json:Candidate_Expectation](../data/objects_v0_1_010.json))**

```typescript
type AllmetaCandidateExpectation_v0_1_010 = {
  candidate_expectation_id: string;              // PK
  candidate_id: string;                          // FK→Candidate
  expected_positions: string;                    // ★ 改名 expected_position → expected_positions
                                                  //   (字段名复数化,★ 类型仍 String,不拆 List —
                                                  //    多值用分隔符,例 "BD/商务/销售")
  expected_locations: string;                    // ★ 改名 expected_location → expected_locations(类型仍 String)
  expected_salary_range: string;                 // ★ 不拆 min/max — 保留 String,例 "6k-8k"
  outsourcing_acceptance_level: string;          // 中软外包接受度(留 hsm 填,AO 不动)
  expected_industries: string;                   // ★ 改名(类型仍 String)
  expected_company_size: string;
  constraints: List<String>;                     // 仅此字段保持 List<String>
  updated_time: timestamp;
  expected_work_mode: string;                    // ★ 新增 — remote/hybrid/onsite
};
```

**AO Runtime payload(`CandidateExpectationNested` v0_1_010)**

```typescript
export type CandidateExpectationNested = {
  expected_positions: string | null;             // ★ 改名 + 类型变 string(原 expected_roles: string[])
                                                  //   mapper 多值用 "/" 或 "、" join 成 String
  expected_locations: string | null;             // ★ 改名 + 类型变 string(原 expected_cities: string[])
  expected_industries: string | null;            // ★ 改名 + 类型变 string(原 expected_industries: string[])
  expected_salary_range: string | null;          // ★ 新增 — 直接存 "6k-8k" 字符串,不拆 min/max
  expected_work_mode: string | null;
  // ❌ 删除:expected_salary_monthly_min / expected_salary_monthly_max(改回 String)
};
```

**未采纳的早期提案**:salary 拆 min/max + currency / 类型改 List<String> / hsm 字段(outsourcing_acceptance_level)由 AO 写 — 全部否决。

---

### 3.3 Resume

#### Schema 总览 — 现状 vs 对齐后

**(a) Allmeta DataObject 现状(21 字段)**

```typescript
type AllmetaResume_NOW = {
  resume_id: string;                            // PK
  candidate_id: string;                         // FK→Candidate
  job_requisition_id: string[];                 // FK→Job_Requisition
  sourcing_channel_id: string;                  // FK→Sourcing_Channel
  work_experience: string;                      // ← 改名 → work_history
  project_experience: string;                   // ← 改名 → project_history
  education_experience: string;                 // ← 改名 → education_history
  language_skills: string;
  file_path: string;                            // MinIO 路径
  is_original: boolean;
  skill_tags: string[];
  skill_ranking: string;
  highlight_keywords: string;
  recommendation_reason: string;
  project_description_validity: string;
  certificate: string;
  portfolio_attachment: string;
  language: string;
  employee_id: string;                          // FK→Employee
  created_time: timestamp;
  updated_time: timestamp;
  // ✗ summary 缺
  // ✗ upload_id 缺(MinIO 上传主键,跟 file_path 语义不同)
};
```

**(b) AO Runtime payload 现状([ResumeNested](../../resume-parser-agent/lib/inngest/client.ts#L46),5 字段 + 上传层 6 字段)**

```typescript
type ResumeNested_NOW = {
  summary: string | null;                       // ← Allmeta 没字段
  skills_extracted: string[];                   // ← Allmeta 是 skill_tags
  work_history: Array<{title, company, startDate, endDate, description}>; // ← Allmeta 叫 work_experience String
  education_history: Array<{degree, field, institution, graduationYear}>; // ← 同上
  project_history: unknown[] | null;            // ← 同上
};
// + 上传层(SaveCandidateInput 平铺):
//   upload_id, bucket, object_key, etag, mime_type, file_size, original_filename
```

**直接 POST 会被拒的字段**:`summary` / `skills_extracted` / `work_history` / `education_history` / `project_history` / `upload_id`(6 字段)

**(c) 对齐后 Allmeta DataObject(21 → 26 字段)**

★ 修正(2026-05-14):新增 4 字段(`current_company / current_title / additional_sections_json / upload_id`)— 跟 `:Candidate` 上的"单调累积"派生(`highest_acquired_degree / experience_years`)区分开 — `current_*` 是**每份简历的快照**,该字段值跟着 Resume 节点走,候选人换工作时**老 Resume 的快照保留不动**。

```diff
type AllmetaResume_ALIGNED = {
  resume_id: string;
  candidate_id: string;
  job_requisition_id: string[];
  sourcing_channel_id: string;
- work_experience: string;
+ work_history: string;                         // 改名(类型仍 String,Neo4j 不擅长嵌套)
- project_experience: string;
+ project_history: string;                      // 改名
- education_experience: string;
+ education_history: string;                    // 改名
  language_skills: string;
  file_path: string;
  is_original: boolean;
  skill_tags: string[];
  skill_ranking: string;
  highlight_keywords: string;
  recommendation_reason: string;
  project_description_validity: string;
  certificate: string;
  portfolio_attachment: string;
  language: string;
  employee_id: string;
  created_time: timestamp;
  updated_time: timestamp;
+ summary: string;                              // 新增 — RoboHire.summary
+ upload_id: string;                            // 新增 — MinIO 上传主键

  // ★ 新增 — 这份简历提交时候选人在哪工作(从 experience[0] 派生)
+ current_company: string;                      // 新增 — RoboHire.experience[0].company
+ current_title: string;                        // 新增 — RoboHire.experience[0].role(或 .title fallback)

  // ★ 新增 — 低用率数组合并(awards/volunteerWork/publications/patents)
+ additional_sections_json: string;             // 新增 — JSON 序列化,一次性存,不查询用
};
```

#### ⚠️ 关于 `current_company` / `current_title` 放 Resume 而非 Candidate 的理由

| 维度 | 放 :Resume(★ 推荐)| 放 :Candidate |
|---|---|---|
| 数据语义 | "这份简历**说**候选人在哪工作"(快照)| "候选人**实际**在哪工作"(状态)|
| 派生源 | `experience[0]`(就在 Resume 范畴内)| 同源,但跨实体 |
| 生命周期 | 跟 Resume 节点同生死(简历版本变,数据跟着变)| 永远是最新(后来的简历覆盖)|
| 历史保留 | ✅ 多份 Resume 留多份 snapshot | ❌ 只保留最新,历史值丢 |
| 同类对比 | 跟 `work_history` 同源同生命周期,内聚 | 跟 `highest_acquired_degree` / `experience_years` 那种**单调累积**字段性质不同(current_* 是**可变状态**)|

**决定**:Resume 才正确。Candidate 端只保留**累积量**派生(`highest_acquired_degree` / `experience_years`),不放可变快照。

**(d) 对齐后 AO Runtime payload(5 → 9 字段,加 4 派生)**

```diff
type ResumeNested_ALIGNED = {
  summary: string | null;                       // Allmeta 已加字段
- skills_extracted: string[];
+ skill_tags: string[];                         // 改名
- work_history: Array<{title, company, ...}>;
+ work_history: string;                         // 序列化为 JSON String(Allmeta 改名后类型仍 String)
- education_history: Array<{...}>;
+ education_history: string;                    // 同上
- project_history: unknown[] | null;
+ project_history: string;                      // 同上
+ certificate: string | null;                   // 新增 — RoboHire 给 certifications[],序列化进
+ language_skills: string | null;               // 新增 — RoboHire 给 languages[],序列化进

  // ★ 新增 — 从 RoboHire.experience[0] 派生(按 endDate 倒序稳健取最新)
+ current_company: string | null;
+ current_title: string | null;

  // ★ 新增 — RoboHire 低用率数组合并
+ additional_sections_json: string | null;      // awards/volunteerWork/publications/patents 合并 JSON

  // upload_id 直接从上传层 SaveCandidateInput.upload_id 透传(不再嵌进 ResumeNested)
};
```

##### AO mapper 派生 current_company / current_title 的稳健逻辑

```typescript
function pickLatestJob(experience: RoboHireExperience[]): { company?: string; title?: string } {
  if (experience.length === 0) return {};
  // 不要直接信任 experience[0] — 按 endDate(或 startDate)倒序稳健取最新
  const sorted = [...experience].sort((a, b) => {
    const aEnd = String(a.endDate ?? a.startDate ?? '');
    const bEnd = String(b.endDate ?? b.startDate ?? '');
    return bEnd.localeCompare(aEnd);   // 倒序 — 最近的在前
  });
  const latest = sorted[0];
  return {
    company: typeof latest.company === 'string' ? latest.company : undefined,
    // RoboHire 用 role 不是 title,要 fallback
    title: typeof latest.role === 'string' ? latest.role
         : typeof latest.title === 'string' ? latest.title
         : undefined,
  };
}
```

#### A. 当前 AO 写入 payload

```json
{
  "domainId": "RAAS-v1",
  "resume_id": "R-100023",
  "candidate_id": "C-100023",
  "summary": "5 年研发经验 ...",         // ❌ 拒(Allmeta 没 summary)
  "skills_extracted": ["Java", "MySQL"], // ❌ 拒(Allmeta 叫 skill_tags)
  "work_history": [                      // ❌ 拒(Allmeta 叫 work_experience 而且类型是 String)
    { "title": "工程师", "company": "字节", "startDate": "2021-03", ... }
  ],
  "education_history": [...],            // ❌ 拒
  "project_history": [],                 // ❌ 拒
  "upload_id": "upload_xxx",             // ❌ 拒(Allmeta 没 upload_id)
  "file_path": "s3://bucket/key.pdf",
  "is_original": true
}
```

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A | 选项 B | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `summary: string` | (无) | RoboHire.summary 顶级 | AO 不发 | Allmeta 加 | **★ B (Allmeta 加 `summary: String`)** | 注:`summary` 也可以归 Candidate(候选人画像),这里 Resume 端冗余存一份 — 一份简历的摘要可能跟下一份不一样,所以 Resume 端是 snapshot,Candidate 端是"最新"。如果只想存一处,放 Candidate 即可 |
| `skills_extracted: string[]` | `skill_tags: List<String>` | RoboHire.skills 嵌套(6 子分类合并)| AO 改名 + 扁平化 | Allmeta 改名 | **★ A (AO 改:`skills_extracted → skill_tags` + flatten skills 6 子数组)** | 原则 ②:`skill_tags` 短而准,Allmeta 命名好;RoboHire `skills` 是嵌套 object,Neo4j 不支持 — AO mapper 拍平 |
| `work_history: Array<Object>` | `work_experience: String` | RoboHire.experience[] 数组对象 | AO 序列化为 JSON String | Allmeta 改 List<Object> | **★ 双改(类型保留 String,但 Allmeta 改名)**:Allmeta `work_experience → work_history` + AO 序列化 Object→String 写入 | 原则 ②:`history` 比 `experience` 达意(experience 让人误以为是年数);Neo4j 不擅长嵌套 Object,String 是合理妥协 |
| `education_history: Array<Object>` | `education_experience: String` | RoboHire.education[] | 同上 | 同上 | **★ 双改(同上)**:Allmeta `education_experience → education_history` | 同上 |
| `project_history: unknown[]` | `project_experience: String` | RoboHire.projects[] | 同上 | 同上 | **★ 双改(同上)**:Allmeta `project_experience → project_history` | 同上 |
| `upload_id: string` | (无,L3 只有 file_path 装 URI)| MinIO 上传层主键 | AO 不发 | Allmeta 加 | **★ B (Allmeta 加 `upload_id: String`)** | 原则 ⑤:upload_id 是 MinIO 上传记录的稳定 ID,跟 file_path(URI,可能多版本)语义不同;链 MinIO 上传日志要用 |
| `current_company: string`(派生)| (无)| **派生自 RoboHire.experience[0].company**(按 endDate 倒序取最新)| AO 不写 | Allmeta 加 | **★ B (Allmeta 加 `current_company: String`)** | 原则 ④:这是简历快照,跟 `work_history` 同源同生命周期,内聚在 Resume。不放 Candidate(可变状态,跟 Candidate 上 `previous_level` / `experience_years` 那种累积量性质不同)|
| `current_title: string`(派生)| (无)| **派生自 RoboHire.experience[0].role**(fallback `.title`)| 同上 | Allmeta 加 | **★ B (Allmeta 加 `current_title: String`)** | 同上;RoboHire 用 `role` 不是 `title`,AO mapper 要 fallback |
| `certificate: string`(派生)| `certificate: String` | RoboHire.certifications[] 序列化 | AO mapper 序列化 | Allmeta 改成 List<Object> | **★ A (AO 改:序列化 Object[]→JSON String)** | Neo4j 不擅长嵌套,String 是合理妥协;Allmeta 已有字段名,字段名对齐 |
| `language_skills: string`(派生)| `language_skills: String` | RoboHire.languages[] 序列化 | AO mapper 序列化 | 同上 | **★ A (同上)** | 同上 |
| `additional_sections_json: string` | (无)| RoboHire.awards + volunteerWork + publications + patents 合并 | AO 序列化 | Allmeta 加 | **★ B (Allmeta 加 `additional_sections_json: String`)** | 低用率字段合并成一个 JSON String 字段,不为每个低用率字段加 ontology 字段 |
| `skills: string[]`(候选人级技能数组)| `skill_tags: List<String>` | RoboHire.skills 嵌套(扁平化)| AO 写 Resume.skill_tags(不写 Candidate.skills)| — | **★ A (AO 改:技能跟简历走)** | 原则 ④:简历多版,技能跟简历走;Candidate 不应有 skills 字段 |

#### C. 关于 `language_skills` / `certificate`

L3 有这俩字段、RoboHire 也返(`languages[]` / `certifications[]`),但当前 [`ResumeNested`](../../resume-parser-agent/lib/inngest/client.ts#L46) 没把它们加进去。

→ 这是 **AO mapper 该补的字段**(原则 ① — vendor 给了的字段就该接住):
```typescript
// 在 ResumeNested 加:
certificate: string | null;       // RoboHire certifications 序列化
language_skills: string | null;   // RoboHire languages 序列化
```

---

#### ★ 3.3.X v0_1_010 终稿 — Resume(24 字段)

**Allmeta DataObject(SSoT:[objects_v0_1_010.json:Resume](../data/objects_v0_1_010.json))**

★ **设计决策**:Allmeta 让步,字段名**全部跟 RoboHire vendor 顶级字段名对齐**(experience / projects / education / languages / skills / certifications / portfolio / publications / patents / awards / summary)— 不再用 Allmeta 自创的 work_experience / language_skills / skill_tags 等名字。

```typescript
type AllmetaResume_v0_1_010 = {
  resume_id: string;                             // PK
  candidate_id: string;                          // FK→Candidate
  job_requisition_id: List<String>;              // FK→Job_Requisition(★ List — 一份简历可投多岗)
  sourcing_channel_id: string;                   // FK→Sourcing_Channel
  experience: string;                            // ★ 改名 work_experience → experience(跟 RoboHire);序列化 JSON String
  projects: string;                              // ★ 改名 project_experience → projects(跟 RoboHire)
  education: string;                             // ★ 改名 education_experience → education(跟 RoboHire)
  languages: string;                             // ★ 改名 language_skills → languages(跟 RoboHire)
  file_path: string;
  is_original: boolean;
  skills: List<String>;                          // ★ 改名 skill_tags → skills(跟 RoboHire);仅此字段保持 List
  highlight_keywords: string;
  recommendation_reason: string;
  project_description_validity: string;
  certifications: string;                        // ★ 改名 certificate → certifications(跟 RoboHire)
  portfolio: string;                             // ★ 新增 — RoboHire 顶级直返
  language: string;                              // 该简历的语言(中文/英文)
  employee_id: string;                           // FK→Employee
  created_time: timestamp;
  updated_time: timestamp;
  publications: string;                          // ★ 新增 — RoboHire 顶级
  patents: string;                               // ★ 新增 — RoboHire 顶级
  awards: string;                                // ★ 新增 — RoboHire 顶级
  summary: string;                               // ★ 新增 — RoboHire 顶级(候选人自我总结)
};
```

**AO Runtime payload(`ResumeNested` v0_1_010)**

```typescript
export type ResumeNested = {
  summary: string | null;                        // ✓ 已对齐(Allmeta 加)
  skills: string[];                              // ★ 改名 skills_extracted → skills(对齐 Allmeta)
  experience: string | null;                     // ★ 改名 work_history → experience;类型 Object[] → String
                                                  //   (mapper JSON.stringify 序列化)
  education: string | null;                      // ★ 改名 education_history → education;同上
  projects: string | null;                       // ★ 改名 project_history → projects;同上
  certifications: string | null;                 // ★ 新增 — RoboHire certifications 序列化
  languages: string | null;                      // ★ 新增 — RoboHire languages 序列化
  portfolio: string | null;                      // ★ 新增 — RoboHire 顶级
  publications: string | null;                   // ★ 新增 — RoboHire 顶级
  patents: string | null;                        // ★ 新增 — RoboHire 顶级
  awards: string | null;                         // ★ 新增 — RoboHire 顶级
  // ❌ 删除:upload_id(不放 Resume,留事件 metadata)
  // ❌ 删除:current_company / current_title / additional_sections_json
};
```

**未采纳的早期提案**:upload_id / current_company / current_title / additional_sections_json — 全部否决。

---

### 3.4 Job_Requisition

#### Schema 总览 — 现状 vs 对齐后

> **流向特殊** — JR 不是 AO 自己产生,是 AO **从 RAAS 读 64 字段、投影写 Allmeta 19 个核心字段**。

**(a) Allmeta DataObject 现状(39 字段)**

```typescript
type AllmetaJobRequisition_NOW = {
  job_requisition_id: string;                    // PK
  job_requisition_specification_id: string;      // FK
  csi_department_id: string;                     // ← 改名(去租户名)
  client_department_id: string;
  standard_job_role_id: string;
  evaluation_model_id: string;
  client_job_id: string;
  client_job_temp_id: string;
  client_job_title: string;
  client_job_type: string;
  job_responsibility: string;
  job_requirement: string;
  job_type: string;
  recruitment_type: string;
  work_years: integer;
  gender: string;
  age_range: string;
  degree_requirement: string;
  education_requirement: string;
  city: string;                                  // ← 改类型 → List<String>
  work_address: string[];
  salary_range: string;                          // ← 拆数值
  must_have_skills: string[];
  nice_to_have_skills: string[];
  language_requirements: string;
  negative_requirement: string;
  headcount: integer;
  hc_status: string;                             // ← 改名(去缩写)
  fill_difficulty: string;
  urgency_level: string;
  open_date: date;                               // ← 改名 → publish_date
  required_arrival_date: date;                   // ← 改名 → expected_arrival_date
  work_schedule_type: string;
  require_foreigner: boolean;
  clarify_questions: string[];
  recruitment_strategies: string;
  interview_mode: string;
  interview_process: string;
  expected_level: string;                        // ← 改名 → target_job_level
};
```

**(b) AO 投影写入 payload 现状(从 [RaasRequirement](../../resume-parser-agent/lib/raas-api-client.ts#L622) 投影,19 字段)**

```typescript
type AOJobRequisitionWrite_NOW = {
  job_requisition_id: string;
  job_requisition_specification_id: string;
  client_department_id: string;
  client_job_id: string;
  client_job_title: string;
  job_responsibility: string;
  job_requirement: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  negative_requirement: string;
  language_requirements: string;
  city: string;                                  // RAAS 单值
  salary_range: string;                          // "1-1.5万/月"
  headcount: number;
  work_years: number;
  degree_requirement: string;
  education_requirement: string;
  interview_mode: string;
  expected_level: string;
  recruitment_type: string;
  // RAAS 还会返这些(在 spec/sibling 里)— AO 选择不写:
  //   status, hc_status, priority, headcount_filled, completion_time,
  //   created_at, our_application_count, competitor_application_count, ...(~30 字段)
};
```

**直接 POST 失败原因**:RAAS 实际响应有 64 字段,如果不投影直发,~30 字段 Allmeta 不认识(流程态)。AO 必须做 mapper 投影。

**(c) 对齐后 Allmeta DataObject(39 → 41 字段,5 改名 + 1 改类型 + 拆 3 字段)**

```diff
type AllmetaJobRequisition_ALIGNED = {
  job_requisition_id: string;
  job_requisition_specification_id: string;
- csi_department_id: string;
+ recruiting_department_id: string;              // 改名
  client_department_id: string;
  standard_job_role_id: string;
  evaluation_model_id: string;
  client_job_id: string;
  client_job_temp_id: string;
  client_job_title: string;
  client_job_type: string;
  job_responsibility: string;
  job_requirement: string;
  job_type: string;
  recruitment_type: string;
  work_years: integer;
  gender: string;
  age_range: string;
  degree_requirement: string;
  education_requirement: string;
- city: string;
+ city: string[];                                // 改类型
  work_address: string[];
- salary_range: string;
+ salary_range: string;                          // 保留兼容
+ salary_range_monthly_min: float;               // 拆字段
+ salary_range_monthly_max: float;               // 拆字段
+ salary_currency: string;                       // 拆字段
  must_have_skills: string[];
  nice_to_have_skills: string[];
  language_requirements: string;
  negative_requirement: string;
  headcount: integer;
- hc_status: string;
+ headcount_status: string;                      // 改名
  fill_difficulty: string;
  urgency_level: string;
- open_date: date;
+ publish_date: date;                            // 改名
- required_arrival_date: date;
+ expected_arrival_date: date;                   // 改名
  work_schedule_type: string;
  require_foreigner: boolean;
  clarify_questions: string[];
  recruitment_strategies: string;
  interview_mode: string;
  interview_process: string;
- expected_level: string;
+ target_job_level: string;                      // 改名
};
```

**(d) 对齐后 AO 投影写入 payload(同字段名,city 改 List,加 salary 拆字段)**

```diff
type AOJobRequisitionWrite_ALIGNED = {
  job_requisition_id: string;
  job_requisition_specification_id: string;
  client_department_id: string;
  client_job_id: string;
  client_job_title: string;
  client_job_type: string;
  job_responsibility: string;
  job_requirement: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  negative_requirement: string;
  language_requirements: string;
- city: string;
+ city: string[];                                 // mapper 包成 array
  salary_range: string;                           // 保留兼容
+ salary_range_monthly_min: number;               // mapper parseSalaryRange 拆出来
+ salary_range_monthly_max: number;
+ salary_currency: string;                        // 默认 'CNY'
  headcount: number;
  work_years: number;
  degree_requirement: string;
  education_requirement: string;
  interview_mode: string;
- expected_level: string;
+ target_job_level: string;                       // 改名
  recruitment_type: string;
+ publish_date: string;                           // RAAS 透传
+ expected_arrival_date: string;
  // 投影丢弃(永远不写):
  //   status / hc_status / priority / headcount_filled / completion_time /
  //   created_at / our_application_count / 等流程态 ~30 字段
  //   client_id / client_name / hsm_employee_id 等冗余 — 走 FK 链
};
```

#### A. 流向特殊

JR 是 AO **从 RAAS 读**(`GET /api/v1/requirements/:id` 返回 64 字段)然后**投影写 Allmeta**。AO 不是 source of truth,投影规则就是对齐规则。

#### B. 三类字段处理策略

| 类别 | 字段数 | 处理 |
|---|---|---|
| **直接对得上的核心字段**(name/type 一致) | 19 | AO mapper 直接写,无改动 |
| **vendor 命名 vs ontology 命名分歧** | 5 | 见下表逐条 |
| **RAAS 流程态字段**(status/hc_status/priority/created_at 等) | ~30 | AO **丢弃** — DataObject 存"事实",状态走 Event 流追,不进 ontology |

#### C. 命名/类型分歧逐字段决策

| AO/RAAS 字段 | Allmeta 字段 | 字段来源 | 选项 A | 选项 B | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `publish_date` | `open_date: Date` | RAAS vendor 命名 | AO 改名 | Allmeta 改名 | **★ B (Allmeta 改 `open_date → publish_date`)** | 原则 ①:RAAS 行业用法是 publish |
| `expected_arrival_date` | `required_arrival_date: Date` | RAAS vendor | AO 改名 | Allmeta 改名 | **★ B (Allmeta 改 `required_arrival_date → expected_arrival_date`)** | 原则 ①:RAAS 用 expected,语气也对(候选人到岗是预期不是强制)|
| `city: string` (单值) | `city: String` (单值) | 都自创 | AO 改 List | Allmeta 改 List | **★ B (Allmeta 改 `city: List<String>`)** | 原则 ③:多地点办公是常态 |
| `salary_range: string` ("1-1.5万/月") | `salary_range: String` | RAAS vendor | AO 拆数值 | Allmeta 拆 | **★ B (Allmeta 拆 `salary_range_monthly_min/max: Float` + `salary_currency: String` + 保留 `salary_range: String` 兼容)** | 原则 ③ |
| `expected_level` | `expected_level: String` | 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `expected_level → target_job_level`)** | 原则 ②:`expected_level` 模糊(指岗位想招的级别)|
| (Allmeta `csi_department_id`)| `csi_department_id: String (FK)` | Allmeta 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `csi_department_id → recruiting_department_id`)** | 原则 ②:ontology 不该带租户名(csi = 中软国际)|
| (Allmeta `hc_status`)| `hc_status: String` | Allmeta 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `hc_status → headcount_status`)** | 原则 ②:缩写应展开 |

---

#### ★ 3.4.X v0_1_010 终稿 — Job_Requisition(39 字段,完全不动)

★ **决策**:JR DataObject 全部 5 处改名(`csi_department_id / hc_status / open_date / required_arrival_date / expected_level`)+ 2 处类型改动(`city: String→List` + `salary_range` 拆 min/max)**全部否决**。

**理由**:JR 是 RAAS 写入,改 ontology 等于让 partner 改 mapper 代价高;新接入 partner 跟齐现有 39 字段名;`city: String` + `salary_range: String` 配合"contains 查询" / 前端解析展示已够用。

**AO 端动作**:`toAllmetaJobRequisition` mapper 从 RAAS `RaasRequirement` 64 字段**投影**这 39 字段直发,**不做任何字段名/类型转换**:

```typescript
// resume-parser-agent/lib/mappers/ao-to-allmeta.ts (v0_1_010)
export function toAllmetaJobRequisition(raas: RaasRequirement): Record<string, unknown> {
  return {
    job_requisition_id: raas.job_requisition_id,
    job_requisition_specification_id: raas.job_requisition_specification_id,
    csi_department_id: raas.csi_department_id,         // ★ 保留原名,不改 recruiting_department_id
    client_department_id: raas.client_department_id,
    standard_job_role_id: raas.standard_job_role_id,
    evaluation_model_id: raas.evaluation_model_id,
    client_job_id: raas.client_job_id,
    client_job_temp_id: raas.client_job_temp_id,
    client_job_title: raas.client_job_title,
    client_job_type: raas.client_job_type,
    job_responsibility: raas.job_responsibility,
    job_requirement: raas.job_requirement,
    job_type: raas.job_type,
    recruitment_type: raas.recruitment_type,
    work_years: raas.work_years,                       // Integer(JR 端是 Integer,Candidate 端是 Float)
    gender: raas.gender,
    age_range: raas.age_range,                         // String 例 "25-35"
    degree_requirement: raas.degree_requirement,
    education_requirement: raas.education_requirement,
    city: raas.city,                                   // ★ String 单值,不改 List
    work_address: raas.work_address,                   // 仅此字段保持 List<String>
    salary_range: raas.salary_range,                   // ★ String,不拆 min/max
    must_have_skills: raas.must_have_skills,
    nice_to_have_skills: raas.nice_to_have_skills,
    language_requirements: raas.language_requirements,
    negative_requirement: raas.negative_requirement,
    headcount: raas.headcount,
    hc_status: raas.hc_status,                         // ★ 保留缩写,不改 headcount_status
    fill_difficulty: raas.fill_difficulty,
    urgency_level: raas.urgency_level,
    open_date: raas.open_date,                         // ★ 保留,不改 publish_date
    required_arrival_date: raas.required_arrival_date, // ★ 保留,不改 expected_arrival_date
    work_schedule_type: raas.work_schedule_type,
    require_foreigner: raas.require_foreigner,
    clarify_questions: raas.clarify_questions,
    recruitment_strategies: raas.recruitment_strategies,
    interview_mode: raas.interview_mode,
    interview_process: raas.interview_process,
    expected_level: raas.expected_level,               // ★ 保留,不改 target_job_level
    // ★ 丢弃 RAAS 流程态字段:status / priority / completion_time / created_at 等 ~25 字段
  };
}
```

---

### 3.5 Candidate_Match_Result(问题最严重)

> **★ 2026-05-14 直连 RoboHire 实测发现(`req_1778761416694_2md17dp`,响应存档 `/tmp/robohire-probe/match-resume-2026-05-14.json`)** —
>
> 实际响应跟 [resume-parser-agent/lib/raas-api-client.ts:161-169](../../resume-parser-agent/lib/raas-api-client.ts#L161-L169) 的 `RaasMatchResumeData` 类型**严重不一致**:
> - `data.matchScore` / `data.recommendation` / `data.summary` 三个顶级字段在真实响应里 **=== null**
> - 真实评分在 `data.overallMatchScore.score`(=91)
> - 真实算法分级在 `data.overallFit.verdict`(="Strong Match",**自然语言不是 `STRONG_MATCH` 枚举**)
> - 真实摘要在 `data.overallFit.summary`
> - `data.transferableSkills` 是 **对象数组** `Array<{required, candidateHas, relevance, valueFactor}>`,不是 `string[]`
>
> 这意味着 §3.5 C.2 "高价值字段"的 AO 字段来源**必须改成嵌套路径 pluck**,mapper 还要做自然语言→枚举的归一化。下文 [§3.5 C.2 已更新](#c2-高价值字段allmeta-加单独字段做查询用) 把每行的源路径都对齐到实测,新增 §3.5 C.5 给出 pluck/normalize 的具体代码。

#### Schema 总览 — 现状 vs 对齐后

**(a) Allmeta DataObject 现状(只有 6 字段)**

```typescript
type AllmetaCandidateMatchResult_NOW = {
  candidate_match_result_id: string;            // PK
  client_id: string;                            // FK→Client
  candidate_id: string;                         // FK→Candidate
  job_position_id: string;                      // ← FK→Job_Requisition,孤儿命名(没 Job_Position 对象)
  result: string;                               // "匹配/不匹配/待定"
  reason: string;                               // 自由文本
  // ✗ 23+ RoboHire 字段全部缺
  // ✗ 8 个 rule-check 审计字段全部缺
};
```

**(b) AO Runtime payload 现状([MatchPassedNeedInterviewData](../../resume-parser-agent/lib/inngest/client.ts#L114) 平铺 RoboHire data,**31 字段**)**

```typescript
type AOMatchResultWrite_NOW = {
  // anchor (2)
  upload_id: string;
  job_requisition_id: string;                   // ← Allmeta 叫 job_position_id

  // RoboHire data 平铺(23 字段全部 camelCase)
  // ⚠️ 2026-05-14 实测:matchScore / recommendation / summary 在真实响应里 === null —
  //    AO 当前 typing 错误地假设这三个字段直接可读。真实数据在嵌套路径里。
  matchScore: number;                           // ⚠️ 实测 === null;真实评分 = data.overallMatchScore.score
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
                                                // ⚠️ 实测 === null;真实分级 = data.overallFit.verdict (自然语言 "Strong Match")
  summary: string;                              // ⚠️ 实测 === null;真实摘要 = data.overallFit.summary
                                                //    ← Allmeta 叫 reason
  matchAnalysis: object;
  mustHaveAnalysis: object;
  niceToHaveAnalysis: object;
  resumeAnalysis: object;
  jdAnalysis: object;
  skillMatch: object;
  skillMatchScore: object | number;
  experienceMatch: object;
  experienceValidation: object;
  candidatePotential: object;
  transferableSkills: string[];                 // ⚠️ 实测是 Array<{required, candidateHas, relevance, valueFactor}> — typing 错
  experienceBreakdown: object;
  hardRequirementGaps: string[];
  overallMatchScore: object | number;
  overallFit: object;
  recommendations: object;
  suggestedInterviewQuestions: object;
  areasToProbeDeeper: unknown[];
  preferenceAlignment: object;
  candidateSummary: object;

  // RoboHire trace (3)
  requestId: string;
  savedAs: string;
  success: boolean;

  // AO rule-check 审计(8 字段)
  rule_check_audit_id: string;
  rule_check_decision: 'PASS' | 'FAIL';
  failure_reason_codes: string[];
  rules_evaluated_count: number;
  terminal_rule_hits: string[];
  final_decision: 'PASS' | 'FAIL';
  final_decision_reason: string;
  parent_match_result_id: string;
};
```

**直接 POST 失败原因**:31 字段里 25 字段会被拒(`job_position_id` 还得改名)— **这是 5 个 DataObject 里最严重的对齐缺口**。

**(c) 对齐后 Allmeta DataObject(6 → 40 字段:1 改名 + 34 新增 — 基于 2026-05-14 两份样本实测 + 简历可信度复合模型)**

> ★ 2026-05-14 加严:除了首版 10 个新增字段,基于两份 RoboHire `/match-resume` 真实响应(秦嘉阔 STRONG_MATCH 91 / "未提供" GOOD_MATCH 78)又盘出 **17 个被遗漏的 P0/P1 字段** — 都是顶级 `data.*` 嵌套对象里的查询级 scalar,不放出来 partner UI 做"哪些候选人 DQ?" / "哪些有信誉红旗?" / "哪些频繁跳槽?" 都做不了。
>
> ★ **进一步**:简历可信度不是单一字段而是**复合信号**(RoboHire 把它散在 6 个位置:`credibilityFlags` 主 + `workHistoryStability.concerns/currentGap*` 辅 1 + `experienceValidation.score/relevanceToRole` 辅 2 + `areasToProbeDeeper.redFlags/greenFlags` 留 JSON + `redFlagProbing` 留 JSON + `candidatePotential.riskFactors` 已 pluck)。第三轮再加 **7 个可信度相关字段**(`credibility_positive_indicators` / `experience_validation_score` / `experience_relevance` / `current_gap_flagged` / `current_gap_explanation` / `stability_concerns` / `stability_mitigating_factors`),并在 §3.5 C.9 给出"复合可信度判定 Cypher 写法"。

```diff
type AllmetaCandidateMatchResult_ALIGNED = {
  // ─── PK + FK (4) ───
  candidate_match_result_id: string;            // PK
  client_id: string;                            // FK→Client
  candidate_id: string;                         // FK→Candidate
- job_position_id: string;                      // 孤儿命名(没 :Job_Position 对象)
+ job_requisition_id: string;                   // 改名 → 其他 DataObject 都用 _requisition_id

  // ─── 中文双结论 (2) ───
  result: string;                               // 中文 3 档(匹配/待定/不匹配)— UI 显示
  reason: string;                               // 1-2 句话总结(来自 data.overallFit.summary)

  // ─── 总评分维度 (4) ───
+ match_score: float;                           // 0-1 — data.overallMatchScore.score / 100
+ grade: string;                                // "A" / "B+" / "C" — data.overallMatchScore.grade
+ confidence: string;                           // "High"/"Medium"/"Low" — data.overallMatchScore.confidence
+ recommendation: string;                       // 枚举 STRONG/GOOD/PARTIAL/WEAK_MATCH(verdict 归一化)

  // ─── 录用建议 (1) ───
+ hiring_recommendation: string;                // 自然语言 "Strongly Recommend"/"Recommend" — data.overallFit.hiringRecommendation

  // ─── 硬性条件评估 (4) ───★ disqualified 是 P0 业务 flag,必须平铺
+ disqualified: boolean;                        // ★ P0 — data.mustHaveAnalysis.disqualified
+ disqualification_reasons: string[];           // ★ P0 — data.mustHaveAnalysis.disqualificationReasons
+ must_have_score: float;                       // data.mustHaveAnalysis.mustHaveScore (0-100)
+ must_have_gaps: string[];                     // data.hardRequirementGaps
+ missing_must_have_skills: string[];           // data.skillMatch.missingMustHave

  // ─── 加分项 (1) ───
+ nice_to_have_score: float;                    // data.niceToHaveAnalysis.niceToHaveScore (0-100)

  // ─── 技能维度评分 + 简历可信度(主) (4) ───★ has_credibility_red_flags 是 P0 防造假 flag
+ skill_match_score: float;                     // data.skillMatchScore.score (0-100)
+ has_credibility_red_flags: boolean;           // ★ P0 — data.skillMatchScore.credibilityFlags.hasRedFlags
+ credibility_concerns: string[];               // data.skillMatchScore.credibilityFlags.concerns
+ credibility_positive_indicators: string[];    // data.skillMatchScore.credibilityFlags.positiveIndicators

  // ─── 风险信号 (1) ───
+ risk_factors: string[];                       // data.candidatePotential.riskFactors

  // ─── 经验有效性(简历可信度·辅 1)(2) ───
+ experience_validation_score: float;           // data.experienceValidation.score(0-100)— "经验是否站得住脚"
+ experience_relevance: string;                 // data.experienceValidation.relevanceToRole("High"/"Medium"/"Low")

  // ─── 工作稳定性(简历可信度·辅 2)(8) ───
+ stability_score: float;                       // data.workHistoryStability.score (0-100)
+ stability_pattern: string;                    // ★ 自由文本"Mostly Stable"/"Some Concerns"等,不归一化
+ short_stint_count: integer;                   // data.workHistoryStability.shortStintCount
+ average_tenure_months: integer;               // data.workHistoryStability.averageTenureMonths
+ currently_employed: boolean;                  // data.workHistoryStability.currentlyEmployed
+ current_gap_flagged: boolean;                 // data.workHistoryStability.currentGapFlagged — 当前 gap 是否被标记可疑
+ current_gap_explanation: string;              // data.workHistoryStability.currentGapExplanation — gap 解释文本
+ stability_concerns: string[];                 // data.workHistoryStability.concerns — 简历时间线可疑点
+ stability_mitigating_factors: string[];       // data.workHistoryStability.mitigatingFactors — 减轻顾虑的因素

  // ─── 可迁移技能 (1) ───
+ transferable_skills: string[];                // 拍扁:t.required ← t.candidateHas

  // ─── trace (2) ───
+ raas_match_request_id: string;                // RoboHire 请求 ID(顶级 requestId)
+ decided_at: timestamp;                        // mapper 加,UTC ISO

  // ─── 大块原始 data 留底 (1) ───
+ match_breakdown_json: string;                 // RoboHire data 整段 JSON.stringify
                                                 // 剩余 8 个 RoboHire 顶级 keys 全进这里:
                                                 //   resumeAnalysis / jdAnalysis / skillMatch / experienceMatch /
                                                 //   experienceValidation / candidatePotential / experienceBreakdown /
                                                 //   recommendations / suggestedInterviewQuestions /
                                                 //   areasToProbeDeeper / preferenceAlignment

  // ─── rule-check 审计 (3) ───
+ rule_check_audit_id: string;                  // → AO Prisma SQLite RuleCheckAudit 表
+ rule_check_decision: string;                  // PASS/FAIL
+ failure_reason_codes: string[];               // 失败原因代码(可结构化筛选)
};
```

**(d) 对齐后 AO Runtime payload(31 → 33 字段,跟 (c) 一一对应)**

mapper 输出的 TS shape 跟 (c) 完全对齐(因为是同一个对象的 TS / Cypher 两种表达):

```diff
type AOMatchResultWrite_ALIGNED = {
  // ─── PK + 关联 (4) ───
  candidate_match_result_id: string;            // mapper 生成 cmr_<audit_id>
  client_id: string;
  candidate_id: string;
- job_requisition_id: string;
+ job_requisition_id: string;                   // 命名已对齐(Allmeta 改名 job_position_id → 此)

  // ─── 中文双结论 (2) ───
+ result: string;                               // mapper VERDICT_TO_RESULT 映射成中文 3 档
- summary: string;
+ reason: string;                               // ★ pluck data.overallFit.summary,不是 data.summary(=null bug)

  // ─── 总评分维度 (4) ───
+ match_score: number;                          // ★ pluck data.overallMatchScore.score / 100(原 data.matchScore 实测 null)
+ grade: string;                                // pluck data.overallMatchScore.grade
+ confidence: string;                           // pluck data.overallMatchScore.confidence
+ recommendation: string;                       // ★ mapper VERDICT_TO_RECOMMENDATION(data.overallFit.verdict 自然语言→枚举)

  // ─── 录用建议 (1) ───
+ hiring_recommendation: string;                // pluck data.overallFit.hiringRecommendation(自然语言直存)

  // ─── 硬性条件评估 (5) ───
+ disqualified: boolean;                        // ★ pluck data.mustHaveAnalysis.disqualified
+ disqualification_reasons: string[];           // pluck data.mustHaveAnalysis.disqualificationReasons
+ must_have_score: number;                      // pluck data.mustHaveAnalysis.mustHaveScore
+ must_have_gaps: string[];                     // 改名 hardRequirementGaps → must_have_gaps(已是 string[],直存)
+ missing_must_have_skills: string[];           // pluck data.skillMatch.missingMustHave

  // ─── 加分项 (1) ───
+ nice_to_have_score: number;                   // pluck data.niceToHaveAnalysis.niceToHaveScore

  // ─── 技能 + 可信度·主 (4) ───
+ skill_match_score: number;                    // pluck data.skillMatchScore.score
+ has_credibility_red_flags: boolean;           // ★ pluck data.skillMatchScore.credibilityFlags.hasRedFlags
+ credibility_concerns: string[];               // pluck data.skillMatchScore.credibilityFlags.concerns
+ credibility_positive_indicators: string[];    // pluck data.skillMatchScore.credibilityFlags.positiveIndicators

  // ─── 风险 (1) ───
+ risk_factors: string[];                       // pluck data.candidatePotential.riskFactors

  // ─── 经验有效性·可信度·辅 1 (2) ───
+ experience_validation_score: number;          // pluck data.experienceValidation.score
+ experience_relevance: string;                 // pluck data.experienceValidation.relevanceToRole

  // ─── 稳定性·可信度·辅 2 (8) ───
+ stability_score: number;                      // pluck data.workHistoryStability.score
+ stability_pattern: string;                    // pluck data.workHistoryStability.pattern(自由文本)
+ short_stint_count: number;                    // pluck data.workHistoryStability.shortStintCount
+ average_tenure_months: number;                // pluck data.workHistoryStability.averageTenureMonths
+ currently_employed: boolean;                  // pluck data.workHistoryStability.currentlyEmployed
+ current_gap_flagged: boolean;                 // pluck data.workHistoryStability.currentGapFlagged
+ current_gap_explanation: string;              // pluck data.workHistoryStability.currentGapExplanation
+ stability_concerns: string[];                 // pluck data.workHistoryStability.concerns
+ stability_mitigating_factors: string[];       // pluck data.workHistoryStability.mitigatingFactors

  // ─── 可迁移技能 (1) ───
+ transferable_skills: string[];                // ★ 拍扁 Array<{required,candidateHas,...}> → string[](原 typing 是错的)

  // ─── trace (2) ───
+ raas_match_request_id: string;                // 顶级 requestId → raas_match_request_id
+ decided_at: string;                           // mapper 加 timestamp ISO

  // ─── 大块留底 (1) ───
+ match_breakdown_json: string;                 // JSON.stringify(matchData)

  // ─── rule-check 审计 (3) ───
+ rule_check_audit_id: string;
+ rule_check_decision: string;
+ failure_reason_codes: string[];

  // ✗ 不写 — 留 Inngest event metadata:
  //   rules_evaluated_count / terminal_rule_hits / parent_match_result_id /
  //   final_decision / final_decision_reason
};
```

**(e) RoboHire `RaasMatchResumeData` typing 修正(L1 端)**

[`resume-parser-agent/lib/raas-api-client.ts:161-169`](../../resume-parser-agent/lib/raas-api-client.ts#L161-L169) 当前 typing **跟 vendor 真实响应严重不符**(根据 2026-05-14 两份样本):

```diff
- export type RaasMatchResumeData = {
-   matchScore: number;                         // ⚠️ 实测 === null
-   recommendation: 'STRONG_MATCH' | ...;       // ⚠️ 实测 === null
-   summary?: string;                            // ⚠️ 实测 === null
-   matchAnalysis?: Record<string, unknown>;
-   mustHaveAnalysis?: Record<string, unknown>;
-   niceToHaveAnalysis?: Record<string, unknown>;
-   [k: string]: unknown;
- };

+ export type RaasMatchResumeData = {
+   // 顶级 null/legacy 字段(留 typing 不删,但 mapper 不依赖)
+   matchScore: null;                            // vendor 顶级永远为 null,真实评分在 overallMatchScore.score
+   recommendation: null;                        // 同上,真实在 overallFit.verdict
+   summary: null;                               // 同上,真实在 overallFit.summary
+
+   // ─── 评分对象 ───
+   overallMatchScore: {
+     score: number;                             // 0-100 整数
+     grade: string;                             // "A" / "B+" / ...
+     confidence: 'High' | 'Medium' | 'Low';
+     breakdown: {
+       skillMatchWeight: number;
+       skillMatchScore: number;
+       experienceWeight: number;
+       experienceScore: number;
+       potentialWeight: number;
+       potentialScore: number;
+     };
+   };
+
+   // ─── 整体结论 ───
+   overallFit: {
+     verdict: string;                           // 自然语言 "Strong Match" / "Good Match" / ...
+     summary: string;
+     topReasons: string[];
+     interviewFocus: string[];
+     hiringRecommendation: string;              // 自然语言 "Strongly Recommend" / "Recommend"
+     suggestedRole: string;
+   };
+
+   // ─── 硬性条件 ───
+   mustHaveAnalysis: {
+     extractedMustHaves: Record<string, unknown>;
+     candidateEvaluation: {
+       meetsAllMustHaves: boolean;
+       matchedSkills: Array<{ skill: string; candidateEvidence: string; proficiency: string }>;
+       missingSkills: string[];
+       matchedExperiences: unknown[];
+       missingExperiences: unknown[];
+       matchedQualifications: string[];
+       missingQualifications: string[];
+     };
+     mustHaveScore: number;
+     disqualified: boolean;
+     disqualificationReasons: string[];
+     gapAnalysis: string;
+   };
+
+   // ─── 加分项 ───
+   niceToHaveAnalysis: {
+     niceToHaveScore: number;
+     competitiveAdvantage: string;
+     [k: string]: unknown;
+   };
+
+   // ─── 技能 + 可信度·主信号 ───
+   skillMatchScore: {
+     score: number;
+     breakdown: { mustHaveScore: number; niceToHaveScore: number; depthOfExpertise: number };
+     skillApplicationAnalysis: string;
+     credibilityFlags: {
+       hasRedFlags: boolean;                    // ★ 简历真实性主旗
+       concerns: string[];                       // 可疑点
+       positiveIndicators: string[];             // 可信度高的迹象(量化业绩/证书/比赛)
+     };
+   };
+
+   // ─── 可信度·辅 1:经验有效性 ───
+   experienceValidation: {
+     score: number;                              // 0-100 — 经验声明是否站得住脚
+     relevanceToRole: 'High' | 'Medium' | 'Low'; // 跟 JD 的真实相关度
+     gaps: Array<{ area: string; severity: string; canBeAddressed: 'Yes' | 'No' }>;
+     strengths: Array<{ area: string; impact: string }>;
+     careerProgression: string;
+   };
+   skillMatch: {
+     matchedMustHave: Array<{ skill: string; proficiencyLevel: string; evidenceFromResume: string }>;
+     missingMustHave: string[];
+     matchedNiceToHave: string[];
+     missingNiceToHave: string[];
+     additionalRelevantSkills: string[];
+   };
+
+   // ─── 风险 / 潜力 ───
+   candidatePotential: {
+     riskFactors: string[];
+     [k: string]: unknown;
+   };
+
+   // ─── 工作稳定性(★ 简历可信度·辅 2,时间线真实性)───
+   workHistoryStability: {
+     score: number;                              // 0-100 稳定性评分
+     pattern: string;                            // 自由文本"Mostly Stable"/"Some Concerns"
+     shortStintCount: number;                    // 短在职次数
+     averageTenureMonths: number;                // 平均任职月数
+     currentlyEmployed: boolean;
+     monthsSinceLastRole: number;
+     currentGapFlagged: boolean;                 // ★ 当前 gap 是否被标记可疑(简历可信度信号)
+     currentGapExplanation: string;              // ★ gap 的简历解释文本
+     gaps: Array<{ startDate: string; endDate: string; reason: string }>;
+     concerns: string[];                          // ★ 简历时间线可疑点
+     mitigatingFactors: string[];                 // 减轻顾虑的因素
+     assessment: string;
+   };
+
+   // ─── 可迁移技能(★ 对象数组,不是 string[])───
+   transferableSkills: Array<{
+     required: string;
+     candidateHas: string;
+     relevance: string;
+     valueFactor: number;
+   }>;
+
+   // ─── 硬短板 ───
+   hardRequirementGaps: string[];
+
+   // ─── 大块文本/对象,mapper 不 pluck,留 match_breakdown_json ───
+   resumeAnalysis: Record<string, unknown>;
+   jdAnalysis: Record<string, unknown>;
+   experienceMatch: Record<string, unknown>;
+   experienceBreakdown: Record<string, unknown>;
+   recommendations: Record<string, unknown>;
+   suggestedInterviewQuestions: Record<string, unknown>;
+   areasToProbeDeeper: Array<{                  // 部分子字段是简历可信度·辅 3(留 JSON)
+     area: string;
+     priority: 'Critical' | 'High' | 'Medium' | 'Low';
+     reason: string;
+     subAreas: Array<{
+       name: string;
+       specificConcerns: string[];
+       validationQuestions: string[];
+       greenFlags: string[];                     // ★ 面试观察到 = 简历真实
+       redFlags: string[];                       // ★ 面试观察到 = 简历夸大
+     }>;
+     suggestedApproach: string;
+   }>;
+   preferenceAlignment: Record<string, unknown>;
+
+   [k: string]: unknown;                        // catch-all,容忍 vendor 加新字段
+ };
```

#### A. 现状对比

| | 数量 | 字段 |
|---|---|---|
| Allmeta `properties[]` 现状 | **6** | `candidate_match_result_id / client_id / candidate_id / job_position_id / result / reason` |
| RoboHire `data.*` 顶级 keys(2026-05-14 实测,2 份样本完全一致)| **19** | resumeAnalysis / jdAnalysis / mustHaveAnalysis / niceToHaveAnalysis / skillMatch / skillMatchScore / experienceMatch / experienceValidation / candidatePotential / transferableSkills / experienceBreakdown / hardRequirementGaps / workHistoryStability / overallMatchScore / overallFit / recommendations / suggestedInterviewQuestions / areasToProbeDeeper / preferenceAlignment |
| 顶级 19 keys 里的查询级嵌套 scalar(P0+P1 需要 pluck 平铺)| **24** | 见 §3.5 C.2 表 |
| AO 当前 emit(`MatchPassedNeedInterviewData` 平铺 + rule-check)| **31** | 23 RoboHire camelCase + 8 rule-check |
| **对齐后 Allmeta MR 字段**(目标)| **33** | 见 §3.5 (c) |

如果 AO 不改 mapper 直接发 31 个 camelCase 字段给 Allmeta,**25 个会被拒**;同时 RoboHire 真实响应里 19 个顶级 key 中**有 24 个查询级 scalar 是嵌套的**,直接 spread 顶级 key 会丢这些查询能力。

#### B. AO 当前 emit 的 payload 形态(看 [`MatchPassedNeedInterviewData`](../../resume-parser-agent/lib/inngest/client.ts#L114))

```json
{
  "upload_id": "upload_xxx",
  "job_requisition_id": "JR-001",
  "success": true,
  "data": {
    "matchScore": 0.82,
    "recommendation": "GOOD_MATCH",
    "summary": "技术栈基本匹配 ...",
    "matchAnalysis": {...},
    "mustHaveAnalysis": {...},
    "niceToHaveAnalysis": {...},
    "resumeAnalysis": {...},
    "jdAnalysis": {...},
    "skillMatch": {...},
    "skillMatchScore": 0.85,
    "experienceMatch": {...},
    "experienceValidation": {...},
    "candidatePotential": {...},
    "transferableSkills": ["Spring → SpringBoot"],
    "experienceBreakdown": {...},
    "hardRequirementGaps": ["3年Java经验未达5年要求"],
    "overallMatchScore": 0.82,
    "overallFit": {...},
    "recommendations": {...},
    "suggestedInterviewQuestions": [...],
    "areasToProbeDeeper": [...],
    "preferenceAlignment": {...},
    "candidateSummary": {...}
  },
  "requestId": "rh_req_xxx",
  "savedAs": "match_2026-05-14.json"
}
```

#### C. 对齐方案 — 4 类字段分别处理

##### C.1 命名分歧(必须改)

| AO 字段 | Allmeta 字段 | 字段来源 | ★ 推荐 | 理由 |
|---|---|---|---|---|
| `job_requisition_id` | `job_position_id` | 都自创 | **★ Allmeta 改 `job_position_id → job_requisition_id`** | 原则 ②:`job_position_id` 是孤儿命名(ontology 没 Job_Position 对象);其他所有 DataObject (Job_Offer/Resume/Job_Posting/Application) 都用 `job_requisition_id` |
| `data.overallFit.summary`(★ 实测路径,不是 `data.summary`)| `reason` | RoboHire `data.overallFit.summary` | **★ AO 改:`reason = data.overallFit?.summary ?? ''`** | 原则 ②:`reason` 在 MR 上下文里更准(为什么得出这个结论);**注意:`data.summary` 实测 === null,以前的 AO mapper 是 bug** |

##### C.2 高价值字段(Allmeta 加单独字段,做查询用)

> **★ 2026-05-14 两份实测样本对照后扩展**:从首版 11 行扩到 **24 行**,新增 13 行(P0:3 + P1:10)— 之前漏的几个 P0 boolean(`disqualified` / `has_credibility_red_flags`)是业务硬 flag,漏掉等于"该 DQ 的人也进 pipeline"。下表"AO 字段来源"列全部是 **2026-05-14 实测的真实嵌套路径**,不是 docs 早期 example 的顶级路径(那些实测全 null)。

| # | AO 字段(实际源路径)| Allmeta 加什么 | mapper pluck/normalize 逻辑 | 优先级 | 理由 |
|---|---|---|---|---|---|
| 1 | `data.overallMatchScore.score: number`(0-100 例 91 / 78)| `match_score: Float` | `Number(data.overallMatchScore?.score) / 100` → 0-1 | **P0** | 核心 metric,做"Top 10"必用 |
| 2 | `data.overallMatchScore.grade: string`("A" / "B+")| `grade: String` | 直存 | P1 | UI 字母级展示 |
| 3 | `data.overallMatchScore.confidence: string`("High"/"Medium"/"Low")| `confidence: String` | 直存 | P1 | "High confidence only" 筛选 |
| 4 | `data.overallFit.verdict: string`("Strong Match" / "Good Match" 自然语言)| `recommendation: String`(枚举)| `VERDICT_TO_RECOMMENDATION` 表归一化(见 §3.5 C.5)| **P0** | 算法 4 档分级 |
| 5 | `data.overallFit.hiringRecommendation: string`("Strongly Recommend" / "Recommend" 自然语言)| `hiring_recommendation: String` | ★ **直存,不归一化**(vendor 值未穷尽)| P1 | UI 直接展示 |
| 6 | `data.overallFit.summary: string` | `reason: String` | `reason = data.overallFit?.summary ?? ''` | **P0** | 1-2 句话人类可读 |
| 7 | `data.overallFit.verdict` 二次映射 | `result: String`(中文 3 档)| `VERDICT_TO_RESULT` 表("Strong/Good Match"→"匹配", "Partial Match"→"待定", "Weak Match/Not a Match"→"不匹配") | **P0** | partner UI 中文展示 |
| 8 | `data.mustHaveAnalysis.disqualified: boolean` | `disqualified: Boolean` | `Boolean(data.mustHaveAnalysis?.disqualified)` | **P0** | ★ **DQ flag** — RoboHire 自己判定的 disqualify,漏掉 = DQ 候选人也进面试 pipeline |
| 9 | `data.mustHaveAnalysis.disqualificationReasons: string[]` | `disqualification_reasons: List<String>` | 直存(空数组也存)| **P0** | DQ 原因,partner UI 必备 |
| 10 | `data.mustHaveAnalysis.mustHaveScore: number`(0-100)| `must_have_score: Float` | 直存 | **P0** | 硬性命中比 |
| 11 | `data.hardRequirementGaps: string[]`(顶级,实测是 string[])| `must_have_gaps: List<String>` | 直存 | **P0** | 硬性短板筛选 |
| 12 | `data.skillMatch.missingMustHave: string[]` | `missing_must_have_skills: List<String>` | 直存 | P1 | 缺哪些 must-have 技能(对 hardRequirementGaps 更细) |
| 13 | `data.niceToHaveAnalysis.niceToHaveScore: number`(0-100)| `nice_to_have_score: Float` | 直存 | P1 | 加分项,排序辅助 |
| 14 | `data.skillMatchScore.score: number`(0-100)| `skill_match_score: Float` | 直存 | P1 | 技能维度评分(区别于总 match_score)|
| 15 | `data.skillMatchScore.credibilityFlags.hasRedFlags: boolean` | `has_credibility_red_flags: Boolean` | `Boolean(data.skillMatchScore?.credibilityFlags?.hasRedFlags)` | **P0** | ★ **简历可信度·主信号** — 漏 = 造假简历也通过 |
| 16 | `data.skillMatchScore.credibilityFlags.concerns: string[]` | `credibility_concerns: List<String>` | 直存 | P1 | 可信度疑点列表(主) |
| 16b | `data.skillMatchScore.credibilityFlags.positiveIndicators: string[]` | `credibility_positive_indicators: List<String>` | 直存 | P1 | ★ 简历可信度·正向迹象(量化业绩 / 证书 / 比赛 等)— UI 用绿色标签展示 |
| 17 | `data.candidatePotential.riskFactors: string[]` | `risk_factors: List<String>` | 直存 | P1 | 风险信号("跨行业"/"短在职" 等)|
| 17a | `data.experienceValidation.score: number`(0-100)| `experience_validation_score: Float` | 直存 | P1 | ★ 简历可信度·辅 1 — 经验声明是否站得住脚(score < 60 = 可疑)|
| 17b | `data.experienceValidation.relevanceToRole: string`("High"/"Medium"/"Low")| `experience_relevance: String` | 直存(枚举 3 档,可归一化)| P1 | 经验跟 JD 的真实相关度 |
| 18 | `data.workHistoryStability.score: number`(0-100)| `stability_score: Float` | 直存 | P1 | 工作稳定性 |
| 19 | `data.workHistoryStability.pattern: string` | `stability_pattern: String` | ★ **直存,不归一化**(实测自由文本:S1="Mostly Stable" / S2="Some Concerns",远不止 2 档枚举)| P1 | UI 展示 |
| 20 | `data.workHistoryStability.shortStintCount: number` | `short_stint_count: Integer` | 直存 | P1 | "频繁跳槽" 筛选(`> 2` 标红)|
| 21 | `data.workHistoryStability.averageTenureMonths: number` | `average_tenure_months: Integer` | 直存 | P1 | 平均任职时长 |
| 22 | `data.workHistoryStability.currentlyEmployed: boolean` | `currently_employed: Boolean` | 直存 | P1 | 在职状态筛选 |
| 22a | `data.workHistoryStability.currentGapFlagged: boolean` | `current_gap_flagged: Boolean` | 直存 | P1 | ★ 简历可信度·辅 2 — 当前 gap 是否被标记可疑(`true` = 简历时间线有问题)|
| 22b | `data.workHistoryStability.currentGapExplanation: string` | `current_gap_explanation: String` | 直存 | P1 | gap 的简历解释文本(可空字符串) |
| 22c | `data.workHistoryStability.concerns: string[]` | `stability_concerns: List<String>` | 直存 | P1 | ★ 简历时间线可疑点列表 |
| 22d | `data.workHistoryStability.mitigatingFactors: string[]` | `stability_mitigating_factors: List<String>` | 直存 | P1 | 减轻顾虑的因素(平衡 concerns) |
| 23 | `data.transferableSkills: Array<{required, candidateHas, relevance, valueFactor}>` | `transferable_skills: List<String>` | ★ 拍扁:`arr.map(t => \`${t.required} ← ${t.candidateHas}\`)` | P1 | 猎头看潜力;原对象数组进 `match_breakdown_json` 留底 |
| 24 | `requestId`(顶级,不在 `data` 里)| `raas_match_request_id: String` | 直存(格式 `req_xxx`)| P1 | 关联 RoboHire / RAAS 日志做 audit |
| (+) | mapper 加 timestamp | `decided_at: Timestamp` | `new Date().toISOString()` | P1 | 决策时间 |

##### C.3 大 JSON 块(Allmeta 加单一 String 字段装下)

剩余 ~17 个 RoboHire 字段(`matchAnalysis / niceToHaveAnalysis / resumeAnalysis / jdAnalysis / skillMatch / experienceMatch / experienceValidation / candidatePotential / experienceBreakdown / overallFit / recommendations / suggestedInterviewQuestions / areasToProbeDeeper / preferenceAlignment / candidateSummary`)— 都是大 Object 块,partner 仪表盘需要展示原文,但**不需要做结构化筛选**。

→ **★ Allmeta 加 `match_breakdown_json: String`**,AO mapper 把 `data` 整段 `JSON.stringify` 写进去。

##### C.4 Rule-check 审计字段(AO 自创,L3 完全没)

| AO 字段 | 处理 | 理由 |
|---|---|---|
| `rule_check_audit_id` | **★ Allmeta 加 `rule_check_audit_id: String`** | partner UI "为什么不通过" 必备入口 |
| `rule_check_decision: 'PASS'\|'FAIL'` | **★ Allmeta 加 `rule_check_decision: String`** | rule-check 阶段独立结论(跟 final_decision 分离)|
| `failure_reason_codes: string[]` | **★ Allmeta 加 `failure_reason_codes: List<String>`** | 结构化筛选(`MATCH WHERE "10-5" IN failure_reason_codes`)|
| `rules_evaluated_count: number` | ⚪ AO 内部 metric,留 Inngest event metadata,不进 ontology | 原则 ⑤:debug 用,低价值 |
| `terminal_rule_hits: string[]` | ⚪ 同上 | 同上 |
| `final_decision: 'PASS'\|'FAIL'` | ⚪ AO 内部,`result` 字段已表达 | 同上 |
| `final_decision_reason: string` | 🟡 AO 写到 `reason` 字段 | 跟 §C.1 #2 合并 |
| `parent_match_result_id: string` | ⚪ AO 内部 audit 链,留 Inngest | 原则 ⑤ |

##### C.5 AO mapper pluck/normalize 代码(基于 2026-05-14 两份样本实测,覆盖全部 24 字段)

★ §3.5 C.2 表里的字段全部要从嵌套对象拿,不能直接 `data.matchScore` / `data.recommendation` — mapper 完整写法如下:

```typescript
// resume-parser-agent/lib/mappers/ao-to-allmeta.ts
//
// 基于 2026-05-14 RoboHire /match-resume 两份真实样本:
//   S1: req_1778761416694_2md17dp · 秦嘉阔 → 商务BD · score=91 / verdict="Strong Match"
//   S2: req_1778761384956_30zzlng · "未提供" → 微信支付 · score=78 / verdict="Good Match"
// 两份样本顶级 19 keys 完全一致 — schema 已稳定。

import type { RaasMatchResumeData } from '../raas-api-client';

// ════════════════════════════════════════════════
//  枚举映射表(verdict 自然语言 → 4 档枚举 / 中文 3 档)
// ════════════════════════════════════════════════

const VERDICT_TO_RECOMMENDATION: Record<string, string> = {
  'Strong Match':   'STRONG_MATCH',
  'Good Match':     'GOOD_MATCH',
  'Partial Match':  'PARTIAL_MATCH',
  'Weak Match':     'WEAK_MATCH',
  'Not a Match':    'WEAK_MATCH',                    // 兜底
};

const VERDICT_TO_RESULT: Record<string, string> = {
  'Strong Match':   '匹配',
  'Good Match':     '匹配',
  'Partial Match':  '待定',
  'Weak Match':     '不匹配',
  'Not a Match':    '不匹配',
};

// ════════════════════════════════════════════════
//  Pluck 辅助函数 — 24 字段全覆盖
// ════════════════════════════════════════════════

// ─── 1. 总评分维度(score / grade / confidence / recommendation)───
function pluckMatchScore(data: RaasMatchResumeData): number | null {
  const raw = data.overallMatchScore?.score;
  return typeof raw === 'number' ? raw / 100 : null;  // 0-100 → 0-1
}
function pluckGrade(data: RaasMatchResumeData): string | null {
  return data.overallMatchScore?.grade ?? null;
}
function pluckConfidence(data: RaasMatchResumeData): string | null {
  return data.overallMatchScore?.confidence ?? null;
}
function pluckRecommendation(data: RaasMatchResumeData): string | null {
  const verdict = data.overallFit?.verdict;
  return verdict ? VERDICT_TO_RECOMMENDATION[verdict] ?? 'WEAK_MATCH' : null;
}

// ─── 2. 整体结论(result / reason / hiring_recommendation)───
function pluckResult(data: RaasMatchResumeData): string {
  const verdict = data.overallFit?.verdict;
  return verdict ? VERDICT_TO_RESULT[verdict] ?? '待定' : '待定';
}
function pluckReason(data: RaasMatchResumeData): string {
  return data.overallFit?.summary
      ?? data.mustHaveAnalysis?.gapAnalysis
      ?? '';
}
function pluckHiringRecommendation(data: RaasMatchResumeData): string | null {
  // ★ 直存自然语言,不归一化(vendor 值未穷尽)
  return data.overallFit?.hiringRecommendation ?? null;
}

// ─── 3. 硬性条件(disqualified / disqualification_reasons / must_have_score / must_have_gaps / missing_must_have_skills)───
function pluckDisqualified(data: RaasMatchResumeData): boolean {
  // ★ P0 — 漏掉 = 该 DQ 的人也进面试 pipeline
  return Boolean(data.mustHaveAnalysis?.disqualified);
}
function pluckDisqualificationReasons(data: RaasMatchResumeData): string[] {
  return data.mustHaveAnalysis?.disqualificationReasons ?? [];
}
function pluckMustHaveScore(data: RaasMatchResumeData): number | null {
  const raw = data.mustHaveAnalysis?.mustHaveScore;
  return typeof raw === 'number' ? raw : null;
}
function pluckMustHaveGaps(data: RaasMatchResumeData): string[] {
  return data.hardRequirementGaps ?? [];               // 顶级字段
}
function pluckMissingMustHaveSkills(data: RaasMatchResumeData): string[] {
  return data.skillMatch?.missingMustHave ?? [];
}

// ─── 4. 加分项(nice_to_have_score)───
function pluckNiceToHaveScore(data: RaasMatchResumeData): number | null {
  const raw = data.niceToHaveAnalysis?.niceToHaveScore;
  return typeof raw === 'number' ? raw : null;
}

// ─── 5. 技能 + 可信度·主信号(skill_match_score / has_credibility_red_flags / credibility_concerns / credibility_positive_indicators)───
function pluckSkillMatchScore(data: RaasMatchResumeData): number | null {
  const raw = data.skillMatchScore?.score;
  return typeof raw === 'number' ? raw : null;
}
function pluckHasCredibilityRedFlags(data: RaasMatchResumeData): boolean {
  // ★ P0 — 漏掉 = 造假简历也通过
  return Boolean(data.skillMatchScore?.credibilityFlags?.hasRedFlags);
}
function pluckCredibilityConcerns(data: RaasMatchResumeData): string[] {
  return data.skillMatchScore?.credibilityFlags?.concerns ?? [];
}
function pluckCredibilityPositiveIndicators(data: RaasMatchResumeData): string[] {
  // ★ 简历可信度·正向迹象(量化业绩 / 证书 / 比赛)— UI 用绿色标签
  return data.skillMatchScore?.credibilityFlags?.positiveIndicators ?? [];
}

// ─── 6. 风险信号(risk_factors)───
function pluckRiskFactors(data: RaasMatchResumeData): string[] {
  return data.candidatePotential?.riskFactors ?? [];
}

// ─── 6b. 经验有效性(可信度·辅 1)(experience_validation_score / experience_relevance)───
function pluckExperienceValidationScore(data: RaasMatchResumeData): number | null {
  // ★ 简历可信度·辅 1 — 经验声明是否站得住脚(< 60 = 可疑)
  const raw = data.experienceValidation?.score;
  return typeof raw === 'number' ? raw : null;
}
function pluckExperienceRelevance(data: RaasMatchResumeData): string | null {
  return data.experienceValidation?.relevanceToRole ?? null;
}

// ─── 7. 工作稳定性 + 时间线可信度(可信度·辅 2)(9 项)───
function pluckStabilityScore(data: RaasMatchResumeData): number | null {
  const raw = data.workHistoryStability?.score;
  return typeof raw === 'number' ? raw : null;
}
function pluckStabilityPattern(data: RaasMatchResumeData): string | null {
  // ★ 直存自由文本 — 实测见过 "Mostly Stable" / "Some Concerns",vendor 没枚举
  return data.workHistoryStability?.pattern ?? null;
}
function pluckShortStintCount(data: RaasMatchResumeData): number | null {
  const raw = data.workHistoryStability?.shortStintCount;
  return typeof raw === 'number' ? raw : null;
}
function pluckAverageTenureMonths(data: RaasMatchResumeData): number | null {
  const raw = data.workHistoryStability?.averageTenureMonths;
  return typeof raw === 'number' ? raw : null;
}
function pluckCurrentlyEmployed(data: RaasMatchResumeData): boolean | null {
  const raw = data.workHistoryStability?.currentlyEmployed;
  return typeof raw === 'boolean' ? raw : null;
}
function pluckCurrentGapFlagged(data: RaasMatchResumeData): boolean {
  // ★ 简历可信度·辅 2 — 当前 gap 被标记 = 简历时间线有问题
  return Boolean(data.workHistoryStability?.currentGapFlagged);
}
function pluckCurrentGapExplanation(data: RaasMatchResumeData): string {
  return data.workHistoryStability?.currentGapExplanation ?? '';
}
function pluckStabilityConcerns(data: RaasMatchResumeData): string[] {
  return data.workHistoryStability?.concerns ?? [];
}
function pluckStabilityMitigatingFactors(data: RaasMatchResumeData): string[] {
  return data.workHistoryStability?.mitigatingFactors ?? [];
}

// ─── 8. 可迁移技能(对象数组 → 拍扁 string[])───
function flattenTransferableSkills(data: RaasMatchResumeData): string[] {
  const arr = data.transferableSkills ?? [];
  return arr.map((t) => `${t.required} ← ${t.candidateHas}`);
}

// ─── 9. 边界 case — 候选人姓名"未提供"识别(给 :Candidate 用,不是 MR,但写一起)───
function pluckCandidateName(data: RaasMatchResumeData): string | null {
  const raw = (data.resumeAnalysis as any)?.candidateName as string | undefined;
  if (!raw || raw === '未提供' || raw === 'Not Provided' || raw === 'N/A') return null;
  return raw;
}

// ════════════════════════════════════════════════
//  主 mapper — toAllmetaMatchResult
// ════════════════════════════════════════════════

export function toAllmetaMatchResult(
  matchData: RaasMatchResumeData,
  ruleCheckAudit: RuleCheckAuditResult,
  context: {
    candidate_id: string;
    client_id: string;
    job_requisition_id: string;
    raas_match_request_id: string;
  },
): Record<string, unknown> {
  return {
    // ─── PK + FK (4) ───
    candidate_match_result_id: `cmr_${ruleCheckAudit.audit_id}`,
    client_id: context.client_id,
    candidate_id: context.candidate_id,
    job_requisition_id: context.job_requisition_id,

    // ─── 中文双结论 (2) ───
    result: pluckResult(matchData),
    reason: pluckReason(matchData),

    // ─── 总评分维度 (4) ───
    match_score:   pluckMatchScore(matchData),         // 0-1
    grade:         pluckGrade(matchData),
    confidence:    pluckConfidence(matchData),
    recommendation: pluckRecommendation(matchData),    // 枚举

    // ─── 录用建议 (1) ───
    hiring_recommendation: pluckHiringRecommendation(matchData),

    // ─── 硬性条件 (5) ───
    disqualified:             pluckDisqualified(matchData),              // ★ P0
    disqualification_reasons: pluckDisqualificationReasons(matchData),   // ★ P0
    must_have_score:          pluckMustHaveScore(matchData),
    must_have_gaps:           pluckMustHaveGaps(matchData),
    missing_must_have_skills: pluckMissingMustHaveSkills(matchData),

    // ─── 加分项 (1) ───
    nice_to_have_score: pluckNiceToHaveScore(matchData),

    // ─── 技能 + 可信度·主 (4) ───
    skill_match_score:               pluckSkillMatchScore(matchData),
    has_credibility_red_flags:       pluckHasCredibilityRedFlags(matchData),       // ★ P0
    credibility_concerns:            pluckCredibilityConcerns(matchData),
    credibility_positive_indicators: pluckCredibilityPositiveIndicators(matchData),

    // ─── 风险 (1) ───
    risk_factors: pluckRiskFactors(matchData),

    // ─── 经验有效性·可信度·辅 1 (2) ───
    experience_validation_score: pluckExperienceValidationScore(matchData),
    experience_relevance:        pluckExperienceRelevance(matchData),

    // ─── 稳定性·可信度·辅 2 (9) ───
    stability_score:                pluckStabilityScore(matchData),
    stability_pattern:              pluckStabilityPattern(matchData),
    short_stint_count:              pluckShortStintCount(matchData),
    average_tenure_months:          pluckAverageTenureMonths(matchData),
    currently_employed:             pluckCurrentlyEmployed(matchData),
    current_gap_flagged:            pluckCurrentGapFlagged(matchData),
    current_gap_explanation:        pluckCurrentGapExplanation(matchData),
    stability_concerns:             pluckStabilityConcerns(matchData),
    stability_mitigating_factors:   pluckStabilityMitigatingFactors(matchData),

    // ─── 可迁移技能(拍扁) (1) ───
    transferable_skills: flattenTransferableSkills(matchData),

    // ─── trace (2) ───
    raas_match_request_id: context.raas_match_request_id,
    decided_at: new Date().toISOString(),

    // ─── 大块原文留底 (1) ───
    match_breakdown_json: JSON.stringify(matchData),

    // ─── rule-check 审计 (3) ───
    rule_check_audit_id:  ruleCheckAudit.audit_id,
    rule_check_decision:  ruleCheckAudit.decision,
    failure_reason_codes: ruleCheckAudit.failure_reason_codes,
  };
}
```

**验证依据**:
- S1 `/tmp/robohire-probe/match-resume-2026-05-14.json`(秦嘉阔):`overallMatchScore.score=91 / verdict="Strong Match" / disqualified=false / hasRedFlags=false / stability.pattern="Mostly Stable" / averageTenureMonths=9`
- S2 `/tmp/robohire-probe/match-resume-sample2-2026-05-14.json`("未提供"):`overallMatchScore.score=78 / verdict="Good Match" / disqualified=false / hasRedFlags=false / stability.pattern="Some Concerns" / averageTenureMonths=6 / candidateName="未提供"`(★ edge case)

##### C.6 RoboHire `data.*` 顶级 19 keys 完整归属决策

```
RoboHire data.* (2026-05-14 实测稳定 19 keys)
  │
  ├── ★ 直接进 Allmeta MR(共 10 keys 派生 24 个 scalar 平铺字段)
  │   ├── overallMatchScore     → match_score / grade / confidence            (3)
  │   ├── overallFit             → recommendation / hiring_recommendation /
  │   │                            reason / result                              (4)
  │   ├── mustHaveAnalysis       → disqualified / disqualification_reasons /
  │   │                            must_have_score                              (3)
  │   ├── skillMatchScore        → skill_match_score / has_credibility_red_flags /
  │   │                            credibility_concerns                         (3)
  │   ├── workHistoryStability   → stability_score / stability_pattern /
  │   │                            short_stint_count / average_tenure_months /
  │   │                            currently_employed                            (5)
  │   ├── candidatePotential     → risk_factors                                 (1)
  │   ├── niceToHaveAnalysis     → nice_to_have_score                           (1)
  │   ├── skillMatch             → missing_must_have_skills                     (1)
  │   ├── transferableSkills     → transferable_skills(拍扁)                  (1)
  │   └── hardRequirementGaps    → must_have_gaps                               (1)
  │   ─────────────────────────────────────────────────────────────────────
  │                                                                   合计 24
  │
  ├── ⚪ 整段进 match_breakdown_json(9 keys,UI 直接读 JSON 渲染)
  │   ├── recommendations           (forRecruiter / forCandidate / interviewQuestions)
  │   ├── suggestedInterviewQuestions (technical / behavioral / redFlagProbing × 大对象)
  │   ├── areasToProbeDeeper        (priority / area / subAreas 大对象数组)
  │   ├── preferenceAlignment       (locationFit / salaryFit / ... 5 个子 fit)
  │   ├── experienceMatch           (required / candidate / yearsGap / assessment)
  │   ├── experienceValidation      (gaps / strengths / careerProgression)
  │   ├── experienceBreakdown       (跟 Candidate.work_years 重叠,只留 JSON)
  │   ├── resumeAnalysis            (candidateName 单独 sanity check,其他跟 :Candidate / :Resume 重叠)
  │   └── jdAnalysis                (跟 :Job_Requisition 重叠,debug RoboHire 是否读懂 JD)
  │
  └── ❌ 不进 MR(由其他 DataObject 持有)
      ├── resumeAnalysis.candidateName → :Candidate.name(用 pluckCandidateName 识别"未提供")
      ├── resumeAnalysis.technicalSkills + softSkills → :Resume.skill_tags(已在 §3.3)
      └── jdAnalysis.mustHaveSkills → :Job_Requisition.must_have_skills(已在 §3.4)
```

**决策原则总结**:
- 进单独字段 = 需要做"`WHERE x = ?`"或"`ORDER BY x DESC`"的查询
- 进 `match_breakdown_json` = 只需要"打开候选人 drawer 看详情"的展示
- 不进 MR = 已经在别的 DataObject 表达过的数据(避免冗余)

##### C.7 AO mapper 边界 case 防御策略

实测发现 vendor 响应有 4 类不规则数据,mapper 必须显式处理:

| # | 不规则现象 | 实测样本 | mapper 防御 |
|---|---|---|---|
| 1 | `data.matchScore` / `data.recommendation` / `data.summary` 顶级永远 === null | S1 + S2 都是 | typing 改成 `matchScore: null`,**禁止读顶级**,只 pluck 嵌套(§3.5 C.5) |
| 2 | `resumeAnalysis.candidateName === "未提供"`(中文字面量) | S2 | `pluckCandidateName` 显式识别 `"未提供"` / `"Not Provided"` / `"N/A"` → null |
| 3 | `overallFit.verdict` 是自然语言(`"Strong Match"` 而非 `STRONG_MATCH` 枚举) | S1 + S2 | `VERDICT_TO_RECOMMENDATION` 表归一化;表里没有的值 fallback 到 `WEAK_MATCH`(保守判定) |
| 4 | `workHistoryStability.pattern` 是自由文本(`"Mostly Stable"` / `"Some Concerns"` 等) | S1 + S2 不同 | ★ **不归一化**,直存 raw String — vendor 没穷尽枚举,强行归一化会丢失信息 |
| 5 | `hiringRecommendation` 实测只见 2 种值(`"Strongly Recommend"` / `"Recommend"`),vendor 可能还有更多 | S1 + S2 | ★ 同上,直存 raw String,不预设枚举 |
| 6 | `transferableSkills` 是对象数组,不是 string[](typing 之前错的)| S1 + S2 | `flattenTransferableSkills` 拍扁成 `${required} ← ${candidateHas}` 写 Allmeta,原对象进 JSON 留底 |

##### C.8 rule-check 应消费 `disqualified` flag(隐含改动,不在本文范围但点一下)

★ RoboHire 已经判定 `disqualified === true` 的候选人,**rule-check pipeline 不应该再跑 LLM 浪费 token** — [scripts/rule-check-poc/pipeline.ts](../../scripts/rule-check-poc/pipeline.ts) 入口加一道前置检查:

```typescript
if (matchData.mustHaveAnalysis?.disqualified === true) {
  return {
    decision: 'FAIL',
    failure_reason_codes: ['robohire_disqualified'],
    failure_reason_messages: matchData.mustHaveAnalysis.disqualificationReasons,
    // 跳过 LLM
  };
}
```

类似 `has_credibility_red_flags === true` 也可以做"标红但不阻塞"处理。具体落 rule-check 流程改动,后续 sprint 跟进。

##### C.9 简历可信度 — 复合信号模型(★ 跨多字段)

★ **核心认知**:RoboHire 的"简历可信度"**不是单一字段**,而是分散在 6 个位置的复合信号。partner 仪表盘做"标记可疑简历"功能时不应只看一个 boolean,要复合查询。

**6 个可信度信号源(实测全部映射到 Allmeta 字段)**:

| # | 信号位置 | RoboHire 路径 | Allmeta MR 字段 | 在 MR 中的角色 |
|---|---|---|---|---|
| 主 | 整体造假旗 | `data.skillMatchScore.credibilityFlags.hasRedFlags` | `has_credibility_red_flags: Boolean` | ★ P0 主开关 |
| 主 | 可疑点 | `data.skillMatchScore.credibilityFlags.concerns` | `credibility_concerns: List<String>` | 细节 |
| 主 | 正向迹象 | `data.skillMatchScore.credibilityFlags.positiveIndicators` | `credibility_positive_indicators: List<String>` | 反向证据 |
| 辅 1 | 经验有效性评分 | `data.experienceValidation.score` | `experience_validation_score: Float` | 经验是否站得住脚 |
| 辅 1 | 经验相关度 | `data.experienceValidation.relevanceToRole` | `experience_relevance: String` | "High"/"Medium"/"Low" |
| 辅 2 | 当前 gap 旗 | `data.workHistoryStability.currentGapFlagged` | `current_gap_flagged: Boolean` | 时间线可疑 |
| 辅 2 | 时间线可疑点 | `data.workHistoryStability.concerns` | `stability_concerns: List<String>` | 细节 |
| 辅 3 | 短在职次数 | `data.workHistoryStability.shortStintCount` | `short_stint_count: Integer` | `> 2` = 频繁跳槽 |
| 辅 4 | 风险因素 | `data.candidatePotential.riskFactors` | `risk_factors: List<String>` | 部分项跟可信度有关 |
| JSON | 面试红旗 | `data.areasToProbeDeeper[].subAreas[].redFlags` | (留 `match_breakdown_json`) | 面试官观察清单 |
| JSON | 面试探问 | `data.suggestedInterviewQuestions.redFlagProbing` | (留 `match_breakdown_json`) | 验证可信度的问题 |
| JSON | 技能引用证据 | `data.mustHaveAnalysis.candidateEvaluation.matchedSkills[].candidateEvidence` | (留 `match_breakdown_json`) | 隐含可信度(RoboHire 编不出来) |

**partner UI / 仪表盘的"标红可疑简历"复合查询**(Cypher):

```cypher
// 标记可信度可疑的候选人(任一硬信号 + 软信号阈值)
MATCH (mr:Candidate_Match_Result {domainId: 'RAAS-v1'})
WHERE
  // ─── 硬信号(命中其一就标红)───
  mr.has_credibility_red_flags = true                      // RoboHire 直接判定造假
  OR mr.current_gap_flagged = true                         // 当前 gap 被标记可疑
  OR size(mr.credibility_concerns) > 0                     // 有任何可疑点
  // ─── 软信号(命中多项才标红)───
  OR (mr.experience_validation_score < 60                  // 经验声明站不住 +
      AND mr.short_stint_count > 2)                        // 同时频繁跳槽
RETURN mr.candidate_match_result_id, mr.candidate_id,
       mr.has_credibility_red_flags,
       mr.credibility_concerns,
       mr.experience_validation_score,
       mr.short_stint_count
ORDER BY mr.match_score DESC;
```

**rule-check 应该消费可信度复合信号**(隐含改动,扩 §3.5 C.8):

```typescript
// 在 rule-check 入口短路逻辑里:
const isHighlyDubious =
  matchData.skillMatchScore?.credibilityFlags?.hasRedFlags === true ||
  matchData.workHistoryStability?.currentGapFlagged === true ||
  (matchData.experienceValidation?.score < 50 && matchData.workHistoryStability?.shortStintCount > 2);

if (isHighlyDubious) {
  // 不直接 FAIL,但标记 needs_human_review
  // (单看 hasRedFlags=true 会过度严格,综合判定才合理)
  return {
    decision: 'FLAG_FOR_REVIEW',
    failure_reason_codes: ['credibility_composite_dubious'],
    // 同时把命中的具体信号写到 reason
  };
}
```

**为什么不算 `credibility_score: Float` 派生字段?**
- 各信号权重 vendor 没给,自己拍脑袋权重容易引战
- partner UI 可能想自己定义权重(投行 vs 互联网公司接受度不同)
- 6 个 raw 信号都存进去后,UI / rule-check / 复合查询都自由组合,比 mapper 端硬算一个 0-1 数字健壮
- 如果将来想加 derived score,加在 UI 层就好,不进 ontology

---

#### ★ 3.5.X v0_1_010 终稿 — Candidate_Match_Result(8 字段,极简版)

★ **核心决策**:MR 节点**极简化**,所有复杂可信度信号 / rule-check 审计 / 大块 breakdown **都不进 Neo4j**:
- ✅ Allmeta MR = "匹配结论"4 字段(score / verdict / summary / grade)
- ✅ rule-check 详细审计 → **AO Prisma SQLite `RuleCheckAudit` 表**(已有)
- ✅ RoboHire 原始 `match-resume` 响应 → **RAAS 私有 DB 留底**
- ✅ partner 需要详情 → 经 `raas_match_request_id` 反查 RAAS,不经 Neo4j

**Allmeta DataObject(SSoT:[objects_v0_1_010.json:Candidate_Match_Result](../data/objects_v0_1_010.json))**

```typescript
type AllmetaCandidateMatchResult_v0_1_010 = {
  candidate_match_result_id: string;             // PK
  client_id: string;                             // FK→Client
  candidate_id: string;                          // FK→Candidate
  job_position_id: string;                       // FK→Job_Requisition(★ 字段名保留 job_position_id 不改)
  overall_match_score: float;                    // ★ 新增 — RoboHire data.overallMatchScore.score(0-100 整数直存,不归一化)
  overall_fit_verdict: string;                   // ★ 新增 — RoboHire data.overallFit.verdict(★ 自然语言直存"Strong Match"等,不归一化枚举)
  overall_fit_summary: string;                   // ★ 新增 — RoboHire data.overallFit.summary(1-2 句话)
  overall_match_grade: string;                   // ★ 新增 — RoboHire data.overallMatchScore.grade("A"/"B+"/...)
};
```

**只 8 个字段**,字段名直接跟 RoboHire 嵌套路径扁平化对齐:
- `overallMatchScore.score` → `overall_match_score`
- `overallFit.verdict` → `overall_fit_verdict`
- `overallFit.summary` → `overall_fit_summary`
- `overallMatchScore.grade` → `overall_match_grade`

**AO mapper 写入 payload(v0_1_010)**

```typescript
// resume-parser-agent/lib/mappers/ao-to-allmeta.ts (v0_1_010 — 极简版)
export function toAllmetaMatchResult(
  matchData: RaasMatchResumeData,                 // RoboHire /match-resume 整段 data
  context: {
    candidate_id: string;
    client_id: string;
    job_requisition_id: string;                   // ★ 注意:context 用 job_requisition_id,但 Allmeta 字段叫 job_position_id
  },
): Record<string, unknown> {
  return {
    candidate_match_result_id: `cmr_${context.candidate_id}_${context.job_requisition_id}_${Date.now()}`,
    client_id: context.client_id,
    candidate_id: context.candidate_id,
    job_position_id: context.job_requisition_id,  // ★ Allmeta 字段叫 job_position_id 但语义是 job_requisition_id

    overall_match_score:  Number(matchData.overallMatchScore?.score) || 0,   // 0-100 直存
    overall_fit_verdict:  matchData.overallFit?.verdict ?? '',               // ★ 自然语言"Strong Match"等
    overall_fit_summary:  matchData.overallFit?.summary ?? '',
    overall_match_grade:  matchData.overallMatchScore?.grade ?? '',
  };
}
```

**全部否决的早期提案**(留 §3.5 主体讨论作为决策过程档案):

| 类别 | 否决字段 | 改放哪里 |
|---|---|---|
| 算法分级归一化 | `recommendation: STRONG_MATCH/GOOD_MATCH/...` 枚举 | ❌ 不要 — verdict 自然语言直存,UI 自己转 |
| 中文结论 | `result: "匹配"/"待定"/"不匹配"` | ❌ 不要 — UI 从 verdict 派生 |
| RoboHire 推荐 | `hiring_recommendation: "Strongly Recommend"` | ❌ 不要 — 进 RAAS 留底 |
| DQ flag | `disqualified` / `disqualification_reasons` | ❌ 不要 — rule-check pipeline 内部处理,不进 ontology |
| 信誉旗 | `has_credibility_red_flags` / `credibility_concerns` / `credibility_positive_indicators` | ❌ 不要 — 进 RAAS 留底 |
| 经验有效性 | `experience_validation_score` / `experience_relevance` | ❌ 不要 — 进 RAAS 留底 |
| 风险 | `risk_factors` / `must_have_gaps` / `transferable_skills` | ❌ 不要 — 进 RAAS 留底 |
| 工作稳定性 | `stability_*` 9 字段(score / pattern / shortStint / currentGap 等)| ❌ 不要 — 进 RAAS 留底 |
| rule-check 审计 | `rule_check_audit_id` / `rule_check_decision` / `failure_reason_codes` | ✅ **改放 AO Prisma SQLite `RuleCheckAudit`** 表(已存在),通过 `candidate_match_result_id` 链回 MR |
| 大块原文 | `match_breakdown_json` | ❌ 不要 — RoboHire 原响应 RAAS DB 留底,partner 经 `requestId` 反查 |
| trace | `raas_match_request_id` / `decided_at` | ❌ 不要(★ 但 AO 事件 metadata 仍带,作为 audit) |

**rule-check 审计 → AO Prisma 持久化**

```typescript
// app/api/rule-check-audits/route.ts(已存在)— 写入 SQLite
await prisma.ruleCheckAudit.create({
  data: {
    audit_id: ulid(),
    candidate_match_result_id: mrId,           // 链回 Neo4j MR 节点
    candidate_id: ctx.candidate_id,
    job_requisition_id: ctx.job_requisition_id,
    decision: 'PASS' | 'FAIL' | 'NEEDS_REVIEW',
    failure_reason_codes: [...],
    rules_evaluated: [...],
    llm_raw_output: '...',
    decided_at: new Date(),
  },
});
```

partner / drawer UI 要看"为什么匹配通过/失败"时:
1. 从 Allmeta 读 `:Candidate_Match_Result` (4 字段结论)
2. 拿 `candidate_match_result_id` 调 AO `GET /api/rule-check-audits?cmr_id=...` 拿审计详情
3. 拿 raas_match_request_id 调 RAAS `GET /match-results/:requestId` 拿 RoboHire 大块 breakdown

---

## 4. 总改动清单 — 给两边的 diff

### ★ 4.0 v0_1_010 终稿改动清单(以此为准,§4.1-§4.2 是早期方案档案)

**Allmeta 端(陈洋)— 最终 16 处动作**

#### 改名(3 项,跟 RoboHire vendor 名)

| DataObject | 现 | 改成 |
|---|---|---|
| Candidate | `mobile` | **`phone`** |
| Candidate | `current_location` | **`address`** |
| Candidate | `experience_years` | **`work_years`** |
| Candidate | `marital_fertility_status` | **`marital_status`** |
| Candidate | `conflict_interest_declaration` | **`conflict_of_interest_declaration`** |
| Candidate_Expectation | `expected_position / location / industry` | **`expected_positions / locations / industries`**(类型仍 String) |
| Resume | `work_experience` | **`experience`** |
| Resume | `project_experience` | **`projects`** |
| Resume | `education_experience` | **`education`** |
| Resume | `language_skills` | **`languages`** |
| Resume | `skill_tags` | **`skills`** |
| Resume | `certificate` | **`certifications`** |

#### 加字段(13 项)

| DataObject | 字段 | 类型 |
|---|---|---|
| Candidate | `github` | String |
| Candidate | `ethnicity` | String |
| Candidate | `native_place` | String |
| Candidate_Expectation | `expected_work_mode` | String |
| Resume | `portfolio` | String |
| Resume | `publications` | String |
| Resume | `patents` | String |
| Resume | `awards` | String |
| Resume | `summary` | String |
| Candidate_Match_Result | `overall_match_score` | Float |
| Candidate_Match_Result | `overall_fit_verdict` | String |
| Candidate_Match_Result | `overall_fit_summary` | String |
| Candidate_Match_Result | `overall_match_grade` | String |

#### 不动(明确否决的早期提案)

- ❌ Job_Requisition 完全不动(5 改名 / 2 类型 / 拆 salary 全否)
- ❌ MR 复合可信度信号 26 字段(disqualified / has_credibility_red_flags / risk_factors / stability_* / experience_validation_* / credibility_*)— 全部不进 Allmeta,留 RAAS / AO Prisma
- ❌ Expectation salary 拆 min/max — 保 String
- ❌ List<String> 类型化(positions / locations / industries)— 保 String,多值用分隔符
- ❌ Candidate.linkedin / portfolio / summary / current_company / current_title — 全不加
- ❌ Resume.upload_id / current_company / current_title / additional_sections_json — 全不加

**AO 端(Steven)— 最终动作**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `resume-parser-agent/lib/inngest/client.ts` | `CandidateNested` / `CandidateExpectationNested` / `ResumeNested` 全部按 v0_1_010 终稿改;**删除** `RuntimeNested` |
| 2 | `resume-parser-agent/lib/mappers/ao-to-allmeta.ts`(新文件)| 5 个 mapper:`toAllmetaCandidate / Expectation / Resume / JR / MatchResult`(代码骨架见各 §3.x.X 终稿子节)|
| 3 | `lib/allmeta-client.ts`(新文件,根 AO 项目)| Allmeta API HTTP client(POST `/api/v1/ontology/instances/{label}?domain=RAAS-v1` + 错误处理)|
| 4 | `resume-parser-agent/lib/raas-api-client.ts` | `RaasMatchResumeData` typing 修正(嵌套对象 typing,见 §3.5 (e))|
| 5 | (可选)`scripts/rule-check-poc/pipeline.ts` 入口 | 加 `disqualified === true` 短路(隐含改动,不阻塞 v0_1_010 上线)|

---

### 4.1 Allmeta 端(陈洋)— `properties_json` 改动(早期方案,以 §4.0 为准)

#### 改名(15 项)

| DataObject | 现在 | 改成 | 优先级 |
|---|---|---|---|
| Candidate | `experience_years` | `work_years` | P1 |
| Candidate | `marital_fertility_status` | `family_status` | P3 |
| Candidate | `conflict_interest_declaration` | `conflict_of_interest_declaration` | P3 |
| Candidate_Expectation | `expected_position` | `expected_positions`(配套类型 String → List<String>) | P2 |
| Candidate_Expectation | `expected_location` | `expected_locations`(配套 String → List<String>) | P2 |
| Candidate_Expectation | `expected_industry` | `expected_industries`(配套 String → List<String>) | P2 |
| Resume | `work_experience` | `work_history` | P2 |
| Resume | `education_experience` | `education_history` | P2 |
| Resume | `project_experience` | `project_history` | P2 |
| Job_Requisition | `open_date` | `publish_date` | P3 |
| Job_Requisition | `required_arrival_date` | `expected_arrival_date` | P3 |
| Job_Requisition | `csi_department_id` | `recruiting_department_id` | P3 |
| Job_Requisition | `hc_status` | `headcount_status` | P3 |
| Job_Requisition | `expected_level` | `target_job_level` | P3 |
| Candidate_Match_Result | `job_position_id` | `job_requisition_id` | **P0(MR 链路必经)** |

#### 改类型(2 项)

| DataObject | 字段 | 现在 | 改成 |
|---|---|---|---|
| Candidate_Expectation | `expected_position/location/industry` | `String` | `List<String>`(配合上面改名)|
| Job_Requisition | `city` | `String` | `List<String>` |

#### 拆字段(2 处)

| DataObject | 现字段 | 拆成 |
|---|---|---|
| Candidate_Expectation | `expected_salary_range: String` | `expected_salary_monthly_min: Float` + `expected_salary_monthly_max: Float` + `salary_currency: String`(保留原 `expected_salary_range: String` 兼容)|
| Job_Requisition | `salary_range: String` | `salary_range_monthly_min: Float` + `salary_range_monthly_max: Float` + `salary_currency: String`(保留 `salary_range`)|

#### 加字段(22 项,2026-05-14 更新)

| DataObject | 新字段 | 类型 | 优先级 | 用途 |
|---|---|---|---|---|
| Candidate | `linkedin` | String | P1 | RoboHire 顶级直返 |
| Candidate | `github` | String | P1 | RoboHire 顶级直返 |
| Candidate | `portfolio` | String | P1 | RoboHire 顶级直返 |
| Candidate | `summary` | String | P1 | RoboHire 顶级直返(候选人画像)|
| Candidate | `ethnicity` | String | P2 | 派生自 RoboHire.otherSections.个人信息补充 "民族" |
| Candidate | `native_place` | String | P2 | 派生自 RoboHire.otherSections.个人信息补充 "籍贯" |
| Candidate_Expectation | `expected_work_mode` | String | P2 | 远程/混合/onsite |
| Resume | `summary` | String | P2 | (跟 Candidate.summary 冗余,或只放 Candidate)|
| Resume | `upload_id` | String | P2 | MinIO 上传主键 |
| **Resume** | **`current_company`** | **String** | **P1** | **★ 改放 Resume(原 Candidate 移过来)— RoboHire experience[0].company 派生快照** |
| **Resume** | **`current_title`** | **String** | **P1** | **★ 改放 Resume — RoboHire experience[0].role 派生快照** |
| Resume | `additional_sections_json` | String | P2 | RoboHire 低用率数组合并(awards/volunteerWork/publications/patents)|
| Candidate_Match_Result | `match_score` | Float | **P0** | 评分核心 metric |
| Candidate_Match_Result | `recommendation` | String | **P0** | RoboHire 4 档算法分级 |
| Candidate_Match_Result | `match_breakdown_json` | String | **P0** | RoboHire data 整段透传 |
| Candidate_Match_Result | `must_have_gaps` | List<String> | P1 | 硬性条件不达标筛选 |
| Candidate_Match_Result | `transferable_skills` | List<String> | P1 | 可迁移技能 |
| Candidate_Match_Result | `raas_match_request_id` | String | P1 | RoboHire 跨服务 trace |
| Candidate_Match_Result | `decided_at` | Timestamp | P1 | 决策时间 |
| Candidate_Match_Result | `rule_check_audit_id` | String | **P0** | partner UI 入口 |
| Candidate_Match_Result | `rule_check_decision` | String | P1 | rule-check 阶段独立结论 |
| Candidate_Match_Result | `failure_reason_codes` | List<String> | P1 | 失败原因代码 |
| Candidate_Match_Result | `hiring_recommendation` | String | P1 | 2026-05-14 实测加 — RoboHire `data.overallFit.hiringRecommendation`("Strongly Recommend" 等自然语言)|
| Candidate_Match_Result | `must_have_score` | Float | **P0** | 2026-05-14 实测加 — RoboHire `data.mustHaveAnalysis.mustHaveScore`(0-100,做硬性命中筛)|
| Candidate_Match_Result | `stability_score` | Float | P1 | 2026-05-14 实测加 — RoboHire `data.workHistoryStability.score`(工作稳定性)|
| Candidate_Match_Result | `stability_pattern` | String | P1 | 2026-05-14 实测加 — RoboHire `data.workHistoryStability.pattern`(自由文本,★ 不归一化)|
| Candidate_Match_Result | `grade` | String | P1 | ★ 2026-05-14 二轮实测加 — RoboHire `data.overallMatchScore.grade`("A"/"B+"/...) UI 字母级 |
| Candidate_Match_Result | `confidence` | String | P1 | ★ 2026-05-14 二轮实测加 — RoboHire `data.overallMatchScore.confidence`("High"/"Medium"/"Low") |
| Candidate_Match_Result | **`disqualified`** | **Boolean** | **P0** | ★ 2026-05-14 二轮实测加 — RoboHire `data.mustHaveAnalysis.disqualified` — 漏 = DQ 候选人也进面试 |
| Candidate_Match_Result | `disqualification_reasons` | List<String> | **P0** | ★ 同上 — `data.mustHaveAnalysis.disqualificationReasons` |
| Candidate_Match_Result | `missing_must_have_skills` | List<String> | P1 | ★ 2026-05-14 二轮实测加 — RoboHire `data.skillMatch.missingMustHave`(对 `must_have_gaps` 更细)|
| Candidate_Match_Result | `nice_to_have_score` | Float | P1 | ★ 2026-05-14 二轮实测加 — RoboHire `data.niceToHaveAnalysis.niceToHaveScore` |
| Candidate_Match_Result | `skill_match_score` | Float | P1 | ★ 2026-05-14 二轮实测加 — RoboHire `data.skillMatchScore.score`(技能维度评分)|
| Candidate_Match_Result | **`has_credibility_red_flags`** | **Boolean** | **P0** | ★ 2026-05-14 二轮实测加 — `data.skillMatchScore.credibilityFlags.hasRedFlags` — 漏 = 造假简历也通过 |
| Candidate_Match_Result | `credibility_concerns` | List<String> | P1 | ★ 2026-05-14 二轮实测加 — `data.skillMatchScore.credibilityFlags.concerns` |
| Candidate_Match_Result | `risk_factors` | List<String> | P1 | ★ 2026-05-14 二轮实测加 — `data.candidatePotential.riskFactors` |
| Candidate_Match_Result | `short_stint_count` | Integer | P1 | ★ 2026-05-14 二轮实测加 — `data.workHistoryStability.shortStintCount`(频繁跳槽筛 `> 2` 标红) |
| Candidate_Match_Result | `average_tenure_months` | Integer | P1 | ★ 2026-05-14 二轮实测加 — `data.workHistoryStability.averageTenureMonths` |
| Candidate_Match_Result | `currently_employed` | Boolean | P1 | ★ 2026-05-14 二轮实测加 — `data.workHistoryStability.currentlyEmployed` |
| Candidate_Match_Result | `credibility_positive_indicators` | List<String> | P1 | ★ 2026-05-14 三轮(简历可信度复合模型)— `data.skillMatchScore.credibilityFlags.positiveIndicators` — UI 用绿色标签 |
| Candidate_Match_Result | `experience_validation_score` | Float | P1 | ★ 简历可信度·辅 1 — `data.experienceValidation.score`(<60 = 可疑)|
| Candidate_Match_Result | `experience_relevance` | String | P1 | ★ 简历可信度·辅 1 — `data.experienceValidation.relevanceToRole`("High"/"Medium"/"Low")|
| Candidate_Match_Result | `current_gap_flagged` | Boolean | P1 | ★ 简历可信度·辅 2 — `data.workHistoryStability.currentGapFlagged`(true = 时间线可疑)|
| Candidate_Match_Result | `current_gap_explanation` | String | P1 | 简历可信度·辅 2 — `data.workHistoryStability.currentGapExplanation` |
| Candidate_Match_Result | `stability_concerns` | List<String> | P1 | ★ 简历时间线可疑点 — `data.workHistoryStability.concerns` |
| Candidate_Match_Result | `stability_mitigating_factors` | List<String> | P1 | 减轻顾虑因素 — `data.workHistoryStability.mitigatingFactors` |

#### Allmeta 端总改动:**15 改名 + 2 改类型 + 2 拆字段 + 46 加字段 = 65 处**

> **MR 节点单独总计**:Allmeta `Candidate_Match_Result` 从原 6 字段 → **40 字段**(+34 加字段:P0:7 + P1:25 + P2:2)。详情见 §3.5 (c);简历可信度复合模型见 §3.5 C.9。

---

### 4.2 AO 端(Steven)— mapper 改动

新建 [`resume-parser-agent/lib/mappers/ao-to-allmeta.ts`](../../resume-parser-agent/lib/mappers/ao-to-allmeta.ts) 集中 L2 → L3 翻译。

#### Candidate 写入 mapper

```typescript
// 输入:CandidateNested (L2)
// 输出:Allmeta Candidate properties_json 合规的 payload
export function toAllmetaCandidate(
  c: CandidateNested,
  candidate_id: string,
): Record<string, unknown> {
  return {
    candidate_id,
    name: c.name,
    mobile: c.mobile,
    email: c.email,
    gender: c.gender,                  // null OK,Allmeta 接受 null
    birth_date: c.birth_date,
    current_location: c.current_location,
    highest_acquired_degree: c.highest_acquired_degree,
    work_years: c.work_years,          // ★ Allmeta 改名后对齐
    current_company: c.current_company, // ★ Allmeta 加字段后对齐
    current_title: c.current_title,
    // ★ skills 不写 Candidate,只写 Resume.skill_tags(见 toAllmetaResume)
  };
}
```

#### Candidate_Expectation 写入 mapper

```typescript
export function toAllmetaCandidateExpectation(
  e: CandidateExpectationNested,
  candidate_id: string,
): Record<string, unknown> {
  return {
    candidate_expectation_id: `ce_${candidate_id}`,
    candidate_id,
    expected_salary_monthly_min: e.expected_salary_monthly_min, // ★ Allmeta 拆字段后对齐
    expected_salary_monthly_max: e.expected_salary_monthly_max,
    salary_currency: 'CNY',  // 默认人民币
    expected_locations: e.expected_cities,    // ★ 改字段名 + 类型对齐
    expected_industries: e.expected_industries,
    expected_positions: e.expected_roles,     // ★ AO 改名 expected_roles → expected_positions
    expected_work_mode: e.expected_work_mode, // ★ Allmeta 加字段后对齐
    // outsourcing_acceptance_level 不写,留给 hsm 填
  };
}
```

#### Resume 写入 mapper

```typescript
export function toAllmetaResume(
  r: ResumeNested,
  candidate_id: string,
  upload_id: string,
  file_path: string,
): Record<string, unknown> {
  return {
    resume_id: `R_${upload_id}`,
    candidate_id,
    upload_id,                                          // ★ Allmeta 加字段后对齐
    file_path,
    is_original: true,
    summary: r.summary,                                 // ★ Allmeta 加字段后对齐
    skill_tags: r.skills_extracted,                     // ★ AO 改名 skills_extracted → skill_tags
    work_history: JSON.stringify(r.work_history),       // ★ Object[] → String,Allmeta 改名后对齐
    education_history: JSON.stringify(r.education_history),
    project_history: JSON.stringify(r.project_history),
    // certificate / language_skills 等 RoboHire 给但当前 ResumeNested 没装的字段,后续 mapper 补
  };
}
```

#### Job_Requisition 写入 mapper(从 RAAS 64 字段投影)

```typescript
export function toAllmetaJobRequisition(
  raas: RaasRequirement,            // 来自 getRequirementDetail
  spec: RaasRequirementSpecification,
): Record<string, unknown> {
  // 解析 salary_range "1-1.5万/月" → min/max
  const { min, max, currency } = parseSalaryRange(raas.salary_range);

  return {
    job_requisition_id: raas.job_requisition_id,
    job_requisition_specification_id: raas.job_requisition_specification_id,
    client_department_id: raas.client_department_id,
    client_job_id: raas.client_job_id,
    client_job_title: raas.client_job_title,
    client_job_type: raas.client_job_type,
    job_responsibility: raas.job_responsibility,
    job_requirement: raas.job_requirement,
    must_have_skills: raas.must_have_skills,
    nice_to_have_skills: raas.nice_to_have_skills,
    negative_requirement: raas.negative_requirement,
    language_requirements: raas.language_requirements,
    city: Array.isArray(raas.city) ? raas.city : [raas.city], // ★ Allmeta 改类型后对齐
    salary_range: raas.salary_range,            // 保留兼容
    salary_range_monthly_min: min,              // ★ 拆数值
    salary_range_monthly_max: max,
    salary_currency: currency,
    headcount: raas.headcount,
    work_years: raas.work_years,
    degree_requirement: raas.degree_requirement,
    education_requirement: raas.education_requirement,
    interview_mode: raas.interview_mode,
    target_job_level: raas.expected_level,      // ★ AO 改字段名(如果 Allmeta 改名)
    recruitment_type: raas.recruitment_type,
    publish_date: raas.publish_date,            // ★ Allmeta 改名后对齐
    expected_arrival_date: raas.expected_arrival_date,
    // ★ 丢弃:status / hc_status / priority / created_at 等流程态字段
    // ★ 不写:client_id / client_name / hsm_employee_id 等冗余,走 FK 链
  };
}
```

#### Candidate_Match_Result 写入 mapper

★ **完整实现见 [§3.5 C.5](#c5-ao-mapper-plucknormalize-代码基于-2026-05-14-实测)**(基于 2026-05-14 直连 RoboHire 实测)。简化轮廓如下,真实字段路径 / pluck 函数 / 归一化映射表都在 §3.5 C.5:

```typescript
export function toAllmetaMatchResult(
  matchData: Record<string, unknown>,  // RoboHire /match-resume 整段 data(顶级 19 keys)
  ruleCheckAudit: RuleCheckAuditResult,
  context: { candidate_id: string; client_id: string; job_requisition_id: string; raas_match_request_id: string },
): Record<string, unknown> {
  return {
    candidate_match_result_id: `cmr_${ruleCheckAudit.audit_id}`,
    client_id: context.client_id,
    candidate_id: context.candidate_id,
    job_requisition_id: context.job_requisition_id,

    // ⚠️ 不能直接 matchData.matchScore — 实测 === null。必须 pluck 嵌套(见 §3.5 C.5)
    match_score:           pluckMatchScore(matchData),         // data.overallMatchScore.score / 100
    recommendation:        pluckRecommendation(matchData),     // data.overallFit.verdict → 枚举
    hiring_recommendation: (matchData.overallFit as any)?.hiringRecommendation,
    result:                pluckResult(matchData),             // → 中文 3 档
    reason:                pluckReason(matchData),             // data.overallFit.summary

    must_have_gaps:        (matchData.hardRequirementGaps as string[]) ?? [],
    transferable_skills:   flattenTransferableSkills(matchData),  // 拍扁对象数组
    must_have_score:       Number((matchData.mustHaveAnalysis as any)?.mustHaveScore) || null,
    stability_score:       Number((matchData.workHistoryStability as any)?.score) || null,
    stability_pattern:     (matchData.workHistoryStability as any)?.pattern ?? null,

    raas_match_request_id: context.raas_match_request_id,
    decided_at:            new Date().toISOString(),
    match_breakdown_json:  JSON.stringify(matchData),

    rule_check_audit_id:   ruleCheckAudit.audit_id,
    rule_check_decision:   ruleCheckAudit.decision,
    failure_reason_codes:  ruleCheckAudit.failure_reason_codes,
  };
}
```

#### AO 端总改动:**1 个新文件 `lib/mappers/ao-to-allmeta.ts`(5 个 mapper)+ 1 个新 client `lib/allmeta-client.ts`(POST API 调用) ≈ 6-8 小时**

---

## 5. 实施顺序与上线检查清单

### ★ 5.0 v0_1_010 终稿实施清单(以此为准,§5.1-§5.5 是早期方案档案)

**Phase 1 — Allmeta 端 properties_json 改完(陈洋,2h)**

| # | DataObject | 动作 |
|---|---|---|
| 1 | Candidate | 改名 5 字段(mobile/current_location/experience_years/marital_fertility_status/conflict_interest_declaration)+ 加 3 字段(github/ethnicity/native_place)|
| 2 | Candidate_Expectation | 改名 3 字段(positions/locations/industries 复数化)+ 加 1 字段(expected_work_mode)|
| 3 | Resume | 改名 6 字段(experience/projects/education/languages/skills/certifications)+ 加 5 字段(portfolio/publications/patents/awards/summary)|
| 4 | Job_Requisition | **不动** |
| 5 | Candidate_Match_Result | 加 4 字段(overall_match_score/overall_fit_verdict/overall_fit_summary/overall_match_grade)|

**Phase 2 — AO 端 mapper + client 写完(Steven,6h)**

| # | 文件 | 动作 | 估时 |
|---|---|---|---|
| 6 | `resume-parser-agent/lib/inngest/client.ts` | 改 3 个 Nested + 删 1 个 | 30 min |
| 7 | `lib/allmeta-client.ts`(根项目)| 新写 HTTP client | 1.5h |
| 8 | `resume-parser-agent/lib/mappers/ao-to-allmeta.ts` | 新写 5 个 mapper(见各 §3.x.X 终稿)| 2h |
| 9 | `resume-parser-agent/lib/raas-api-client.ts` | 改 `RaasMatchResumeData` typing | 30 min |
| 10 | matcher agent | 接入 `toAllmetaMatchResult` + `allmeta-client.writeInstance` | 1.5h |

**Phase 3 — 联调 + 端到端(双方,2h)**

| # | 任务 | 通过标准 |
|---|---|---|
| 11 | curl 直接 POST 每个 DataObject 的 mock payload | 5 个 DataObject 都返 200 |
| 12 | `?validate=strict` 模式跑 | 全部不报 type_errors |
| 13 | Neo4j Browser 验证节点 / 关系 / 字段 | `MATCH (c:Candidate {candidate_id: 'mock-001'}) RETURN c` 能拿到所有 v0_1_010 字段 |
| 14 | 跑 mock e2e:Resume parse → write Candidate + Resume + Expectation → match-resume → write MR | 链路全绿 |

**总估时:陈洋 2h + Steven 6h + 双方 2h = 10h(1.5 工作日)**

---

### 5.1 Phase 0 — 阻塞修复(必须先做)

| 任务 | 谁 | 估时 | 阻塞理由 |
|---|---|---|---|
| Allmeta 修 strict validation 还是 default mode 的 bug(若 properties_json 字段也被拒)| 陈洋 | 1-2h | 不修连 P0 改字段都不能验证 |

### 5.2 Phase 1 — MR 链路必经(P0)

让"江银行链路"能跑通的最小改动集:

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 1a | Allmeta `Candidate_Match_Result` 改名 + P0 字段加齐:改名 `job_position_id → job_requisition_id` + 加 **7 个 P0 字段**(`match_score / recommendation / hiring_recommendation`(★ 自然语言)+ `disqualified` boolean(★ DQ flag)+ `disqualification_reasons` + `has_credibility_red_flags` boolean(★ 信誉旗)+ `must_have_score` + `must_have_gaps` + `result` + `reason` + `match_breakdown_json` + `rule_check_audit_id`)| 陈洋 | 1h |
| 1b | AO 写新 mapper `lib/mappers/ao-to-allmeta.ts` `toAllmetaMatchResult`:必须 pluck 嵌套(`data.overallMatchScore.score` / `data.overallFit.verdict` 等)+ `VERDICT_TO_RECOMMENDATION` 归一化 + 边界 case 处理("未提供" → null)— 详见 §3.5 C.5 完整代码 | Steven | 2h |
| 2 | Allmeta `Candidate`:改名 `experience_years → work_years` + 加 2 字段(`current_company / current_title`)| 陈洋 | 20 min |
| 3 | AO 写新 `lib/allmeta-client.ts`(POST 调用 + 错误处理)| Steven | 2h |
| 4 | AO 写 `lib/mappers/ao-to-allmeta.ts` 的 `toAllmetaCandidate` mapper(MR mapper 已在 #1b)| Steven | 1h |
| 5 | E2E 联调:江银行简历 → AO POST Candidate + MR → Allmeta validation 通过 → Neo4j 落地 → 验证 `disqualified` / `has_credibility_red_flags` / `match_score` 都能 Cypher 查到 | 双方 | 1h |

**Phase 1 done = 链路打通,可以跑 demo**。

### 5.3 Phase 2 — 数据质量(P1)

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 6 | Allmeta `Candidate_Expectation`:改名 3 字段 + 改类型 + 拆 salary_range(配合 properties_json 改 + Allmeta strict validation 类型测试)| 陈洋 | 1h |
| 7 | Allmeta `Resume`:改名 3 字段 + 加 2 字段(`summary / upload_id`)| 陈洋 | 30 min |
| 8 | Allmeta `Job_Requisition`:改 city 类型 + 拆 salary_range | 陈洋 | 30 min |
| 9 | AO 补 `toAllmetaResume / toAllmetaCandidateExpectation / toAllmetaJobRequisition` mapper | Steven | 2h |
| 10 | AO mapper 删 `RuntimeNested` + 删 `Candidate.skills` 重复 | Steven | 30 min |
| 11 | AO 在 `ResumeNested` 加 `certificate / language_skills` 字段(对 RoboHire `certifications[] / languages[]`)| Steven | 1h |
| 12 | Allmeta `Candidate_Match_Result` 加 **25 个 P1 字段**(原 18 + 简历可信度复合模型 7 个:`credibility_positive_indicators` / `experience_validation_score` / `experience_relevance` / `current_gap_flagged` / `current_gap_explanation` / `stability_concerns` / `stability_mitigating_factors`)| 陈洋 | 1.5h |
| 13 | AO `toAllmetaMatchResult` mapper 补 **21 个 P1 pluck 函数**(详见 §3.5 C.5 完整代码)| Steven | 2h |
| 14 | AO `RaasMatchResumeData` typing 修正:嵌套 schema 化(§3.5 (e))— 把 `experienceValidation` / `workHistoryStability` / `areasToProbeDeeper` 也加上精确 typing(简历可信度信号源)| Steven | 45 min |
| 15 | (隐含改动 — 可选)`scripts/rule-check-poc/pipeline.ts` 入口加 `disqualified === true` 短路 + 简历可信度复合短路(§3.5 C.8 + C.9)| Steven | 1h |
| 16 | partner 仪表盘加"可疑简历筛选"复合 Cypher 查询(§3.5 C.9 示例)— 用 `has_credibility_red_flags` / `current_gap_flagged` / `experience_validation_score` 三信号 | partner FE | 1h |

### 5.4 Phase 3 — 命名清理(P2-P3,可后续 sprint)

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 12 | Allmeta JR 改名 4 个(`open_date / required_arrival_date / csi_department_id / hc_status / expected_level`)| 陈洋 | 30 min |
| 13 | Allmeta Candidate 改名 2 个(`marital_fertility_status / conflict_interest_declaration`)| 陈洋 | 20 min |
| 14 | AO mapper 跟齐 Phase 3 改名 | Steven | 30 min |

### 5.5 上线 Checklist(联调时逐条验证)

每个 DataObject 都要跑一次端到端验证:

```bash
# 用 curl 模拟 AO 行为,看 Allmeta 是否接受
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @candidate-payload.json \
  "https://allmeta.example.com/api/v1/ontology/instances/Candidate?domain=RAAS-v1&validate=strict"

# 期望:200 OK { upserted: ["C-100023"], count: 1 }
# 失败:400 validation-failed { details: { unknown: [...] } } → 看 unknown 字段名,补 mapper
```

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | Candidate POST 响应 200 | `details.unknown` 为空 |
| 2 | Candidate_Expectation POST 响应 200 | 同上 |
| 3 | Resume POST 响应 200 + file_path/upload_id 落库 | 同上 |
| 4 | Job_Requisition POST 响应 200 + city 是 List 类型 | 同上 |
| 5 | Candidate_Match_Result POST 响应 200 + match_score 可查询 | 同上 |
| 6 | `?validate=strict` 模式也通过(类型 / required 检查)| 不报 type_errors |
| 7 | Neo4j Browser 能 `MATCH (c:Candidate {candidate_id: "..."})` 查到节点 | 节点 + 关系都在 |
| 8 | `MATCH (mr:Candidate_Match_Result) WHERE "10-5" IN mr.failure_reason_codes RETURN mr` 能返回 | List 字段查询正常 |
| 9 | ★ `MATCH (mr:Candidate_Match_Result {disqualified: true}) RETURN count(mr)` 能查 | Boolean DQ flag 落地 |
| 10 | ★ `MATCH (mr:Candidate_Match_Result {has_credibility_red_flags: true}) RETURN mr` 能查 | Boolean 信誉主旗落地 |
| 11 | ★ `MATCH (mr:Candidate_Match_Result) WHERE mr.match_score > 0.8 RETURN mr ORDER BY mr.match_score DESC` 能排序 | Float 评分支持排序 |
| 12 | ★ `MATCH (mr:Candidate_Match_Result) WHERE mr.short_stint_count > 2 RETURN mr` 能筛(频繁跳槽)| Integer 字段筛选 |
| 13 | ★ 简历可信度复合查询(§3.5 C.9):`WHERE mr.has_credibility_red_flags = true OR mr.current_gap_flagged = true OR (mr.experience_validation_score < 60 AND mr.short_stint_count > 2)` 能跑 | 7 个可信度字段都已落地 + 复合查询性能可接受 |
| 14 | ★ `MATCH (mr) WHERE size(mr.credibility_concerns) > 0 RETURN mr.credibility_concerns` 能查 List<String> 长度 | List 字段非空筛选 |

---

## 6. 风险与备选方案

### 6.1 主要风险

| 风险 | 缓解 |
|---|---|
| Allmeta 改名影响 partner 仪表盘 / hsm UI 的现有 query | 改名前陈洋扫一遍 partner 端查询代码;过渡期可加 alias view(`MATCH (n) RETURN n.work_years AS experience_years`)|
| AO mapper 改完 RoboHire 升级 vendor 字段名 | mapper 集中在一个文件,vendor 字段变化只改一处;同时 mapper 加 `[k: string]: unknown` catch-all 容忍未来字段 |
| Allmeta 拆 salary_range 后老 String 字段还有数据 | 保留 `salary_range: String` 兼容,逐步把 partner 写入也改成填 min/max,过渡期双写 |
| `match_breakdown_json` 字符串太大(RoboHire 一次响应可能 30KB)| Neo4j 单 String 属性上限是 100KB,够用;但如果超 50KB 应该考虑改 TEXT 节点 + 关系 |

### 6.2 备选:如果 Allmeta 不愿改名(陈洋拒绝)

只 AO 端 mapper 双向翻译 — 可行但有代价:

```typescript
const CANDIDATE_FIELD_RENAME: Record<string, string> = {
  work_years: 'experience_years',  // AO 名 → Allmeta 名
  // ... 其他 14 项
};

function applyFieldRename(payload: Record<string, unknown>, map: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [map[k] ?? k, v])
  );
}
```

**代价**:
- partner 端拿到的 Neo4j 数据还是 `experience_years / job_position_id` 这些坏命名 — 治标不治本。
- 每次 RoboHire 改字段 AO 跟着改 mapper(没解决根因)。
- AO 内部代码 / TypeScript 类型 / Allmeta DataObject 三套命名,新人看代码两眼一黑。

→ **强烈不推荐这条路**。命名问题该在 ontology 一次性修干净。

---

## 7. 文档关系

| 文档 | 范围 | 受众 |
|---|---|---|
| **本文** [docs/ao-allmeta-alignment-action-plan.md](./ao-allmeta-alignment-action-plan.md) | ★ 操作手册:流程 + 决策原则 + 改动清单 + 上线步骤 | Steven + 陈洋 + Leader |
| [docs/ao-allmeta-field-alignment-table.md](./ao-allmeta-field-alignment-table.md) | 字段速查表(单表式) | 联调时查 |
| [docs/ao-runtime-vs-allmeta-alignment-v2.md](./ao-runtime-vs-allmeta-alignment-v2.md) | 三层模型 + 双向选项详解 | 设计讨论 |
| [docs/ao-runtime-vs-allmeta-dataobject-gap.md](../ao-runtime-vs-allmeta-dataobject-gap.md) | 旧版(L1 vs L3,有偏差)| 已被取代 |
| Allmeta API 契约 | 写入 endpoint / validation 行为 | 必读 |
