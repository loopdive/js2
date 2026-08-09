// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1282) A bare `function f(...): T;` inside a `.d.ts` is an AMBIENT
// declaration and must not be minted as a defined Wasm function.
//
// ## What was wrong
//
// `collectDeclarations` (src/codegen/declarations.ts) guarded its
// function-declaration arm with `if (hasDeclareModifier(stmt)) continue;` under
// a comment that reads "Skip declare function stubs". Inside a `.d.ts` the
// `declare` keyword is IMPLICIT, so a bare signature carries no modifier, the
// guard missed it, and the statement fell through to `mintDefinedFunc` +
// `pushProgramAbiTopLevelCallable` — registering a DEFINED function with an
// empty body for something that has no implementation anywhere.
//
// It has no IR inventory unit (there is no source unit for an ambient
// signature to have one), so the program-ABI registry then aborted the entire
// compile:
//
//     Codegen error: source callable validate has no consistent exact
//     top-level or compiler-support inventory owner
//
// Measured on the real ESLint graph, this was the SINGLE hard error stopping a
// 149-file build, and it came from `json-schema/index.d.ts:733` — a transitive
// type-only dependency that contributes no runtime code at all.
//
// ## The fix
//
// `hasDeclareModifier(stmt) || stmt.getSourceFile().isDeclarationFile` — the
// idiom `declarations.ts` already uses for its variable, class and enum
// statements (`const isAmbient = …`). The function-declaration arm was simply
// out of step with its three siblings, and with its own comment.
//
// ## Non-vacuity
//
// The first rung fails on `main` with the exact abort quoted above. The
// remaining rungs are controls: a real function with the SAME NAME in the entry
// file must still compile and run (so the fix skips only the ambient twin), and
// an explicit `declare function` in a `.ts` file must keep working (that arm was
// already correct and must not regress).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";

const TMP = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp/issue-1282-ambient");

function write(name: string, source: string): string {
  const path = join(TMP, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe("#1282 — ambient function declarations in a .d.ts", () => {
  it("a bare .d.ts signature does not abort the compile", async () => {
    // `validate` here mirrors json-schema/index.d.ts:733 — no `declare`
    // keyword, because inside a .d.ts it is implicit.
    //
    // The entry must IMPORT from the .d.ts. A .d.ts that nothing references is
    // not part of the program and its statements are never walked, so a fixture
    // without this import passes even on unfixed `main` — i.e. it is vacuous.
    // A TYPE-ONLY import is enough to pull it in, which is exactly how ESLint
    // reaches `json-schema/index.d.ts`: as a transitive type dependency that
    // contributes no runtime code.
    write(
      "ambient.d.ts",
      `export function validate(instance: unknown, schema: unknown): boolean;
export function alsoAmbient(x: number): number;
export interface Schema { a: number }
`,
    );
    const entry = write(
      "entry-ambient.ts",
      `import type { Schema } from "./ambient";
export function run(s: Schema): number { return s.a; }
`,
    );

    const result = await compileProject(entry, { allowJs: true, target: "gc", platform: "node" } as never);
    const codegenErrors = result.errors.filter((e) => e.message.startsWith("Codegen error:"));
    expect(
      codegenErrors.map((e) => e.message),
      "an ambient .d.ts signature was minted as a defined function again",
    ).toEqual([]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("does not swallow a REAL function that shares the ambient name", async () => {
    // The control that makes the rung above meaningful: skipping must be scoped
    // to the ambient declaration, not to the name.
    write("ambient2.d.ts", `export function validate(x: unknown): boolean;\nexport interface S2 { b: number }\n`);
    const entry = write(
      "entry-real.ts",
      `import type { S2 } from "./ambient2";
export function validate(x: number): number { return x * 3; }
export function run(s: S2): number { return validate(5) + s.b; }
`,
    );

    const result = await compileProject(entry, { allowJs: true, target: "gc", platform: "node" } as never);
    expect(result.errors.filter((e) => e.message.startsWith("Codegen error:")).map((e) => e.message)).toEqual([]);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.binaryByteLength ?? result.binary?.byteLength ?? 0).toBeGreaterThan(0);
  });

  it("an explicit `declare function` in a .ts still compiles (arm already correct)", async () => {
    const result = await compile(
      `declare function hostThing(x: number): number;
export function test(): number { return 11; }
`,
      { fileName: "t.ts" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
