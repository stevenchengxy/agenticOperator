"use client";
import React from "react";
import { useApp } from "@/lib/i18n";

// Bilingual display names live in the server-safe lib/agent-display-names.ts
// (no "use client") so server paths can localize too. This module re-exports
// them and adds the React hooks. `displayNameFor` now resolves ANY identifier
// (short / inngest id / app-prefixed slug) → business name.
export {
  AGENT_NAMES_ZH,
  AGENT_NAMES_EN,
  displayNameFor,
} from "@/lib/agent-display-names";
import { displayNameFor } from "@/lib/agent-display-names";

/** Hook-style consumer for React trees — reads the active language from
 *  useApp() and returns the locale-appropriate display name. */
export function useDisplayName(short: string): string {
  const { lang } = useApp();
  return React.useMemo(() => displayNameFor(short, lang), [short, lang]);
}

/** Same as `useDisplayName` but resolves the lang once and returns a
 *  resolver function — handy when rendering a list and avoiding per-row
 *  hook calls. */
export function useDisplayNameResolver(): (short: string) => string {
  const { lang } = useApp();
  return React.useCallback((short: string) => displayNameFor(short, lang), [lang]);
}
