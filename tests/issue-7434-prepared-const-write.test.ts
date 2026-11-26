// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7434 (duplicate #7461) — a write to a `const` on the Prepared path either threw `IrProgramDriverInvariantError`
// out of from-ast (a function-local `const`) or compiled to a plain store (a top-level `const`, where JS throws a
// TypeError). The selector refuses it (`const-write`, #7014); the Prepared path has no selector, so the builder's
// write entries refuse it by name, whatever storage the binding has.
import { describe, expect, it } from "vitest";
import {
  compile,
  requiredPreparedAbortBodies,
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

/** [shape, program, the refusal's detail]: a function body gets the abort row, top-level code refuses the program. */
const IN_FUNCTION: readonly (readonly [string, string, string])[] = [
  ["plain assignment", fn("c = 2;"), 'const-write: assignment to "c" (f)'],
  ["`++` in a nested block", fn("if (c) { c++; }"), 'const-write: increment/decrement of "c" (f)'],
  [
    "compound assignment in a loop body",
    fn("for (let i = 0; i < 1; i++) c += 2;"),
    'const-write: compound assignment to "c" (f)',
  ],
];
const TOP_LEVEL: readonly (readonly [string, string, string])[] = [
  ["assignment", "const c = 1; c = 2;", 'const-write: assignment to "c" (<module-init>)'],
  ["`--` in a nested block", "const c = 1; { c--; }", 'const-write: increment/decrement of "c" (<module-init>)'],
  [
    "assignment the program catches",
    "const c = 1; var t = 0; try { c = 2; } catch (e) { t = 1; } if (t !== 1) throw 2;",
    'const-write: assignment to "c" (<module-init>)',
  ],
];
/** Shapes another refusal stops first; they must still never reach the invariant. */
const OTHER: readonly (readonly [string, string])[] = [
  ["destructuring target", fn("[c] = [2];")],
  ["for-of head", fn("for (c of [2]) {}")],
];

const noInvariant = (result: { errors: readonly { message: string }[] }) => {
  for (const error of result.errors) expect(error.message).not.toMatch(/mutation pre-pass|invariant/i);
};

describe("#7434 Prepared path refuses a write to a `const` by name", () => {
  it.each(IN_FUNCTION)("%s in a function: its body aborts", async (_shape, source, detail) => {
    for (const skip of [true, false]) {
      const result = await compile(source, options(skip));
      noInvariant(result);
      expect(requiredPreparedEmission(result)).toBeDefined();
      expect(requiredPreparedAbortBodies(result)).toMatchObject([{ name: "f", code: "body-shape-rejected", detail }]);
    }
  });

  it.each(TOP_LEVEL)("%s at top level: the program refuses", async (_shape, source, detail) => {
    for (const skip of [true, false]) {
      const result = await compile(source, options(skip));
      noInvariant(result);
      expect(result.success).toBe(false);
      const failure = requiredPreparedFailure(result) as { kind: string; failure?: Record<string, unknown> };
      expect(failure.failure).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", detail });
    }
  });

  it.each(OTHER)("%s: never an invariant", async (_shape, source) => {
    for (const skip of [true, false]) noInvariant(await compile(source, options(skip)));
  });

  it("a `const` that is only read, and a shadowing `let` that is written, still compile", async () => {
    const result = await compile(
      "const c = 1; export function f(): number { let c = 2; c++; return c; } export function g(): number { return c; }",
      options(true),
    );
    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(requiredPreparedEmission(result)).toBeDefined();
    expect(requiredPreparedAbortBodies(result)).toEqual([]);
  });
});
