import { describe, it, expect } from 'vitest';
import { compile } from './compile';

// These tests exercise the in-process TS compiler overlay end-to-end against
// the real project tsconfig. Each compile pass loads the full project once,
// so the suite is intentionally small (4 cases) — enough to lock in the
// contract for valid/invalid/import/type-error scenarios.

describe('compile (overlay TS compiler)', () => {
  it('returns ok=true for a trivial valid file', async () => {
    const res = await compile({
      files: [
        {
          path: 'server/inngest/agents/__compile_test_valid.ts',
          content: `export const x: number = 1;\n`,
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics).toEqual([]);
    expect(res.filesCompiled).toBe(1);
  });

  it('flags a missing import as an error with file/line/code', async () => {
    const res = await compile({
      files: [
        {
          path: 'server/inngest/agents/__compile_test_missing_import.ts',
          content: `import { doesNotExist } from '@/lib/this-module-does-not-exist';\nconsole.log(doesNotExist);\n`,
        },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.length).toBeGreaterThan(0);
    const importErr = res.diagnostics.find((d) => d.category === 'import');
    expect(importErr).toBeDefined();
    expect(importErr!.severity).toBe('error');
    expect(importErr!.line).toBe(1);
    expect(importErr!.code).toBe(2307);
    expect(importErr!.file).toContain('__compile_test_missing_import.ts');
  });

  it('flags a type mismatch as an error', async () => {
    const res = await compile({
      files: [
        {
          path: 'server/inngest/agents/__compile_test_bad_type.ts',
          content: `const n: number = "string-not-number";\nexport default n;\n`,
        },
      ],
    });
    expect(res.ok).toBe(false);
    const typeErr = res.diagnostics.find((d) => d.category === 'type');
    expect(typeErr).toBeDefined();
    expect(typeErr!.severity).toBe('error');
  });

  it('resolves @/ alias against the real project (no error on existing import)', async () => {
    // Import an actual symbol from the real project to confirm alias resolution works.
    const res = await compile({
      files: [
        {
          path: 'server/inngest/agents/__compile_test_alias.ts',
          content: `import { AGENT_MAP } from '@/lib/agent-mapping';\nexport const n = AGENT_MAP.length;\n`,
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics).toEqual([]);
  });
});
