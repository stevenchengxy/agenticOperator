"use client";
import React from "react";
import { useRouter } from "next/navigation";
import { ClaudeButton } from "./atoms";
import { useApp } from "@/lib/i18n";

type Props = {
  runId: string;
  status: string;
  onRefresh?: () => void;
};

export function RunActionsMenu({ runId, status, onRefresh }: Props) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [pending, setPending] = React.useState<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPending(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const callApi = async (action: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/runs/${encodeURIComponent(runId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (action === 'restart' && j.restarted) {
        router.push(`/monitor/runs/${j.restarted}`);
      } else {
        onRefresh?.();
      }
      setOpen(false);
      setPending(null);
      setReason('');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[RunActionsMenu] action failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const canRestart = status === 'completed' || status === 'failed' || status === 'timed_out';
  const canCancel  = status === 'running' || status === 'paused' || status === 'suspended';
  const canPause   = status === 'running';
  const canResume  = status === 'paused';

  // No valid actions for this status — hide the menu entirely
  if (!canRestart && !canCancel && !canPause && !canResume) {
    return null;
  }

  return (
    <div className="relative" ref={menuRef}>
      <ClaudeButton onClick={() => setOpen(!open)} disabled={busy}>
        {t('manage_actions_menu')} ▾
      </ClaudeButton>

      {open && !pending && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-[10px] border border-claude-line bg-claude-surface shadow-sm py-1">
          {canRestart && (
            <ActionItem onClick={() => setPending('restart')}>
              {t('manage_action_restart')}
            </ActionItem>
          )}
          {canCancel && (
            <ActionItem onClick={() => setPending('cancel')}>
              {t('manage_action_cancel')}
            </ActionItem>
          )}
          {canPause && (
            <ActionItem onClick={() => setPending('pause')}>
              {t('manage_action_pause')}
            </ActionItem>
          )}
          {canResume && (
            <ActionItem onClick={() => setPending('resume')}>
              {t('manage_action_resume')}
            </ActionItem>
          )}
        </div>
      )}

      {open && pending && (
        <div className="absolute right-0 top-full mt-1 z-20 w-[280px] rounded-[10px] border border-claude-line bg-claude-surface shadow-sm p-3">
          <div className="text-[12.5px] font-medium mb-2 text-claude-ink-1">
            {t(`manage_confirm_${pending}`)}
          </div>
          {(pending === 'restart' || pending === 'replay') && (
            <div className="mb-2 text-[11.5px] text-claude-warn bg-claude-warn/10 rounded px-2 py-1.5">
              {t('monitor_detail_retry_warning')}
            </div>
          )}
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('manage_reason_placeholder')}
            className="w-full rounded border border-claude-line bg-claude-bg px-2 py-1 text-[12px] mb-2 text-claude-ink-1"
          />
          <div className="flex gap-2 justify-end">
            <ClaudeButton
              variant="ghost"
              size="sm"
              onClick={() => { setPending(null); setReason(''); }}
            >
              {t('manage_cancel_btn')}
            </ClaudeButton>
            <ClaudeButton
              variant="primary"
              size="sm"
              onClick={() => callApi(pending)}
              disabled={busy}
            >
              {busy ? '…' : t('manage_confirm_btn')}
            </ClaudeButton>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
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
