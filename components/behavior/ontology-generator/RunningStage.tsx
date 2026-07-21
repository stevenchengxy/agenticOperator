"use client";
import React from "react";

// The "agents are running" stage — shared by the inferring and generating
// phases (different captions). Minimal + cool: grid backdrop, a central node
// with orbiting satellites and a pulsing halo, a horizontal scan sweep, and a
// flowing progress bar. All motion is reduced-motion safe (see globals.css).
export function RunningStage({
  title,
  subtitle,
  ticker,
}: {
  title: string;
  subtitle: string;
  ticker: string;
}) {
  return (
    <div className="relative rounded-2xl border border-line bg-bg overflow-hidden" style={{ minHeight: 520 }}>
      {/* Grid backdrop */}
      <div className="absolute inset-0 og-grid pointer-events-none" aria-hidden />

      {/* Horizontal scan sweep */}
      <div className="absolute inset-x-0 top-[34%] h-px pointer-events-none overflow-hidden" aria-hidden>
        <div
          className="og-scan h-px w-1/2 mx-auto"
          style={{ background: "linear-gradient(90deg, transparent, var(--c-accent), transparent)" }}
        />
      </div>

      <div className="relative h-full flex flex-col items-center justify-center text-center px-6" style={{ minHeight: 520 }}>
        {/* Central node + orbits */}
        <div className="relative grid place-items-center" style={{ width: 200, height: 200 }}>
          {/* Halo rings */}
          <span className="absolute rounded-full og-halo" style={{ width: 120, height: 120, border: "1px solid color-mix(in oklab, var(--c-accent) 45%, transparent)" }} aria-hidden />
          <span className="absolute rounded-full og-halo" style={{ width: 120, height: 120, border: "1px solid color-mix(in oklab, var(--c-accent) 30%, transparent)", animationDelay: "1.4s" }} aria-hidden />

          {/* Orbit ring 1 with satellite */}
          <div className="absolute og-orbit" style={{ width: 150, height: 150 }} aria-hidden>
            <span className="absolute left-1/2 -top-1 -translate-x-1/2 w-2 h-2 rounded-full" style={{ background: "var(--c-accent)", boxShadow: "0 0 8px var(--c-accent)" }} />
          </div>
          {/* Orbit ring 2 (reverse) with satellite */}
          <div className="absolute og-orbit-rev" style={{ width: 196, height: 196 }} aria-hidden>
            <span className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-1.5 h-1.5 rounded-full" style={{ background: "color-mix(in oklab, var(--c-accent) 70%, white)" }} />
          </div>
          {/* Faint orbit ring outlines */}
          <span className="absolute rounded-full" style={{ width: 150, height: 150, border: "1px solid color-mix(in oklab, var(--c-line) 80%, transparent)" }} aria-hidden />
          <span className="absolute rounded-full" style={{ width: 196, height: 196, border: "1px solid color-mix(in oklab, var(--c-line) 60%, transparent)" }} aria-hidden />

          {/* Core icon */}
          <div
            className="og-core relative w-[88px] h-[88px] rounded-[22px] grid place-items-center text-white"
            style={{
              background: "linear-gradient(150deg, oklch(0.7 0.13 280), var(--c-accent))",
              boxShadow: "0 8px 30px color-mix(in oklab, var(--c-accent) 50%, transparent)",
            }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </div>
        </div>

        {/* Captions */}
        <h2 className="mt-7 text-[20px] font-semibold text-ink-1">{title}</h2>
        <p className="mt-1.5 text-[13px] text-ink-3">{subtitle}</p>

        {/* Ticker */}
        <div className="mt-6 flex items-center gap-2 text-[12.5px] text-ink-2">
          <span className="w-1.5 h-1.5 rounded-full og-tick" style={{ background: "var(--c-accent)" }} />
          {ticker}
        </div>

        {/* Progress bar with flowing sheen + node dots */}
        <div className="mt-3 w-[300px] max-w-full">
          <div className="relative h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in oklab, var(--c-accent) 22%, transparent)" }}>
            <div className="absolute inset-y-0 w-1/2 og-flow" style={{ background: "linear-gradient(90deg, transparent, var(--c-accent), transparent)" }} />
          </div>
          <div className="mt-2 flex items-center justify-between px-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="w-1 h-1 rounded-full og-tick" style={{ background: "var(--c-accent)", animationDelay: `${i * 0.25}s` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
