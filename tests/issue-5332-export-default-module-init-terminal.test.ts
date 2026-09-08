// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5332 — a source whose top-level runtime work is an `export default …`
// statement must own a module-init terminal.
//
// Two sides of the IR disagreed about what an `ExportAssignment` is:
//
//   * `src/ir/module-init-plan.ts` records an `export-assignment` EVALUATION
//     for one, which is right — the direct front end queues that statement into
//     `ctx.moduleInitStatements` (the `__default_expr_N` snapshot-cell arm in
//     `declarations.ts`), and `reconcileIrModuleInitPlan` compares the plan's
//     order against exactly that queue.
//   * `src/ir/identity.ts` minted no `module-init` TERMINAL for one, because
//     `collectModuleInitPopulation` excludes export assignments — also right on
//     its own terms: that population becomes a synthetic function BODY, and an
//     export assignment is not a statement that can appear in one.
//
// Nothing reconciled "the source performs module-init work this population
// cannot express", so a source whose only top-level statement was
// `export default g;` read `executable` in its plan with no terminal to join.
// #3525's census (`multi-prepared-module-init-census.ts`) asserts those two
// agree, which turned the silent disagreement into a hard compile error:
//
//   multi-prepared-module-init-census:terminal-join: executable source
//   ir-source:v1:…:source:dep.js lost its exact module-init terminal
//
// Every multi-file project with such a dependency stopped compiling. Measured
// cost on the day it was found: jest 299/356 → 293/356 (its
// `packages/jest-config/src/stringToBytes.ts` ends in
// `export default stringToBytes;`, taking all 28 of that file's tests with it)
// and prettier 61/151 → 2/151. It also masked #5328, whose only reproducing
// shape is the one that no longer compiled.
//
// The fix mints the terminal. It does NOT add the statement to the lowerable
// population, so `assessModuleInit` still reports `stmtCount: 0` for an
// export-assignment-only source and the direct path remains the emitter —
// identity's inventory just stops under-reporting what the source owns.
//
// Fixtures are untyped `.js` in a multi-file project on purpose: the census is
// the MULTI-prepared one, so a single-source graph never runs it, and the
// failure needs no type annotation to reproduce.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5332-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

function failureText(result: CompileResult): string {
  return (result.errors ?? []).map((error) => String(error.message)).join(" | ");
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

async function compileAndRun(files: Record<string, string>, entry: string): Promise<unknown> {
  const result = await compileFixture(files, entry);
  // Name the census error explicitly. It arrives as a plain `Codegen error:`
  // with `success: false` and an otherwise unremarkable message, so a bare
  // `expect(success).toBe(true)` would not say which regression came back.
  expect(failureText(result)).not.toContain("multi-prepared-module-init-census");
  expect(result.success, failureText(result)).toBe(true);
  const exports = await instantiate(result);
  return (exports.a as () => unknown)();
}

describe("#5332 `export default <expr>` owns a module-init terminal", () => {
  it("compiles and runs when a dependency's only statement is `export default <identifier>`", async () => {
    // The exact shape that stopped compiling, and the exact shape #5328 needs.
    expect(
      await compileAndRun(
        {
          "dep.js": `function g(input) { return 42; }\nexport default g;\n`,
          "main.js": `import g from './dep.js';\nexport function a() { return g(5); }\n`,
        },
        "main.js",
      ),
    ).toBe(42);
  });

  it("compiles when the default is an EXPRESSION, not just a hoisted identifier", async () => {
    // The "only a bare `Identifier`" narrowing considered while diagnosing this
    // would have left this one broken: it failed identically before the fix.
    expect(
      await compileAndRun(
        {
          "dep.js": `export default 41 + 1;\n`,
          "main.js": `import v from './dep.js';\nexport function a() { return v; }\n`,
        },
        "main.js",
      ),
    ).toBe(42);
  });

  it("compiles when the ENTRY file carries the export assignment", async () => {
    // Also failed before the fix, on the entry source rather than a dependency.
    const result = await compileFixture(
      {
        "dep.js": `export function h() { return 1; }\n`,
        "main.js": `import { h } from './dep.js';\nfunction g(input) { return 42 + h(); }\nexport default g;\n`,
      },
      "main.js",
    );
    expect(failureText(result)).not.toContain("multi-prepared-module-init-census");
    expect(result.success, failureText(result)).toBe(true);
  });

  it("compiles when two dependencies each carry one", async () => {
    // Two executable sources, so the census cannot be satisfied by whichever
    // single source happens to own the prepared module-init.
    expect(
      await compileAndRun(
        {
          "d1.js": `function g() { return 40; }\nexport default g;\n`,
          "d2.js": `function h() { return 2; }\nexport default h;\n`,
          "main.js": `import g from './d1.js';\nimport h from './d2.js';\nexport function a() { return g() + h(); }\n`,
        },
        "main.js",
      ),
    ).toBe(42);
  });

  it("preserves the shapes that already worked", async () => {
    // These three compiled before the fix — two because they are not export
    // assignments at all, one because a sibling statement minted the terminal.
    // They are the proof that minting the terminal did not move emission off
    // the direct path for anything that was already being emitted.
    expect(
      await compileAndRun(
        {
          "dep.js": `export default function g(input) { return 42; }\n`,
          "main.js": `import g from './dep.js';\nexport function a() { return g(5); }\n`,
        },
        "main.js",
      ),
    ).toBe(42);

    expect(
      await compileAndRun(
        {
          "dep.js": `function g(input) { return 42; }\nexport { g as default };\n`,
          "main.js": `import g from './dep.js';\nexport function a() { return g(5); }\n`,
        },
        "main.js",
      ),
    ).toBe(42);

    expect(
      await compileAndRun(
        {
          "dep.js": `let z = 1;\nfunction g(input) { return 42 + z; }\nexport default g;\n`,
          "main.js": `import g from './dep.js';\nexport function a() { return g(5); }\n`,
        },
        "main.js",
      ),
    ).toBe(43);
  });
});
