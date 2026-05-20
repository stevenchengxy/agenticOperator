"""
Batch resume generator — emits N polished Chinese resumes to mockdata/resumes/.

Each candidate is a fully synthetic profile with:
  - parseable canonical fields (姓名 / 性别 / 年龄 / 手机 / 邮箱 / 现居)
  - unique 138-xxxx-xxxx phone + *.local TLD email (dodges RMHR pool collisions)
  - role-aligned skills + education + work history so a recruiter can
    sanity-check JD/Resume matching against the existing mockdata/jds/.

Run:
  python3 /Users/yuhancheng/Desktop/agenticOperator/mockdata/resumes/gen_batch.py

Re-running is idempotent — same filenames overwrite. Tweak the PROFILES
list below to add / change / drop candidates.
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph, Spacer, SimpleDocTemplate, Table, TableStyle,
)
from reportlab.lib import colors

OUT_DIR = "/Users/yuhancheng/Desktop/agenticOperator/mockdata/resumes"
FONT_PATH = "/Library/Fonts/Arial Unicode.ttf"

if not os.path.exists(FONT_PATH):
    raise SystemExit(f"font not found: {FONT_PATH}")
pdfmetrics.registerFont(TTFont("CN", FONT_PATH))

# ── Styles ───────────────────────────────────────────────────────────────
H1 = ParagraphStyle("H1", fontName="CN", fontSize=22, leading=28,
                    textColor=colors.HexColor("#1a1a1a"), spaceAfter=4)
SUB = ParagraphStyle("SUB", fontName="CN", fontSize=10.5, leading=14,
                     textColor=colors.HexColor("#666"), spaceAfter=12)
SECTION = ParagraphStyle("SECTION", fontName="CN", fontSize=13, leading=18,
                         textColor=colors.HexColor("#0a4d8c"),
                         spaceBefore=14, spaceAfter=6)
KV = ParagraphStyle("KV", fontName="CN", fontSize=10, leading=15,
                    textColor=colors.HexColor("#222"))
BODY = ParagraphStyle("BODY", fontName="CN", fontSize=10.5, leading=16,
                      textColor=colors.HexColor("#222"))
ITEM_HEAD = ParagraphStyle("IH", fontName="CN", fontSize=11, leading=15,
                           textColor=colors.HexColor("#111"),
                           spaceBefore=6, spaceAfter=2)
BULLET = ParagraphStyle("BU", fontName="CN", fontSize=10, leading=15,
                        leftIndent=12, textColor=colors.HexColor("#333"))


def section(title):
    return Paragraph(f'<font color="#0a4d8c"><b>■ {title}</b></font>', SECTION)


def kv_row(pairs):
    rows = [[Paragraph(f'<font color="#666">{k}</font>', KV),
             Paragraph(f'<font color="#111">{v}</font>', KV)]
            for k, v in pairs]
    tbl = Table(rows, colWidths=[2.4 * cm, None])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
    ]))
    return tbl


def build_doc(profile, out_path):
    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.6 * cm, bottomMargin=1.6 * cm,
        title=f"{profile['name']}_简历", author=profile["name"],
    )
    story = []
    # ── Header ──
    story.append(Paragraph(profile["name"], H1))
    story.append(Paragraph(profile["title"], SUB))
    story.append(kv_row([
        ("姓名", profile["name"]),
        ("性别", profile["gender"]),
        ("年龄", profile["age"]),
        ("现居", profile["city"]),
        ("手机", profile["phone"]),
        ("邮箱", profile["email"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(profile["summary"], BODY))

    story.append(section("教育经历"))
    for e in profile["education"]:
        story.append(Paragraph(
            f'<b>{e["school"]}</b>    <font color="#666">{e["period"]}</font>',
            ITEM_HEAD))
        story.append(Paragraph(e["degree"], BODY))
        if e.get("notes"):
            story.append(Paragraph(f'<font color="#555">{e["notes"]}</font>', BULLET))

    story.append(section("工作经历"))
    for w in profile["experience"]:
        story.append(Paragraph(
            f'<b>{w["company"]}</b> · {w["title"]}    '
            f'<font color="#666">{w["period"]}</font>',
            ITEM_HEAD))
        for item in w["items"]:
            story.append(Paragraph(f'• {item}', BULLET))

    story.append(section("专业技能"))
    for s in profile["skills"]:
        story.append(Paragraph(f'• {s}', BULLET))

    if profile.get("certs"):
        story.append(section("证书与奖项"))
        for cert in profile["certs"]:
            story.append(Paragraph(f'• {cert}', BULLET))

    story.append(section("自我评价"))
    story.append(Paragraph(profile["self_eval"], BODY))
    doc.build(story)


# ─────────────────────────────────────────────────────────────────────────
# PROFILES — synthetic candidates. Phones are 138-NNNN-NNNN, all distinct.
# Emails use *.local TLD to dodge any reachable real domain.
# ─────────────────────────────────────────────────────────────────────────
PROFILES = [
    # ── 1. 行政助理（应届，匹配 文秘行政专员 但资历低 → 测试 match 排名） ──
    {
        "filename": "周婉清_行政助理.pdf",
        "name": "周婉清", "gender": "女", "age": "23",
        "phone": "138-2056-3814", "email": "zhouwanqing.2056@testmail.local",
        "city": "深圳",
        "title": "行政助理 · 应届生",
        "summary": "中山大学行政管理 2026 届应届毕业生，校学生会办公室负责人，"
                   "实习期间在万科地产行政部承担会务与档案数字化工作，"
                   "希望进入互联网或科技公司做行政岗位长期发展。",
        "education": [
            {"period": "2022.09 — 2026.06", "school": "中山大学",
             "degree": "行政管理 · 本科 · 学士",
             "notes": "校学生会办公室主任 · GPA 3.7/4.0 · 国家励志奖学金"},
        ],
        "experience": [
            {"period": "2025.07 — 2026.01", "company": "万科地产（深圳分公司）",
             "title": "行政部 实习生",
             "items": [
                 "协助行政经理统筹分公司年会及部门季度会议共 8 场",
                 "完成 1500+ 份合同纸质档案的扫描、OCR 与电子归档",
                 "撰写部门周报、月报及对外沟通邮件，0 差错被采纳",
             ]},
        ],
        "skills": [
            "Office 套件 / WPS / 飞书",
            "公文写作（通知 / 纪要 / 报告基础）",
            "档案数字化（OCR + 电子归档）",
            "英语 CET-6 528 分",
        ],
        "certs": ["普通话二级甲等", "MOS Word & Excel 认证"],
        "self_eval": "细心、踏实、抗压能力强。希望在节奏快、流程规范的团队"
                     "中长期发展，从行政助理岗位起步逐步成长为行政主管。",
    },

    # ── 2. 行政经理（资深，跨匹配 文秘行政专员） ──
    {
        "filename": "高志远_行政经理.pdf",
        "name": "高志远", "gender": "男", "age": "36",
        "phone": "138-4729-1058", "email": "gaozhiyuan.4729@testmail.local",
        "city": "北京",
        "title": "行政经理 / Office Manager",
        "summary": "12 年行政管理经验，先后在腾讯、字节跳动任行政经理，"
                   "负责北京总部 800+ 人办公空间运营、行政预算 5000 万 / 年、"
                   "团队 12 人。擅长制度落地、跨部门协调与大型活动统筹。",
        "education": [
            {"period": "2011.09 — 2014.06", "school": "北京大学",
             "degree": "公共管理 · 硕士 · MPA",
             "notes": "全国 MPA 案例大赛二等奖"},
            {"period": "2007.09 — 2011.06", "school": "中国人民大学",
             "degree": "行政管理 · 本科 · 学士"},
        ],
        "experience": [
            {"period": "2020.05 — 至今", "company": "字节跳动",
             "title": "总部行政经理（向人力副总裁汇报）",
             "items": [
                 "统筹北京中关村 + 望京两个总部园区共 800+ 工位的日常运营",
                 "搭建 ISO 9001/14001 双认证的行政服务标准化体系",
                 "主导年度全员大会（3000+ 人）与季度高层闭门会议",
                 "管理行政预算 5000 万 / 年，年度节约率 12%",
                 "带 12 人团队，0 离职率连续两年",
             ]},
            {"period": "2014.07 — 2020.04", "company": "腾讯（北京）",
             "title": "高级行政主管 → 行政经理",
             "items": [
                 "负责微信事业群北京办公室 300+ 工位",
                 "落地高管出行 / 接待 / 礼品全套合规流程",
             ]},
        ],
        "skills": [
            "行政体系搭建（制度 / SOP / KPI 一体化）",
            "团队管理（10+ 人）",
            "预算编制与控制",
            "大型活动统筹（千人级）",
            "ISO 9001/14001 体系审核员资质",
            "英语商务级（雅思 7.5）",
        ],
        "certs": ["PMP 项目管理认证", "ISO 9001 内审员", "国家秘书一级"],
        "self_eval": "成熟稳重、善于带团队，擅长把无序的行政事务体系化、"
                     "标准化。希望在快速增长的科技公司继续扩大管理半径。",
    },

    # ── 3. 后端工程师（资深，对位 JD-101 高级后端工程师） ──
    {
        "filename": "孙浩_高级后端工程师.pdf",
        "name": "孙浩", "gender": "男", "age": "31",
        "phone": "138-9183-4527", "email": "sunhao.9183@testmail.local",
        "city": "杭州",
        "title": "高级后端工程师 · Go / Java",
        "summary": "8 年后端开发经验，主导阿里云对象存储 OSS 元数据服务 P0 链路重构，"
                   "QPS 提升 3 倍。熟悉分布式系统、Go / Java / Kafka / Redis。",
        "education": [
            {"period": "2013.09 — 2017.06", "school": "浙江大学",
             "degree": "计算机科学与技术 · 本科 · 学士",
             "notes": "ACM/ICPC 亚洲区域赛银奖"},
        ],
        "experience": [
            {"period": "2021.03 — 至今", "company": "阿里云",
             "title": "P7 高级后端工程师 / 对象存储 OSS",
             "items": [
                 "主导 OSS 元数据 KV 层重构，QPS 30w → 90w，P99 25ms → 8ms",
                 "设计跨 region 同步链路，对帐误差 0.001%",
                 "Code review 团队 ~6k 行/月，培养 2 名 P5 转正",
             ]},
            {"period": "2017.07 — 2021.02", "company": "美团",
             "title": "后端开发 / 配送平台",
             "items": [
                 "Spring Cloud 微服务化骑手调度模块",
                 "Kafka 削峰，订单写入吞吐提升 4 倍",
             ]},
        ],
        "skills": [
            "Go (5 年) / Java (8 年) / Python (脚本级)",
            "Kafka / Redis / MySQL / TiDB",
            "Kubernetes / Docker / Istio",
            "分布式系统设计（CAP / Raft / 一致性哈希）",
            "性能优化 (pprof / arthas / async-profiler)",
            "英语：技术文档读写流利",
        ],
        "certs": ["阿里云 ACP 认证", "CKA Kubernetes 管理员"],
        "self_eval": "技术扎实，写过的代码大多还在线上跑。愿意深度参与"
                     "架构设计与系统重构，对存储、调度、消息中间件方向尤有兴趣。",
    },

    # ── 4. 前端工程师（中级，对位 JD-102） ──
    {
        "filename": "顾雅婷_前端工程师.pdf",
        "name": "顾雅婷", "gender": "女", "age": "27",
        "phone": "138-6395-7102", "email": "guyating.6395@testmail.local",
        "city": "上海",
        "title": "前端工程师 · React / TypeScript",
        "summary": "5 年前端经验，曾在 SHEIN 负责海外站点 React 重构，"
                   "首屏性能 LCP 4.5s → 1.8s。熟悉 React 18 / Next.js 14 / Vite。",
        "education": [
            {"period": "2016.09 — 2020.06", "school": "同济大学",
             "degree": "软件工程 · 本科 · 学士"},
        ],
        "experience": [
            {"period": "2022.06 — 至今", "company": "SHEIN（上海）",
             "title": "高级前端工程师 / 用户增长前端",
             "items": [
                 "主导海外站点（30+ 语种）首屏性能优化项目",
                 "搭建 design token + Tailwind 主题系统替换祖传 Less 体系",
                 "推动单元测试覆盖率 22% → 71%",
             ]},
            {"period": "2020.07 — 2022.05", "company": "B 站",
             "title": "前端开发",
             "items": [
                 "直播间互动组件库维护（弹幕 / 礼物 / 连麦 UI）",
                 "React + WebSocket 长连接管理重构",
             ]},
        ],
        "skills": [
            "React 18 / Next.js 14 / TypeScript",
            "Vite / Webpack / Rollup",
            "Tailwind / CSS-in-JS / Design Token",
            "前端性能（Web Vitals / Lighthouse / Sentry）",
            "Jest / Vitest / Playwright",
            "Figma 协作 / 设计稿落地",
        ],
        "certs": ["AWS Cloud Practitioner"],
        "self_eval": "热爱前端工程化与性能优化，会的不止 React。期望加入"
                     "对用户体验有要求、敢做技术升级的团队。",
    },

    # ── 5. 数据分析师（初级，对位 JD-104 但资历较浅） ──
    {
        "filename": "梁子珊_数据分析师.pdf",
        "name": "梁子珊", "gender": "女", "age": "25",
        "phone": "138-7250-4631", "email": "liangzishan.7250@testmail.local",
        "city": "广州",
        "title": "数据分析师 · 用户增长方向",
        "summary": "3 年用户增长数据分析经验，曾在拼多多多多买菜负责城市运营"
                   "看板与 A/B 实验平台落地。熟悉 SQL / Python / Tableau。",
        "education": [
            {"period": "2019.09 — 2023.06", "school": "中山大学",
             "degree": "统计学 · 本科 · 学士",
             "notes": "全国大学生统计建模大赛二等奖"},
        ],
        "experience": [
            {"period": "2023.07 — 至今", "company": "拼多多 / 多多买菜",
             "title": "数据分析师 / 城市运营",
             "items": [
                 "搭建广深两地履约时效看板，问题件识别 + 12pp",
                 "推动 A/B 实验平台从手工 SQL 改为自助配置",
                 "完成 30+ 次用户增长策略实验，转化漏斗 +8% 上线",
             ]},
        ],
        "skills": [
            "SQL (Hive / MaxCompute / Doris) 熟练",
            "Python（pandas / numpy / scikit-learn 基础）",
            "Tableau / Power BI / FineBI",
            "A/B 实验设计与假设检验",
            "因果推断基础（DiD / PSM）",
        ],
        "certs": ["CDA Level II 数据分析师", "Tableau Desktop Specialist"],
        "self_eval": "对数字敏感，擅长把业务问题拆成可量化的指标。"
                     "希望加入有真实数据复杂度的团队、跟着业务一起成长。",
    },

    # ── 6. UI/UX 设计师（暂无对位 JD，扩展候选） ──
    {
        "filename": "钱明轩_UI设计师.pdf",
        "name": "钱明轩", "gender": "男", "age": "29",
        "phone": "138-3617-8205", "email": "qianmingxuan.3617@testmail.local",
        "city": "成都",
        "title": "高级 UI / UX 设计师",
        "summary": "7 年互联网产品设计经验，曾在网易云音乐主导 App 5.0 改版，"
                   "DAU + 18%。擅长 0 → 1 产品设计与设计体系建设。",
        "education": [
            {"period": "2014.09 — 2018.06", "school": "中央美术学院",
             "degree": "数字媒体艺术 · 本科 · 学士"},
        ],
        "experience": [
            {"period": "2021.04 — 至今", "company": "网易云音乐",
             "title": "高级 UI 设计师 / App 主端",
             "items": [
                 "主导 App 5.0 全量改版（iOS + Android）",
                 "搭建 Cloudy Design System，组件覆盖率 80%+",
                 "和算法团队合作设计「每日推荐」交互",
             ]},
            {"period": "2018.07 — 2021.03", "company": "字节跳动 / 抖音",
             "title": "UI 设计师",
             "items": [
                 "抖音直播间礼物系统视觉迭代",
                 "节日运营活动专题页 50+ 套",
             ]},
        ],
        "skills": [
            "Figma / Sketch / Adobe XD（精通）",
            "Principle / ProtoPie 动效原型",
            "Design System / Design Token / Token Studio",
            "用户研究方法（可用性测试 / 卡片分类）",
            "AI 辅助设计（Midjourney / Stable Diffusion）",
        ],
        "certs": ["IxDC 国际体验设计大会讲者 2024"],
        "self_eval": "对细节和体感有偏执，相信设计的价值要量化才有说服力。"
                     "期望加入产品体验为核心驱动力的团队。",
    },
]


def main():
    if not os.path.isdir(OUT_DIR):
        raise SystemExit(f"output dir not found: {OUT_DIR}")
    print(f"output dir: {OUT_DIR}")
    for p in PROFILES:
        path = os.path.join(OUT_DIR, p["filename"])
        build_doc(p, path)
        size = os.path.getsize(path)
        print(f"  ✓ {p['filename']:38s}  {size:>7} bytes  ({p['title']})")
    print(f"done — {len(PROFILES)} resumes")


if __name__ == "__main__":
    main()
