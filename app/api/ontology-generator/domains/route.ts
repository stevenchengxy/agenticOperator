// GET /api/ontology-generator/domains
//
// Proxies Allmeta Studio's domain list so the generator's domain selector
// follows the real Allmeta domain ids (baoxiao-v1, nengyuandiaodu-v1, …) — we
// never invent domains here. Falls back to a known list when Allmeta is
// unreachable so the UI is never empty.

import { NextResponse } from "next/server";
import { hasSnapshot } from "@/lib/ontology-generator/ontology-source";

export const dynamic = "force-dynamic";

export type GeneratorDomain = {
  id: string;
  name?: string;
  version?: string;
  lastUpdated?: string;
  /** True when AO has a runnable agent pack (in-repo snapshot) for this domain. */
  runnable: boolean;
};

const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? "";
const ALLMETA_KEY = process.env.ALLMETA_API_KEY ?? "";

// Known Allmeta domains — used as the fallback when Studio is unreachable.
const FALLBACK: Array<Omit<GeneratorDomain, "runnable">> = [
  { id: "nengyuandiaodu-v1", name: "能源调度", version: "1" },
  { id: "baoxiao-v1", name: "报销费控", version: "1" },
  { id: "RAAS-v1", name: "外包招聘本体知识库", version: "0.1" },
  { id: "R7-001", version: "0.1" },
];

async function fetchAllmetaDomains(): Promise<Array<Omit<GeneratorDomain, "runnable">>> {
  if (!ALLMETA_BASE) return FALLBACK;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ALLMETA_BASE.replace(/\/+$/, "")}/api/domains`, {
      headers: ALLMETA_KEY ? { Authorization: `Bearer ${ALLMETA_KEY}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK;
    const body = (await res.json()) as { domains?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.domains) ? body.domains : [];
    if (list.length === 0) return FALLBACK;
    return list.map((d) => ({
      id: String(d.id ?? ""),
      name: typeof d.name === "string" ? d.name : undefined,
      version: d.version != null ? String(d.version) : undefined,
      lastUpdated: typeof d.lastUpdated === "string" ? d.lastUpdated : undefined,
    }));
  } catch {
    return FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const raw = await fetchAllmetaDomains();
  const domains: GeneratorDomain[] = raw
    .filter((d) => d.id)
    .map((d) => ({ ...d, runnable: hasSnapshot(d.id) }));
  return NextResponse.json({ domains });
}
