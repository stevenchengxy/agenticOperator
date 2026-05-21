"use client";
import React from "react";
import { AppBar } from "./AppBar";
import { LeftNav } from "./LeftNav";
import { CommandPalette } from "./CommandPalette";
import { GlobalChatBubble } from "@/components/chat/GlobalChatBubble";

export function Shell({
  crumbs = [],
  children,
  directionTag,
}: {
  crumbs?: string[];
  children: React.ReactNode;
  directionTag?: string;
}) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-screen w-screen bg-bg text-ink-1 flex flex-col overflow-hidden relative">
      <AppBar crumbs={crumbs} onOpenCmdK={() => setOpen(true)} />
      <div className="flex-1 flex min-h-0">
        <LeftNav />
        <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">{children}</div>
      </div>
      {directionTag && (
        <div className="absolute right-3 bottom-3 text-[10.5px] mono text-ink-4 bg-[color:var(--c-surface)]/80 px-2 py-1 rounded-sm border border-line pointer-events-none z-[5]">
          {directionTag}
        </div>
      )}
      <GlobalChatBubble />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
