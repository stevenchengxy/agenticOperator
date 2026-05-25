// In-process TypeScript compiler for codegen output.
//
// Approach: use the TS Compiler API to typecheck virtual files (LLM-generated
// agent code) AS IF they lived inside the project, so `@/lib/...` aliases
// resolve and imports of existing agents/libs typecheck against their real
// signatures. We override `readFile` / `fileExists` / `getSourceFile` on the
// CompilerHost so virtual files shadow disk paths.
//
// We deliberately avoid a sandbox subprocess (`tsc --noEmit` in /tmp) because:
//   1. In-process API is faster (no spawn cost, no node_modules symlink dance).
//   2. tsc only typechecks — no code is executed — so there is no isolation
//      benefit from running it out-of-process.
//
// Diagnostics are FILTERED to the virtual files only — we don't surface
// pre-existing errors elsewhere in the project, since the operator only cares
// about what they (or the LLM) just wrote.

import * as path from 'node:path';
import * as ts from 'typescript';
import type { CompileRequest, CompileResult, Diagnostic, VirtualFile } from './types';

const ROOT = process.cwd();

export async function compile(req: CompileRequest): Promise<CompileResult> {
  const t0 = Date.now();

  const parsed = loadTsConfig();
  const virtualFiles = buildVirtualFileMap(req.files);

  const host = makeOverlayHost(parsed.options, virtualFiles);
  const roots = [...parsed.fileNames];
  for (const abs of virtualFiles.keys()) {
    if (!roots.includes(abs)) roots.push(abs);
  }

  const program = ts.createProgram({ rootNames: roots, options: parsed.options, host });

  // Filter to virtual-file diagnostics only.
  const raw: ts.Diagnostic[] = [];
  for (const abs of virtualFiles.keys()) {
    const sf = program.getSourceFile(abs);
    if (!sf) {
      raw.push({
        category: ts.DiagnosticCategory.Error,
        code: 0,
        file: undefined,
        start: undefined,
        length: undefined,
        messageText: `Virtual file did not load into program: ${path.relative(ROOT, abs)}`,
      });
      continue;
    }
    raw.push(...program.getSyntacticDiagnostics(sf));
    raw.push(...program.getSemanticDiagnostics(sf));
  }

  const diagnostics = raw.map(formatDiagnostic);
  const ok = diagnostics.every((d) => d.severity !== 'error');

  return {
    ok,
    diagnostics,
    durationMs: Date.now() - t0,
    filesCompiled: virtualFiles.size,
  };
}

function loadTsConfig(): ts.ParsedCommandLine {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json not found');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      'Failed to read tsconfig: ' +
        ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
}

function buildVirtualFileMap(files: VirtualFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const abs = path.isAbsolute(f.path) ? f.path : path.resolve(ROOT, f.path);
    out.set(abs, f.content);
  }
  return out;
}

function makeOverlayHost(
  options: ts.CompilerOptions,
  virtualFiles: Map<string, string>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origGetSourceFile = host.getSourceFile.bind(host);

  host.readFile = (fileName) => {
    const abs = path.resolve(fileName);
    if (virtualFiles.has(abs)) return virtualFiles.get(abs);
    return origReadFile(fileName);
  };
  host.fileExists = (fileName) => {
    const abs = path.resolve(fileName);
    if (virtualFiles.has(abs)) return true;
    return origFileExists(fileName);
  };
  host.getSourceFile = (fileName, lang, onError, shouldCreateNewSourceFile) => {
    const abs = path.resolve(fileName);
    if (virtualFiles.has(abs)) {
      return ts.createSourceFile(fileName, virtualFiles.get(abs)!, lang, true);
    }
    return origGetSourceFile(fileName, lang, onError, shouldCreateNewSourceFile);
  };
  return host;
}

function formatDiagnostic(d: ts.Diagnostic): Diagnostic {
  let file = 'unknown';
  let line = 1;
  let column = 1;
  if (d.file && d.start !== undefined) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
    file = path.relative(ROOT, d.file.fileName) || d.file.fileName;
  }
  return {
    file,
    line,
    column,
    severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    category: categorize(d.code),
  };
}

function categorize(code: number): Diagnostic['category'] {
  // Common buckets the codegen UI groups on. TS codes are stable across versions.
  //   2307 Cannot find module 'x'         → import
  //   2305 Module 'x' has no exported m   → import
  //   2306 File 'x' is not a module       → import
  if (code === 2307 || code === 2305 || code === 2306) return 'import';
  if (code >= 2300 && code < 2900) return 'type';
  if (code >= 1000 && code < 2000) return 'syntax';
  return 'other';
}
