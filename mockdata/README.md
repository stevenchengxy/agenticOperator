# Mockdata for agentic-operator × RAAS pipeline

生成命令: `python3 /tmp/gen-mockdata.py`

## 目录结构

```
mockdata/
├── README.md               (本文件)
├── jds/                    6 份 JD JSON, 形如 RAAS POST /api/v1/requirements 入参
│   ├── JD-101_高级后端工程师.json
│   ├── JD-102_Senior_Frontend_Engineer.json
│   ├── JD-103_高级产品经理.json
│   ├── JD-104_数据分析师.json
│   ├── JD-105_HRBP.json
│   └── JD-106_AI算法工程师.json
├── resumes/                8 份 PDF 简历 (中英混排)
│   ├── 张明_后端工程师.pdf              ↔ 对应 JD-101
│   ├── 李雪_前端工程师.pdf              ↔ 对应 JD-102 (CN side)
│   ├── Sarah_Chen_Frontend_Engineer.pdf ↔ 对应 JD-102 (EN side, 新加坡)
│   ├── 王浩然_产品经理.pdf              ↔ 对应 JD-103
│   ├── 陈思颖_数据分析师.pdf            ↔ 对应 JD-104
│   ├── 刘晓东_AI算法工程师.pdf          ↔ 对应 JD-106
│   ├── Mike_Johnson_HRBP.pdf            ↔ 对应 JD-105
│   └── 赵磊_测试工程师.pdf              ←  跨需求 (不直接命中任何 JD)
└── screenshots/            3 份 mock "需求来源截图", 可拖进 RAAS 新增需求页面
    ├── 01_email_招聘需求.png           客户用人主管发来的邮件
    ├── 02_wechat_招聘对话.png          企业微信里的对话
    └── 03_excel_需求登记表.png         Excel 需求登记表
```

## 使用方式

### 1. 简历 → MinIO (`recruit-resume-raw` 桶) + Inngest `RESUME_DOWNLOADED`

```bash
docker exec raas-minio-dev mc cp /tmp/Resume/<filename>.pdf \
  local/recruit-resume-raw/2026/05/<uuid>-<filename>.pdf

# 同步 resume_upload_runtime 行 (raas-backend 的 raw-pdf endpoint 才能找到)
# 用 /tmp/seed-resume-runtime.py 自动化

# 发 RESUME_DOWNLOADED 进 Inngest dev server
curl -X POST http://localhost:8288/e/dev -H "Content-Type: application/json" \
  -d '{"name":"RESUME_DOWNLOADED","data":{"payload":{...}}}'
```

### 2. JD → RAAS DB + Inngest `REQUIREMENT_LOGGED`

正经做法: POST 到 raas-backend, outbox 自动 emit REQUIREMENT_LOGGED.

```bash
curl -X POST http://localhost:3001/api/v1/requirements \
  -H "Authorization: Bearer internal-agentic-agent" \
  -H "Content-Type: application/json" \
  --data-binary @mockdata/jds/JD-101_高级后端工程师.json
```

JSON 字段已经按 RAAS createRequirement input shape 准备好 (job_requisition_id /
client_id / standard_job_role_id / client_job_title / city / headcount / ...
还需配合预先 seed 好的 client / standard_job_role 行).

### 3. 截图 → RAAS 新增需求页面的 "上传截图" 控件

打开 `http://localhost:4000` → 客户需求 → 新增需求 → "上传截图" / Ctrl+V 粘贴,
拖入 screenshots/ 目录里的任意一张. 后端 OCR + LLM 解析出来填进表单字段.

## 对照关系 (用于命中率回归)

| JD                                     | 强匹配简历                                   | 弱/不匹配                  |
|----------------------------------------|---------------------------------------------|---------------------------|
| JD-101 高级后端工程师 (Java/Go)        | 张明_后端工程师.pdf                         | 李雪 / Sarah / 王浩然 (角色不符) |
| JD-102 Senior Frontend Engineer        | Sarah_Chen / 李雪_前端工程师                | 张明 (后端)               |
| JD-103 高级产品经理 - AI 平台          | 王浩然_产品经理.pdf                         | 张明/刘晓东 (技术线)      |
| JD-104 数据分析师 - 用户增长           | 陈思颖_数据分析师.pdf                       | 李雪 / Sarah (前端)       |
| JD-105 HRBP - 技术线                   | Mike_Johnson_HRBP.pdf                       | 所有技术简历              |
| JD-106 AI 算法工程师 (大模型)          | 刘晓东_AI算法工程师.pdf                     | 张明 (工程方向)           |
| —                                      | 赵磊_测试工程师.pdf (跨需求, 任意命中度低)  | 所有 JD 都不强匹配        |
