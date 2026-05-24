"use client";
import React from "react";
import { fetchJson } from "@/lib/api/client";
import type { SystemConfigResponse } from "@/app/api/system/config/route";
import { SystemConfigModal } from "./SystemConfigModal";

// Always-visible Inngest health pill — shown in /fleet and /monitor headers.
// Dot color reflects healthy (green) / unreachable (red); the URL host:port
// is rendered so ops can verify which server is wired without opening config.
// Click opens <SystemConfigModal/> with full detail. Per spec 2026-05-24 §4.2.

const POLL_MS = 5_000;

export function InngestPill() {
  const [cfg, setCfg] = React.useState<SystemConfigResponse | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const tick = () => {
      fetchJson<SystemConfigResponse>("/api/system/config")
        .then(setCfg)
        .catch(() => {/* keep previous */});
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const host = React.useMemo(() => {
    if (!cfg) return "—";
    try {
      const u = new URL(cfg.inngest.url);
      return u.host;
    } catch {
      return cfg.inngest.url;
    }
  }, [cfg]);

  const dotColor = cfg?.inngest.healthy ? "var(--c-ok)" : "var(--c-err)";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-line bg-surface hover:bg-bg-2 text-[11.5px] text-ink-2"
        title={cfg?.inngest.url ?? ""}
      >
        <span
          className="rounded-full"
          style={{ width: 7, height: 7, background: dotColor }}
        />
        <span className="mono">{host}</span>
        {cfg && (
          <span className="text-ink-3">
            · {cfg.inngest.registeredFunctionCount} fn
          </span>
        )}
      </button>
      {open && cfg && <SystemConfigModal cfg={cfg} onClose={() => setOpen(false)} />}
    </>
  );
}
