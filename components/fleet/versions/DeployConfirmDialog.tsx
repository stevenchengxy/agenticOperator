'use client';

import React from 'react';
import { useApp } from '@/lib/i18n';
import { Btn } from '@/components/shared/atoms';
import type { AgentVersionRow } from '@/lib/agent-versions/types';

const SERIF =
  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

export function DeployConfirmDialog({
  version,
  onConfirm,
  onCancel,
}: {
  version: AgentVersionRow | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  if (!version) return null;

  // Render the diffable fields so the operator can visually scan them.
  const snap = version.configJson;
  const fields: Array<[string, string]> = snap
    ? [
        ['enabled', String(snap.enabled)],
        ['temperature', snap.temperature == null ? '—' : String(snap.temperature)],
        ['maxRetries', snap.maxRetries == null ? '—' : String(snap.maxRetries)],
        ['tier', snap.tier ?? '—'],
        [
          'maxOutputTokens',
          snap.maxOutputTokens == null ? '—' : String(snap.maxOutputTokens),
        ],
        ['promptAppend', snap.promptAppend ?? '—'],
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: 'color-mix(in oklab, var(--c-ink-1) 40%, transparent)',
      }}
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-line rounded-lg shadow-sh-3"
        style={{ width: 480, maxWidth: '90vw', padding: '20px 22px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          className="m-0 text-ink-1"
          style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 500 }}
        >
          {t('av_deploy_confirm_title')}
        </h3>
        <div className="mt-2 text-ink-2" style={{ fontSize: 13 }}>
          {t('av_deploy_confirm_body')}
        </div>

        <div className="mt-4 border-t border-line">
          <div className="text-ink-3 mt-3 mb-2" style={{ fontSize: 11.5 }}>
            <span className="tabular-nums text-ink-1">{version.versionLabel}</span>{' '}
            · {t('av_config_for')}
          </div>
          {fields.map(([k, v]) => (
            <div
              key={k}
              className="grid items-center"
              style={{
                gridTemplateColumns: '140px 1fr',
                padding: '4px 0',
                fontSize: 12,
              }}
            >
              <span className="text-ink-3">{k}</span>
              <span className="text-ink-1 tabular-nums">{v}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn size="sm" variant="ghost" onClick={onCancel}>
            {t('av_cancel')}
          </Btn>
          <Btn size="sm" variant="primary" onClick={onConfirm}>
            {t('av_deploy_btn')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
