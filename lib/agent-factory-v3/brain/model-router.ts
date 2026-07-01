// #7 — task-difficulty model routing with fallback chains. Config-driven, NO hardcoded model
// ids beyond the existing FLASH/STRONG defaults (which already exist in stream-gateway). Each tier
// reads a comma-separated env chain (preferred first, then fallbacks) and always ends in the tier's
// base model + the flash model, so the brain always has a model to try and any deploy can tune per
// tier without a code change:
//
//   FACTORY_MODEL_FAST=google/gemini-3-flash-preview,openai/gpt-5.4-mini    # reading / planning
//   FACTORY_MODEL_DEFAULT=anthropic/claude-sonnet-4-6                        # general reasoning
//   FACTORY_MODEL_HARD=anthropic/claude-sonnet-4-6,openai/gpt-5.5           # design / code / refine
//
// streamTurn tries the chain in order, falling through on a model the gateway can't serve, and
// reports which model actually served the turn so the activity log can annotate it.

import { FACTORY_FLASH_MODEL, FACTORY_STRONG_MODEL } from "./stream-gateway";

export type ModelTier = "fast" | "default" | "hard";

/** The ordered model chain for a tier — preferred env models first, then the tier's base model and
 *  the flash model as ultimate fallbacks (deduped), so there is always at least one model. */
export function modelChain(tier: ModelTier, env: Record<string, string | undefined> = process.env): string[] {
  const flash = env.FACTORY_AI_MODEL || FACTORY_FLASH_MODEL;
  const strong = env.FACTORY_STRONG_MODEL || FACTORY_STRONG_MODEL || flash;
  const raw = tier === "hard" ? env.FACTORY_MODEL_HARD : tier === "fast" ? env.FACTORY_MODEL_FAST : env.FACTORY_MODEL_DEFAULT;
  const chain = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const base = tier === "fast" ? flash : strong; // cheap tiers fall back to flash, harder tiers to strong
  const out = [...chain, base, flash].filter((m, i, a) => m && a.indexOf(m) === i);
  return out.length ? out : [flash];
}

/** Pick a tier from the brain's live context: cheap/fast while reading + planning, strong once it's
 *  designing/coding/refining/validating (where output quality matters most). Heuristic, not a hard
 *  route — any turn can still call any tool; this only sets the model budget. */
export function tierForContext(ctx: { specs: { length: number }; currentPlan: unknown }): ModelTier {
  if (ctx.specs.length > 0) return "hard"; // designing / coding / refining / validating
  if (ctx.currentPlan) return "default"; // plan exists, about to design
  return "fast"; // reading ontology / initial planning
}
