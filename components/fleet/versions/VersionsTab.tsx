'use client';

import React from 'react';
import { useApp } from '@/lib/i18n';
import { Btn, EmptyState } from '@/components/shared/atoms';
import { Ic } from '@/components/shared/Ic';
import { fetchJson } from '@/lib/api/client';
import type {
  AgentVersionRow,
  VersionsListResponse,
  CaptureVersionResponse,
  DeployVersionResponse,
} from '@/lib/agent-versions/types';
import { DeployConfirmDialog } from './DeployConfirmDialog';

const SERIF =
  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function StatusBadge({
  status,
  t,
}: {
  status: 'draft' | 'active' | 'archived';
  t: (k: string) => string;
}) {
  const styles: Record<typeof status, { bg: string; fg: string; border: string }> = {
    active: {
      bg: 'var(--c-ok-bg)',
      fg: 'var(--c-ok)',
      border: 'color-mix(in oklab, var(--c-ok) 25%, transparent)',
    },
    draft: { bg: 'var(--c-panel)', fg: 'var(--c-ink-2)', border: 'var(--c-line)' },
    archived: { bg: 'transparent', fg: 'var(--c-ink-3)', border: 'var(--c-line)' },
  };
  const s = styles[status];
  const label = t(`av_status_${status}`);
  return (
    <span
      className="inline-flex items-center gap-1 rounded border"
      style={{
        padding: '2px 8px',
        fontSize: 11,
        background: s.bg,
        color: s.fg,
        borderColor: s.border,
      }}
    >
      {status === 'active' && (
        <span
          className="rounded-full"
          style={{ width: 5, height: 5, background: 'var(--c-ok)' }}
        />
      )}
      {label}
    </span>
  );
}

export function VersionsTab({ short }: { short: string }) {
  const { t } = useApp();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<VersionsListResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<{ kind: 'ok' | 'err'; msg: string } | null>(
    null,
  );

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<VersionsListResponse>(
        `/api/agents/${encodeURIComponent(short)}/versions`,
      );
      setData(res);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [short]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const onCapture = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(short)}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as CaptureVersionResponse;
      if (body.ok) {
        setFlash({
          kind: 'ok',
          msg: `${t('av_capture_success')}: ${body.version.versionLabel}`,
        });
        reload();
      } else if (body.error === 'CONFLICT') {
        setFlash({ kind: 'err', msg: t('av_capture_conflict') });
      } else if (body.error === 'NO_CONFIG') {
        setFlash({ kind: 'err', msg: t('av_capture_no_config') });
      } else {
        setFlash({ kind: 'err', msg: body.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const onDeploy = async (id: string) => {
    setBusy(true);
    setConfirmId(null);
    setFlash(null);
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(short)}/versions/${id}/deploy`,
        { method: 'POST' },
      );
      const body = (await res.json()) as DeployVersionResponse;
      if (body.ok) {
        setFlash({
          kind: 'ok',
          msg: `${t('av_deploy_success')}: ${body.version.versionLabel}`,
        });
        reload();
      } else {
        setFlash({ kind: 'err', msg: body.message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="m-0 text-ink-1"
            style={{
              fontFamily: SERIF,
              fontSize: 17,
              fontWeight: 500,
              letterSpacing: '-0.01em',
            }}
          >
            {t('av_title')}
          </h2>
          <div className="text-ink-3 mt-1" style={{ fontSize: 12 }}>
            {t('av_capture_hint')}
          </div>
        </div>
        <Btn size="sm" variant="primary" onClick={onCapture} disabled={busy}>
          + {t('av_capture_btn')}
        </Btn>
      </div>

      <div
        className="text-ink-3"
        style={{
          fontSize: 11.5,
          padding: '8px 10px',
          background: 'var(--c-panel)',
          border: '1px solid var(--c-line)',
          borderRadius: 6,
        }}
      >
        ⚠ {t('av_note_code_layer')}
      </div>

      {flash && (
        <div
          className="rounded border"
          style={{
            padding: '8px 12px',
            fontSize: 12.5,
            background: flash.kind === 'ok' ? 'var(--c-ok-bg)' : 'var(--c-err-bg)',
            color: flash.kind === 'ok' ? 'var(--c-ok)' : 'var(--c-err)',
            borderColor:
              flash.kind === 'ok'
                ? 'color-mix(in oklab, var(--c-ok) 25%, transparent)'
                : 'color-mix(in oklab, var(--c-err) 25%, transparent)',
          }}
        >
          {flash.msg}
        </div>
      )}

      {loading && (
        <div className="text-ink-3" style={{ fontSize: 12.5 }}>
          {t('av_loading')}
        </div>
      )}
      {error && (
        <div className="text-err" style={{ fontSize: 12.5 }}>
          {error}
        </div>
      )}

      {!loading && !error && data && data.versions.length === 0 && (
        <EmptyState
          icon={<Ic.workflow />}
          title={t('av_empty_title')}
          hint={t('av_empty_hint')}
          variant="info"
        />
      )}

      {!loading && !error && data && data.versions.length > 0 && (
        <div className="border border-line rounded-lg overflow-hidden">
          <div
            className="grid items-center text-ink-3 border-b border-line"
            style={{
              gridTemplateColumns: '1.4fr 0.8fr 0.9fr 1fr 0.6fr',
              padding: '10px 16px',
              fontSize: 11.5,
              background: 'var(--c-panel)',
            }}
          >
            <div>{t('av_col_label')}</div>
            <div>{t('av_col_status')}</div>
            <div>{t('av_col_captured')}</div>
            <div>{t('av_col_by')}</div>
            <div className="text-right">{t('av_col_actions')}</div>
          </div>
          {data.versions.map((v) => (
            <VersionRow
              key={v.id}
              v={v}
              onDeployClick={() => setConfirmId(v.id)}
              busy={busy}
              t={t}
            />
          ))}
        </div>
      )}

      {confirmId && (
        <DeployConfirmDialog
          version={data?.versions.find((x) => x.id === confirmId) ?? null}
          onConfirm={() => confirmId && onDeploy(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

function VersionRow({
  v,
  onDeployClick,
  busy,
  t,
}: {
  v: AgentVersionRow;
  onDeployClick: () => void;
  busy: boolean;
  t: (k: string) => string;
}) {
  return (
    <div
      className="grid items-center border-b border-line last:border-b-0"
      style={{
        gridTemplateColumns: '1.4fr 0.8fr 0.9fr 1fr 0.6fr',
        padding: '10px 16px',
        fontSize: 12.5,
      }}
    >
      <div className="text-ink-1 tabular-nums">{v.versionLabel}</div>
      <div>
        <StatusBadge status={v.status} t={t} />
      </div>
      <div className="text-ink-2">{relTime(v.createdAt)}</div>
      <div className="text-ink-3 truncate" title={v.generatedBy}>
        {v.generatedBy}
      </div>
      <div className="text-right">
        {v.status === 'active' ? (
          <span className="text-ink-4" style={{ fontSize: 11 }}>
            {t('av_deploy_active')}
          </span>
        ) : (
          <Btn size="sm" variant="ghost" onClick={onDeployClick} disabled={busy}>
            {t('av_deploy_btn')}
          </Btn>
        )}
      </div>
    </div>
  );
}
