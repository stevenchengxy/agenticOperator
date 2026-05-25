"use client";

// Side-by-side Monaco diff. Left = active saved version's code (or starter
// text if no version exists yet); right = the freshly generated code.
//
// SSR-disabled because Monaco requires the browser `document`.

import dynamic from "next/dynamic";
import React from "react";
import { useApp } from "@/lib/i18n";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false },
);

export function DiffViewer({
  original,
  modified,
  language = "typescript",
  height = "100%",
}: {
  original: string;
  modified: string;
  language?: "typescript" | "json" | "markdown";
  height?: string | number;
}) {
  const { theme } = useApp();
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      theme={theme === "dark" ? "vs-dark" : "vs"}
      height={height}
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        automaticLayout: true,
      }}
    />
  );
}
