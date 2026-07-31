// Agent Factory kill switch.
//
// The factory (v2 + v3 authoring brain, its UI and its /api/factory-v3 routes)
// has moved to the standalone monorepo. The code is still in this repo for
// reference and for the generated-agent runtime it left behind, but a
// PRODUCTION DEPLOYMENT MUST NOT SERVE IT — no factory pages, no factory API,
// no nav entry, no skills-library/tools-library volumes.
//
// Default: ON in development (local work is unchanged), OFF in production.
// Set FACTORY_ENABLED=1 to deliberately re-enable it on a deployed instance.
//
// NOTE: this is the authoritative, server-side gate. `LeftNav` additionally
// reads NEXT_PUBLIC_FACTORY_ENABLED to decide whether to render the menu item;
// that one is a build-time value and only controls whether the link is shown.
// Keep the two in sync — `scripts/make-deploy-bundle.sh` sets both to 0.

function flagFromEnv(raw: string | undefined): boolean | null {
  if (raw == null || raw === '') return null;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** Server-side truth: may this instance serve the agent factory at all? */
export function isFactoryEnabled(): boolean {
  const explicit = flagFromEnv(process.env.FACTORY_ENABLED);
  if (explicit !== null) return explicit;
  return process.env.NODE_ENV !== 'production';
}
