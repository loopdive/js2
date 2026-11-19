// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7434 — a write to a `const` reached from-ast's mutation pre-pass on the Prepared path and threw
// `IrProgramDriverInvariantError`. The ordinary selector refuses it (`const-write`, #7014); the Prepared source
// producer now asks the same predicate per unit, before lowering, and refuses by name.
import { describe, expect, it } from "vitest";
import {
  compile,
  requiredPreparedEmission,
  requiredPreparedFailure,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (skipSemanticDiagnostics: boolean): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.ts",
    ...(skipSemanticDiagnostics ? { skipSemanticDiagnostics: true } : {}),
  }) as Test262CompileOptions;

const fn = (body: string): string => `export function f(): number { const c = 1; ${body} return c; }`;

/** [shape, program] — every write sits in a nested position the pre-pass would otherwise reach. */
const WRITES: readonly (readonly [string, string])[] = [
  ["plain assignment", fn("c = 2;")],
  ["module-init assignment", "const c = 1; c = 2;"],
  ["`++` in a nested block", fn("if (c) { c++; }")],
  ["compound assignment in a loop body", fn("for (let i = 0; i < 1; i++) c += 2;")],
  ["destructuring target", fn("[c] = [2];")],
  ["for-of head", fn("for (c of [2]) {}")],
  ["module-init `--` in a nested block", "const c = 1; { c--; }"],
];

describe("#7434 Prepared entry refuses a write to a `const` by name", () => {
  it.each(WRITES)("%s: refused before lowering under skipSemanticDiagnostics", async (_shape, source) => {
    const result = await compile(source, options(true));
    expect(result.success).toBe(false);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    const failure = requiredPreparedFailure(result) as { kind: string; failure?: Record<string, unknown> };
    expect(failure.kind).toBe("unsupported");
    expect(failure.failure).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "select" });
    expect(result.errors.map((error) => error.message)).toEqual(['const-write: write to const "c"']);
  });

  it.each(WRITES)("%s: refused, never an invariant, with semantic diagnostics", async (_shape, source) => {
    const result = await compile(source, options(false));
    expect(result.success).toBe(false);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) expect(error.message).not.toMatch(/mutation pre-pass|invariant/i);
  });

  it("a `const` that is only read, and a shadowing `let` that is written, still compile", async () => {
    const result = await compile(
      "const c = 1; export function f(): number { let c = 2; c++; return c; } export function g(): number { return c; }",
      options(true),
    );
    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(requiredPreparedEmission(result)).toBeDefined();
  });
});
