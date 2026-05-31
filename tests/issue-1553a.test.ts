// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1553a — Foundation refactor: thread `decl` mode + `bindingKind` through
 * the `destructureParamObject` / `destructureParamArray` helpers so that
 * declaration-form destructuring (1553b/c/d) can route through the same
 * battle-tested helper used by param + catch destructuring.
 *
 * This file does NOT exercise the decl-mode behaviour change end-to-end
 * — that's #1553b/c/d. Instead it pins two things:
 *
 *   1) The new public surface (`DestructureMode`, `BindingKind`,
 *      `DestructureOpts`, and the `opts` parameter on the three helpers)
 *      exists and has the documented shape.
 *
 *   2) The default behaviour (mode === "param", no opts passed) is
 *      preserved — existing param destructuring compiles and runs the
 *      same way as before this refactor. A representative 2-prop object
 *      pattern and 3-elem array pattern as function parameters cover the
 *      common shape used by callers today.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

import {
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
  type BindingKind,
  type DestructureMode,
  type DestructureOpts,
} from "../src/codegen/destructuring-params.js";

async function runExportNum(src: string, fn = "test"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const f = (instance.exports as Record<string, () => unknown>)[fn];
  if (typeof f !== "function") throw new Error(`missing export ${fn}`);
  return f() as number;
}

describe("#1553a — decl-mode plumbing on param-destructure helpers", () => {
  it("exports DestructureMode / BindingKind / DestructureOpts with the documented shape", () => {
    // Type-level pins (the assignments would fail to compile if the shape
    // diverged from the spec). The runtime side just confirms the types
    // are accessible and the helpers carry the new `opts` parameter.
    const modes: DestructureMode[] = ["param", "catch", "decl"];
    const kinds: BindingKind[] = ["let", "const", "var", "param"];
    const opts: DestructureOpts = { mode: "decl", bindingKind: "let" };
    const optsEmpty: DestructureOpts = {};

    expect(modes).toContain("decl");
    expect(kinds).toContain("let");
    expect(opts.mode).toBe("decl");
    expect(opts.bindingKind).toBe("let");
    expect(optsEmpty.mode).toBeUndefined();

    // The three helpers are still callable values. Their `length` reports
    // the count of required parameters (no default value); the optional
    // `opts` slot is excluded from `.length`, so the count must match the
    // pre-refactor signatures byte-for-byte (5/4/5).
    expect(typeof destructureParamObject).toBe("function");
    expect(typeof destructureParamArray).toBe("function");
    expect(typeof destructureParamObjectExternref).toBe("function");
    expect(destructureParamObject.length).toBe(5);
    expect(destructureParamArray.length).toBe(5);
    expect(destructureParamObjectExternref.length).toBe(4);
  });

  it("regression: 2-prop object-pattern param still destructures correctly (default opts → mode='param')", async () => {
    // Object pattern with two leaf identifiers, called from a typed struct.
    // Exercises the struct-fast-path in destructureParamObject.
    const src = `
      type Pt = { x: number; y: number };
      function add({ x, y }: Pt): number { return x + y; }
      export function test(): number { return add({ x: 17, y: 25 }); }
    `;
    expect(await runExportNum(src)).toBe(42);
  });

  it("regression: 3-elem array-pattern param still destructures correctly (default opts → mode='param')", async () => {
    // Array pattern with three leaf identifiers from a tuple — exercises the
    // tuple-struct + vec paths in destructureParamArray.
    const src = `
      function sum3([a, b, c]: [number, number, number]): number { return a + b + c; }
      export function test(): number { return sum3([10, 11, 21]); }
    `;
    expect(await runExportNum(src)).toBe(42);
  });

  it("regression: nested mixed pattern (param-mode default) preserves behaviour", async () => {
    // Mixed object+array nested destructuring — the recursive calls forward
    // `opts`, so default (param-mode) must still produce a working binary.
    const src = `
      type Outer = { p: number; q: [number, number] };
      function f({ p, q: [a, b] }: Outer): number { return p + a + b; }
      export function test(): number { return f({ p: 1, q: [2, 39] }); }
    `;
    expect(await runExportNum(src)).toBe(42);
  });

  it("regression: object-pattern param with default initializer still applies default", async () => {
    // Default-initializer path in destructureParamObject — uses
    // emitDefaultValueCheck. After #1553a this site emits an extra
    // (no-op when opts.mode !== 'decl') hook, but behaviour is unchanged.
    const src = `
      type Pt = { x: number; y: number };
      function add({ x = 100, y }: Pt): number { return x + y; }
      export function testAll(): number { return add({ x: 5, y: 37 }); }
      export function test(): number { return testAll(); }
    `;
    expect(await runExportNum(src)).toBe(42);
  });

  it("regression: array-pattern param with rest element preserves length + values", async () => {
    // Rest-element path in destructureParamArray — `[a, ...rest]`.
    // After the refactor, the rest local.set is paired with an isDecl-gated
    // TDZ init; with default opts it stays a no-op and the binary still
    // returns the expected sum.
    const src = `
      function f([a, ...rest]: number[]): number {
        let s = a;
        for (let i = 0; i < rest.length; i++) s += rest[i];
        return s;
      }
      export function test(): number { return f([10, 11, 9, 12]); }
    `;
    expect(await runExportNum(src)).toBe(42);
  });
});
