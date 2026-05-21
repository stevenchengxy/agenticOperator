"use client";
import React from "react";
import { useRouter } from "next/navigation";
import { ClaudeButton } from "./atoms";
import { useApp } from "@/lib/i18n";
import { ConfirmActionModal } from "@/components/manage/ConfirmActionModal";

type Props = {
  runId: string;
  status: string;
  onRefresh?: () => void;
};

export function RunActionsMenu({ runId, status, onRefresh }: Props) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<"cancel" | "pause" | "replay" | null>(
    null,
  );
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const callApi = async (action: "cancel" | "pause" | "replay", reason: string) => {
    const res = await fetch(`/api/manage/runs/${encodeURIComponent(runId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || undefined }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j as any).message ?? `HTTP ${res.status}`);
    }
    const j = await res.json();
    if (action === "replay" && j.restarted) {
      router.push(`/monitor/runs/${j.restarted}`);
    } else {
      onRefresh?.();
      router.refresh();
    }
  };

  const canReplay = status === "completed" || status === "failed" || status === "timed_out";
  const canCancel = status === "running" || status === "paused" || status === "suspended";
  const canPause = status === "running";

  // No valid actions for this status — hide the menu entirely
  if (!canReplay && !canCancel && !canPause) {
    return null;
  }

  return (
    <>
      <div className="relative" ref={menuRef}>
        <ClaudeButton onClick={() => setOpen(!open)}>
          {t("manage_actions_menu")} ▾
        </ClaudeButton>

        {open && (
          <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-[10px] border border-claude-line bg-claude-surface shadow-sm py-1">
            {canReplay && (
              <ActionItem
                onClick={() => {
                  setOpen(false);
                  setPendingAction("replay");
                }}
              >
                {t("manage_action_replay")}
              </ActionItem>
            )}
            {canCancel && (
              <ActionItem
                onClick={() => {
                  setOpen(false);
                  setPendingAction("cancel");
                }}
              >
                {t("manage_action_cancel")}
              </ActionItem>
            )}
            {canPause && (
              <ActionItem
                onClick={() => {
                  setOpen(false);
                  setPendingAction("pause");
                }}
              >
                {t("manage_action_pause")}
              </ActionItem>
            )}
          </div>
        )}
      </div>

      {/* Cancel confirmation — requires reason + type "cancel" */}
      <ConfirmActionModal
        open={pendingAction === "cancel"}
        onClose={() => setPendingAction(null)}
        onConfirm={(reason) => callApi("cancel", reason)}
        actionKey="cancel"
        title={t("manage_action_cancel")}
        description={t("manage_action_cancel_desc")}
        tone="danger"
        requireReason
      />

      {/* Pause confirmation — requires reason + type "pause" */}
      <ConfirmActionModal
        open={pendingAction === "pause"}
        onClose={() => setPendingAction(null)}
        onConfirm={(reason) => callApi("pause", reason)}
        actionKey="pause"
        title={t("manage_action_pause")}
        description={t("manage_action_pause_desc")}
        tone="warn"
        requireReason
      />

      {/* Replay confirmation — type "replay", no required reason */}
      <ConfirmActionModal
        open={pendingAction === "replay"}
        onClose={() => setPendingAction(null)}
        onConfirm={(reason) => callApi("replay", reason)}
        actionKey="replay"
        title={t("manage_action_replay")}
        description={t("manage_action_replay_desc")}
        tone="neutral"
      />
    </>
  );
}

function ActionItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-[12.5px] text-claude-ink-1 hover:bg-claude-panel transition-colors"
    >
      {children}
    </button>
  );
}
