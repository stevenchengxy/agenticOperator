// Per-domain Inngest serve endpoint.
//
// /api/inngest/<domain> serves the Inngest app `agentic-operator-<domain>` whose
// functions are the DEPLOYED ontology-generated agents for that domain (built
// from the DB on each request via getDomainServeHandler). Registered with the
// Inngest dev server by POST /api/domains/<id>/inngest-app { action: 'register' }.

import type { NextRequest } from "next/server";
import { getDomainServeHandler } from "@/server/inngest/domain-app";
import { bootOnce } from "@/server/init";

bootOnce();

type RouteContext = { params: Promise<{ domain: string }> };

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { domain } = await ctx.params;
  const h = await getDomainServeHandler(domain);
  return h.GET(req, ctx as never);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { domain } = await ctx.params;
  const h = await getDomainServeHandler(domain);
  return h.POST(req, ctx as never);
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { domain } = await ctx.params;
  const h = await getDomainServeHandler(domain);
  return h.PUT(req, ctx as never);
}
