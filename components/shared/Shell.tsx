"use client";
import React from "react";
import { AppBar } from "./AppBar";
import { LeftNav } from "./LeftNav";
import { CommandPalette } from "./CommandPalette";
import { GlobalChatBubble } from "@/components/chat/GlobalChatBubble";
import { HelpTip } from "./HelpTip";

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
      {directionTag && process.env.NODE_ENV === "development" && (
        <HelpTip tip={directionTag} placement="top" className="absolute left-3 bottom-3 z-[5]" />
      )}
      <GlobalChatBubble />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
