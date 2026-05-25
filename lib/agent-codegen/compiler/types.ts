// Public types for the AO codegen compiler.
// Used both by lib/agent-codegen/compiler/compile.ts (server) and by the
// codegen page UI (Phase 1a CompilerPanel — wire-up later).

import type { DomainId } from '@/lib/domains';

/** A single TypeScript diagnostic. Mirrors what Monaco needs for markers. */
export type Diagnostic = {
  /** Project-relative path (e.g. 'server/inngest/agents/foo-agent.ts'). */
  file: string;
  /** 1-indexed line. */
  line: number;
  /** 1-indexed column. */
  column: number;
  severity: 'error' | 'warning';
  /** TS diagnostic code (e.g. 2307 for missing module). */
  code: number;
  message: string;
  /** Broad bucket derived from `code`. Useful for UI grouping. */
  category: 'import' | 'type' | 'syntax' | 'other';
};

/** A virtual file overlaid on top of the on-disk repo for this compile pass. */
export type VirtualFile = {
  /** Path relative to repo root. */
  path: string;
  content: string;
};

export type CompileRequest = {
  files: VirtualFile[];
  /** Reserved for per-domain tsconfig in future; ignored in MVP. */
  domain?: DomainId;
};

export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  durationMs: number;
  filesCompiled: number;
};
