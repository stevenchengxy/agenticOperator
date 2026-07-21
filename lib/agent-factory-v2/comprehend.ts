import type { BuilderCtx, DomainUnderstanding, FacetKind } from "./types";
import { analyzeFacet } from "./builders/facet-analyst";
import { integrate } from "./builders/integrator";
import type { PersistLlmCall } from "./ledger";

const FACETS: FacetKind[] = ["actions", "events", "rules", "objects"];

export async function comprehendDomain(ctx: BuilderCtx, persist: PersistLlmCall): Promise<DomainUnderstanding> {
  const insights = await Promise.all(FACETS.map((f) => analyzeFacet(ctx, f, persist)));
  const understanding = await integrate(ctx, insights, persist);
  ctx.emit({ t: "understanding.ready", synthesis: understanding.synthesis, counts: understanding.counts });
  return understanding;
}
