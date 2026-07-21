"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { PageContext } from "./types";

/**
 * Maps the current route + URL params into a PageContext object that the
 * chatbot uses to anchor its system prompt. Lets the bubble feel like it
 * knows what the user is looking at without the user copy-pasting IDs.
 */
export function usePageContext(): PageContext {
  const pathname = usePathname();
  const sp = useSearchParams();

  return useMemo(() => {
    const route = pathname ?? "/";
    const ctx: PageContext = { route };

    // /monitor?run=R-...
    if (route.startsWith("/monitor")) {
      const r = sp.get("run");
      if (r) ctx.runId = r;
    }
    // /monitor/runs/[id]
    const runMatch = route.match(/^\/monitor\/runs\/([^/]+)/);
    if (runMatch) ctx.runId = decodeURIComponent(runMatch[1]);

    // /rule-check?view=audits&auditId=A-...
    if (route.startsWith("/rule-check")) {
      const a = sp.get("auditId");
      if (a) ctx.auditId = a;
    }

    // /entities/[type]/[id]
    const entityMatch = route.match(/^\/entities\/([^/]+)\/([^/]+)/);
    if (entityMatch) {
      ctx.entityType = entityMatch[1];
      ctx.entityId = decodeURIComponent(entityMatch[2]);
    }

    // /workflow + agent query
    if (route === "/workflow") {
      const a = sp.get("agent");
      if (a) ctx.agentShort = a;
    }

    return ctx;
  }, [pathname, sp]);
}
