"use client";

// Monaco wrapper — SSR-disabled because Monaco needs the browser `document`.
// Per design ref docs/2026-05-25-ao-behavior-codegen-research.md §5.1.

import dynamic from "next/dynamic";
import React from "react";
import { useApp } from "@/lib/i18n";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export function CodeEditor({
  value,
  onChange,
  language = "typescript",
  readOnly = false,
  path,
  height = "100%",
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: "typescript" | "markdown" | "json";
  readOnly?: boolean;
  /** Logical path; Monaco uses this to scope its in-memory model. */
  path?: string;
  height?: string | number;
}) {
  const { theme } = useApp();
  return (
    <Editor
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      language={language}
      path={path}
      theme={theme === "dark" ? "vs-dark" : "vs"}
      height={height}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        automaticLayout: true,
        wordWrap: language === "markdown" ? "on" : "off",
        tabSize: 2,
      }}
    />
  );
}
