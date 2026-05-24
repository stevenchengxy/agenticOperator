import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "@/lib/i18n";
import { fetchLiveRegistry } from "@/lib/inngest-registry";

// Fire-and-forget warm-up of the Inngest live registry cache. Sync helpers
// in lib/agent-mapping.ts (isReal/isShell/deploymentKind) read the last
// cached snapshot — first call returns 'unbuilt' until this populates it.
// 5s registry cache prevents per-render Inngest hits. Per spec 2026-05-24.
void fetchLiveRegistry().catch(() => {});

export const metadata: Metadata = {
  title: "Agentic Operator · 智能体操作中枢",
  description: "智能体操作中枢 / OS for AI agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
