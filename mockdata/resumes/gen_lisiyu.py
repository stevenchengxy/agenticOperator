"""
Generate a realistic Chinese resume PDF for raas/RMHR upload testing.

Uses reportlab + macOS Arial Unicode (broad CJK coverage). The candidate
profile is fully synthetic — unique phone/email designed to dodge any
real corporate-pool collision, with parseable canonical fields ("姓名" /
"手机" / "邮箱" / "教育经历" / "工作经历") so RMHR's strict parser
accepts it.
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph, Spacer, SimpleDocTemplate, Table, TableStyle, KeepTogether
)
from reportlab.lib import colors

# ── Font registration ────────────────────────────────────────────────────
FONT_PATH = "/Library/Fonts/Arial Unicode.ttf"
if not os.path.exists(FONT_PATH):
    raise SystemExit(f"font not found: {FONT_PATH}")
pdfmetrics.registerFont(TTFont("CN", FONT_PATH))

# ── Styles ───────────────────────────────────────────────────────────────
H1 = ParagraphStyle(
    "H1", fontName="CN", fontSize=22, leading=28, alignment=0,
    textColor=colors.HexColor("#1a1a1a"), spaceAfter=4,
)
SUB = ParagraphStyle(
    "SUB", fontName="CN", fontSize=10.5, leading=14,
    textColor=colors.HexColor("#666"), spaceAfter=12,
)
SECTION = ParagraphStyle(
    "SECTION", fontName="CN", fontSize=13, leading=18,
    textColor=colors.HexColor("#0a4d8c"), spaceBefore=14, spaceAfter=6,
    borderPadding=(0, 0, 4, 0),
)
KV = ParagraphStyle(
    "KV", fontName="CN", fontSize=10, leading=15,
    textColor=colors.HexColor("#222"),
)
BODY = ParagraphStyle(
    "BODY", fontName="CN", fontSize=10.5, leading=16,
    textColor=colors.HexColor("#222"),
)
ITEM_HEAD = ParagraphStyle(
    "IH", fontName="CN", fontSize=11, leading=15,
    textColor=colors.HexColor("#111"), spaceBefore=6, spaceAfter=2,
)
BULLET = ParagraphStyle(
    "BU", fontName="CN", fontSize=10, leading=15, leftIndent=12,
    textColor=colors.HexColor("#333"),
)

# ── Resume data — fully synthetic; phone/email/idcard intentionally
# "unique enough" to dodge corporate-pool collision. ─────────────────────
CANDIDATE = {
    "name":   "李思雨",
    "gender": "女",
    "age":    "28",
    "phone":  "138-7421-0936",
    "email":  "lisiyu.7421@testmail.local",
    "city":   "深圳",
    "title":  "文秘行政专员 / 行政助理",
    "summary": (
        "6 年文秘与行政服务经验，曾在两家千人规模企业承担管理层文档撰写、"
        "对外接待、跨部门会务统筹工作。熟悉 ISO 文档体系、政府接待礼仪与"
        "保密管理规范，擅长在快节奏环境下零差错交付。"
    ),
}

EDUCATION = [
    {"period": "2014.09 — 2018.06", "school": "中国传媒大学",
     "degree": "汉语言文学 · 本科 · 学士",
     "notes": "校学生会秘书处部长 / 校刊《传媒之声》主编 / 国家奖学金两次"},
]

EXPERIENCE = [
    {
        "period": "2022.04 — 至今",
        "company": "深圳市新华信息技术有限公司",
        "title": "总经理办公室 高级文秘",
        "items": [
            "为总经理及三位副总起草日常公文、报告、对外致辞共 200+ 篇，零差错交付。",
            "统筹全年政府及客户接待 40+ 场（含信息产业部、深圳市工信局等部委级别），"
            "主导礼仪流程与场地物料准备，客户满意度评估 96 分。",
            "搭建公司公文及合同档案体系，迁移历史 8000+ 份纸质材料至数字化平台。",
            "组织 12 次月度跨部门高层会议，会议纪要 24 小时内发布、议题闭环跟踪。",
        ],
    },
    {
        "period": "2018.07 — 2022.03",
        "company": "中信建设集团（深圳分公司）",
        "title": "行政部 文秘 / 行政助理",
        "items": [
            "负责分公司日常行政与办公管理，含办公耗材、固定资产、员工出差排程。",
            "撰写并维护分公司管理制度文件 30+ 份，通过总部 ISO9001 年度审核。",
            "组织年度员工大会与团建活动 6 次，平均参与率 92%。",
        ],
    },
]

SKILLS = [
    "公文写作（请示 / 报告 / 函 / 纪要 / 通知）",
    "Office 套件（Word / Excel / PowerPoint 高级用户，VBA 基础）",
    "WPS / 飞书 / 钉钉 / 企业微信 协同办公",
    "会务统筹（场地、物料、议程、礼仪）",
    "客户接待与商务礼仪",
    "保密管理与档案数字化",
    "英语 CET-6（554 分），日常商务沟通可用",
]

CERTS = [
    "国家秘书职业资格证（一级 / 高级）",
    "PMP 项目管理认证",
    "普通话二级甲等",
]

SELF_EVAL = (
    "对工作有强烈的责任感与同理心，待人接物得体大方，能在快节奏环境下保持冷静。"
    "细节意识强，长期保持公文产出零差错。乐于学习数字化办公新工具，"
    "希望在大型互联网或科技公司行政岗位上长期发展。"
)


def section(title):
    return Paragraph(
        f'<font color="#0a4d8c"><b>■ {title}</b></font>', SECTION
    )


def kv_row(pairs):
    """Render two-column key/value strip for the header card."""
    rows = []
    for label, value in pairs:
        rows.append([
            Paragraph(f'<font color="#666">{label}</font>', KV),
            Paragraph(f'<font color="#111">{value}</font>', KV),
        ])
    tbl = Table(rows, colWidths=[2.4 * cm, None])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
    ]))
    return tbl


def build_doc(out_path):
    doc = SimpleDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.6 * cm, bottomMargin=1.6 * cm,
        title=f"{CANDIDATE['name']}_简历",
        author=CANDIDATE["name"],
    )
    story = []
    # ── Header ──
    story.append(Paragraph(CANDIDATE["name"], H1))
    story.append(Paragraph(CANDIDATE["title"], SUB))
    story.append(kv_row([
        ("姓名", CANDIDATE["name"]),
        ("性别", CANDIDATE["gender"]),
        ("年龄", CANDIDATE["age"]),
        ("现居", CANDIDATE["city"]),
        ("手机", CANDIDATE["phone"]),
        ("邮箱", CANDIDATE["email"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(CANDIDATE["summary"], BODY))

    # ── Education ──
    story.append(section("教育经历"))
    for e in EDUCATION:
        story.append(Paragraph(
            f'<b>{e["school"]}</b>    <font color="#666">{e["period"]}</font>',
            ITEM_HEAD,
        ))
        story.append(Paragraph(e["degree"], BODY))
        if e.get("notes"):
            story.append(Paragraph(f'<font color="#555">{e["notes"]}</font>', BULLET))

    # ── Work Experience ──
    story.append(section("工作经历"))
    for w in EXPERIENCE:
        story.append(Paragraph(
            f'<b>{w["company"]}</b> · {w["title"]}    '
            f'<font color="#666">{w["period"]}</font>',
            ITEM_HEAD,
        ))
        for item in w["items"]:
            story.append(Paragraph(f'• {item}', BULLET))

    # ── Skills ──
    story.append(section("专业技能"))
    for s in SKILLS:
        story.append(Paragraph(f'• {s}', BULLET))

    # ── Certs ──
    story.append(section("证书与奖项"))
    for cert in CERTS:
        story.append(Paragraph(f'• {cert}', BULLET))

    # ── Self-evaluation ──
    story.append(section("自我评价"))
    story.append(Paragraph(SELF_EVAL, BODY))

    doc.build(story)
    return out_path


if __name__ == "__main__":
    out = "/Users/yuhancheng/Desktop/agenticOperator/mockdata/resumes/李思雨_文秘行政专员.pdf"
    path = build_doc(out)
    size = os.path.getsize(path)
    print(f"wrote {path} ({size} bytes)")
