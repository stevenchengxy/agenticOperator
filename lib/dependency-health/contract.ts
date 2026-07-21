// Shared wire contract for the Dependency Health surface — imported by BOTH the
// route (app/api/dependency-health/route.ts) and the client card
// (components/fleet/DependencyHealthCard.tsx) so they can't drift. Type-only, so
// importing it into the client bundle pulls in no server code.

import type { ProviderHealth } from './summarize';

export type { ProviderSeverity } from './summarize';

export interface DependencyHealthRow extends ProviderHealth {
  /** Firing alert id in the 消息通知 center, for deep-linking (null when none). */
  notificationId: string | null;
}

export interface DependencyHealthResponse {
  providers: DependencyHealthRow[];
  windowMinutes: number;
  generatedAt: string;
  /** True when a read failed and the payload is a safe healthy fallback. */
  partial: boolean;
}
