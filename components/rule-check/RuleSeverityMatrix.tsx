"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import type {
  RuleMatrixResponse,
  RuleMatrixRow,
} from "@/app/api/rule-check-audits/matrix/route";

/**
 * B1 — Rule × 决策矩阵热力图
 *
 * 没有 ground truth 的简化版:每条 rule 一行,列展示 PASS / FAIL / NOT_APPLICABLE 频次。
 * Cell 可点 → 跳到该 rule 的样本 audit。
 *
 * 真正 TP/TN/FP/FN 4 象限矩阵需要先在 Neo4j 灌入 ground truth(Phase C),
 * 那时这个矩阵会扩展成 30×4。
 */
export function RuleSeverityMatrix() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = React.useState<RuleMatrixResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    fetchJson<RuleMatrixResponse>("/api/rule-check-audits/matrix?days=30")
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const openAudit = (auditId?: string) => {
    if (!auditId) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("auditId", auditId);
    router.replace(`/rule-check?${sp.toString()}`);
  };

  if (loading) return <EmptyState title="加载中…" hint="" />;
  if (!data) {
    return <EmptyState icon={<Ic.alert />} title="后端无响应" hint="" variant="info" />;
  }
  if (data.meta.error) {
    return <EmptyState icon={<Ic.alert />} title="读取失败" hint={data.meta.error} />;
  }
  if (data.rules.length === 0) {
    return (
      <EmptyState
        icon={<Ic.shield />}
        title="暂无 rule flag 数据"
        hint="近 30 天没有 audit 写入,或 audit 节点没有 :HAS_FLAG 关系。"
        variant="info"
      />
    );
  }

  // 排序:优先底线 + 触发频率高的在前
  const sorted = [...data.rules].sort((a, b) => {
    const sa = a.severity === "terminal" || a.severity === "needs_human" ? 0 : 1;
    const sb = b.severity === "terminal" || b.severity === "needs_human" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (b.fail !== a.fail) return b.fail - a.fail;
    return a.rule_id.localeCompare(b.rule_id);
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-ink-3" style={{ marginBottom: 4 }}>
        近 30 天 · 共 {data.total_audits} 条 audit · 涉及 {data.rules.length} 条 rule。
        每个 cell 数字 = 该 rule 在 audit 里以该 result 出现的次数。点击 cell 跳到样本 audit。
        <span className="text-warn" style={{ marginLeft: 12 }}>
          ⚠ 没有 ground truth,此处显示频次,不是 TP/TN/FP/FN 矩阵
        </span>
      </div>
      <div
        className="border border-line rounded-sm overflow-hidden"
        style={{ background: "var(--c-bg)" }}
      >
        {/* header */}
        <div
          className="grid border-b border-line"
          style={{
            gridTemplateColumns: "70px 90px 1fr 110px 90px 90px 110px",
            padding: "8px 10px",
            background: "var(--c-panel)",
            fontSize: 11,
            color: "var(--c-ink-3)",
            fontWeight: 500,
          }}
        >
          <div>rule_id</div>
          <div>类型</div>
          <div>名称</div>
          <div className="text-right" style={{ textAlign: "right" }}>
            applicable 次数
          </div>
          <div className="text-right" style={{ textAlign: "right", color: "var(--c-ok)" }}>
            PASS
          </div>
          <div className="text-right" style={{ textAlign: "right", color: "var(--c-err)" }}>
            FAIL
          </div>
          <div className="text-right" style={{ textAlign: "right" }}>
            NOT_APPLICABLE
          </div>
        </div>
        {sorted.map((r) => (
          <MatrixRow key={r.rule_id} row={r} onClickCell={openAudit} />
        ))}
      </div>
    </div>
  );
}

function MatrixRow({
  row,
  onClickCell,
}: {
  row: RuleMatrixRow;
  onClickCell: (auditId?: string) => void;
}) {
  const isBottomLine =
    row.severity === "terminal" || row.severity === "needs_human";
  return (
    <div
      className="grid border-b border-line"
      style={{
        gridTemplateColumns: "70px 90px 1fr 110px 90px 90px 110px",
        padding: "8px 10px",
        fontSize: 12,
        alignItems: "center",
        gap: 6,
      }}
    >
      <div className="mono text-[11.5px] text-ink-1 font-semibold">
        {row.rule_id}
      </div>
      <div>
        <Badge variant={isBottomLine ? "err" : "default"}>
          {row.severity === "flag_only" ? "提示" : "底线"}
        </Badge>
      </div>
      <div className="text-[12px] text-ink-2 truncate" title={row.rule_name}>
        {row.rule_name || "—"}
      </div>
      <div className="mono text-[12px] text-ink-2" style={{ textAlign: "right" }}>
        {row.total}
      </div>
      <Cell
        n={row.pass}
        variant="ok"
        onClick={() => onClickCell(row.sample_audit_ids?.pass)}
        clickable={!!row.sample_audit_ids?.pass}
      />
      <Cell
        n={row.fail}
        variant="err"
        onClick={() => onClickCell(row.sample_audit_ids?.fail)}
        clickable={!!row.sample_audit_ids?.fail}
        sampleEv={row.sample_fail_evidence}
      />
      <Cell n={row.not_applicable} variant="default" clickable={false} />
    </div>
  );
}

function Cell({
  n,
  variant,
  onClick,
  clickable,
  sampleEv,
}: {
  n: number;
  variant: "ok" | "err" | "default";
  onClick?: () => void;
  clickable?: boolean;
  sampleEv?: string;
}) {
  if (n === 0) {
    return (
      <div
        className="mono text-[12px] text-ink-3"
        style={{ textAlign: "right", padding: "0 4px" }}
      >
        0
      </div>
    );
  }
  const bg =
    variant === "ok"
      ? `color-mix(in oklab, var(--c-ok) ${Math.min(40, 8 + n * 4)}%, var(--c-bg))`
      : variant === "err"
        ? `color-mix(in oklab, var(--c-err) ${Math.min(40, 8 + n * 4)}%, var(--c-bg))`
        : "var(--c-panel)";
  const color =
    variant === "ok"
      ? "var(--c-ok)"
      : variant === "err"
        ? "var(--c-err)"
        : "var(--c-ink-2)";
  return (
    <div
      onClick={clickable ? onClick : undefined}
      title={sampleEv}
      style={{
        background: bg,
        color,
        textAlign: "right",
        padding: "4px 8px",
        borderRadius: 3,
        cursor: clickable ? "pointer" : "default",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {n}
      {clickable ? <span className="text-ink-3" style={{ marginLeft: 4, fontWeight: 400 }}>↗</span> : null}
    </div>
  );
}
