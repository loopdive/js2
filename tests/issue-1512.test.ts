// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1512 — dynamic import() early SyntaxError detection.
//
// Test262 has ~190 negative parse-phase tests under
// `language/expressions/dynamic-import/syntax/invalid/` that exercise four
// related grammar shapes:
//
//   1. `import('a', {}, '')` — more than two arguments (`not-extensible-args`).
//   2. `import.UNKNOWN(...)`  — unknown meta-property name (`import-call-unknown`).
//   3. `typeof import.source` — bare `import.source` member access (`typeof-import-source`).
//   4. `typeof import.source.UNKNOWN` — chained member access on
//      `import.source` (`typeof-import-call-source-property`).
//
// The sharded test262 runner compiles with `skipSemanticDiagnostics: true`,
// which suppresses TypeScript's own warnings for these shapes. Without an
// explicit syntactic early-error pass, the compiler accepted the source,
// produced a wasm module, and the runner classified the test as `fail`
// against the expected negative SyntaxError.
//
// Fix:
//   `src/compiler/validation.ts` — broaden the import meta-property check to
//   reject ANY `import.<name>` where name is not `meta`, regardless of
//   whether it appears as a call target or a bare expression. Also reject
//   `import()` / `import.source()` / `import.defer()` with more than two
//   arguments.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function compileAndCollect(src: string): Promise<{
  success: boolean;
  errors: { severity: string; message: string }[];
}> {
  // Mirror the sharded runner: skipSemanticDiagnostics suppresses TS
  // warnings, so the negative-test classification only counts what the
  // syntactic / early-error pass emits.
  const r = await compile(src, {
    fileName: "test.ts",
    emitWat: false,
    skipSemanticDiagnostics: true,
  } as Parameters<typeof compile>[1]);
  return {
    success: r.success,
    errors: r.errors.map((e) => ({ severity: e.severity, message: e.message })),
  };
}

function hasError(errs: { severity: string; message: string }[], pattern: RegExp): boolean {
  return errs.some((e) => e.severity === "error" && pattern.test(e.message));
}

describe("#1512 dynamic import early SyntaxErrors", () => {
  describe("unknown meta-property: import.X (X != meta/source/defer)", () => {
    it("rejects import.UNKNOWN(...) as a call target", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import.UNKNOWN('./x.js'); };\nexport {};\n`);
      expect(hasError(errors, /'import\.UNKNOWN' is not a valid meta-property/)).toBe(true);
    });

    it("rejects bare import.UNKNOWN reference", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import.UNKNOWN; };\nexport {};\n`);
      expect(hasError(errors, /'import\.UNKNOWN' is not a valid meta-property/)).toBe(true);
    });

    it("rejects typeof import.UNKNOWN", async () => {
      const { errors } = await compileAndCollect(`let f = () => { typeof import.UNKNOWN; };\nexport {};\n`);
      expect(hasError(errors, /'import\.UNKNOWN' is not a valid meta-property/)).toBe(true);
    });
  });

  describe("Stage 3 proposals rejected even in non-call positions", () => {
    it("rejects bare import.source (typeof operand)", async () => {
      const { errors } = await compileAndCollect(`let f = () => { typeof import.source; };\nexport {};\n`);
      expect(hasError(errors, /SyntaxError: import\.source\(\.\.\.\) is not supported/)).toBe(true);
    });

    it("rejects bare import.defer (typeof operand)", async () => {
      const { errors } = await compileAndCollect(`let f = () => { typeof import.defer; };\nexport {};\n`);
      expect(hasError(errors, /SyntaxError: import\.defer\(\.\.\.\) is not supported/)).toBe(true);
    });

    it("rejects import.source.X chained property access", async () => {
      // The inner MetaProperty `import.source` is itself a SyntaxError;
      // the outer PropertyAccessExpression doesn't matter.
      const { errors } = await compileAndCollect(`let f = () => { typeof import.source.UNKNOWN; };\nexport {};\n`);
      expect(hasError(errors, /SyntaxError: import\.source\(\.\.\.\) is not supported/)).toBe(true);
    });

    it("still rejects import.source(...) as a call target (#1315 regression)", async () => {
      const { errors } = await compileAndCollect(`async function f() { await import.source('./x.js'); }\nexport {};\n`);
      expect(hasError(errors, /SyntaxError: import\.source\(\.\.\.\) is not supported/)).toBe(true);
    });
  });

  describe("import() / import.X() argument arity (not-extensible-args)", () => {
    it("rejects import('a', {}, '') — 3 args", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import('./x.js', {}, ''); };\nexport {};\n`);
      expect(hasError(errors, /import\(\) takes at most two arguments/)).toBe(true);
    });

    it("rejects import('a', {}, '', 'x') — 4 args", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import('./x.js', {}, '', 'x'); };\nexport {};\n`);
      expect(hasError(errors, /import\(\) takes at most two arguments/)).toBe(true);
    });

    it("still rejects import() — 0 args", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import(); };\nexport {};\n`);
      expect(hasError(errors, /import\(\) requires at least one argument/)).toBe(true);
    });

    it("still rejects import(...['x']) — spread arg", async () => {
      const { errors } = await compileAndCollect(`let f = () => { import(...['']); };\nexport {};\n`);
      expect(hasError(errors, /import\(\) does not allow spread arguments/)).toBe(true);
    });
  });

  describe("import-attributes proposal: 2-arg import() still valid (positive regression)", () => {
    it("import('./x.js', { with: { type: 'json' } }) does not trip the arity check", async () => {
      const { errors } = await compileAndCollect(
        `let f = () => { import('./x.js', { with: { type: 'json' } }); };\nexport {};\n`,
      );
      // Arity-specific errors must NOT fire; module-resolution errors (TS 2792)
      // are downgraded so the call should compile fine.
      expect(errors.filter((e) => e.severity === "error" && /import\(\)/.test(e.message))).toEqual([]);
    });
  });

  describe("import.meta access (positive regression)", () => {
    it("import.meta is accepted", async () => {
      const { errors } = await compileAndCollect(`function f() { return import.meta; }\nexport {};\n`);
      // The standardized meta-property must continue to compile cleanly.
      expect(errors.filter((e) => e.severity === "error" && /import\./.test(e.message))).toEqual([]);
    });
  });
});
