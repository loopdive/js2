// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1151 — destructuring an OBJECT binding-pattern parameter of a function /
// arrow EXPRESSION against null/undefined silently returned undefined instead
// of throwing a synchronous TypeError (RequireObjectCoercible, ECMA-262 §8.6.2
// step 1). The array-pattern arm and the function-DECLARATION path already
// guarded, but `compileFunctionExpression`'s object-pattern arm calls
// `destructureParamObjectExternref` directly — which lacked the
// null/undefined guard. Fix: emit `emitExternrefDestructureGuard` at the top
// of that helper.
//
// These exercise the host/gc lowering (the bug manifests identically there);
// each compiles and runs `test()`, asserting it returns 1 when the expected
// TypeError was thrown and caught, else 0.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function run(source: string): Promise<unknown> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#1151 — object-pattern param RequireObjectCoercible", () => {
  it("arrow object pattern throws on null", async () => {
    const out = await run(`
      const f = ({a}: any): number => (a as number);
      export function test(): number {
        try { f(null); return 0; } catch (e) { return 1; }
      }
    `);
    expect(out).toBe(1);
  });

  it("arrow object pattern throws on undefined", async () => {
    const out = await run(`
      const f = ({a}: any): number => (a as number);
      export function test(): number {
        try { f(undefined as any); return 0; } catch (e) { return 1; }
      }
    `);
    expect(out).toBe(1);
  });

  it("empty object pattern still throws on null (RequireObjectCoercible runs first)", async () => {
    const out = await run(`
      const f = ({}: any): number => 0;
      export function test(): number {
        try { f(null); return 0; } catch (e) { return 1; }
      }
    `);
    expect(out).toBe(1);
  });

  it("nested array pattern param throws on inner null (pre-existing, regression watch)", async () => {
    const out = await run(`
      function f([[x]]: any): number { return x as number; }
      export function test(): number {
        try { f([null]); return 0; } catch (e) { return 1; }
      }
    `);
    expect(out).toBe(1);
  });

  it("valid object argument is unaffected — fields are read", async () => {
    const out = await run(`
      const f = ({a}: any): number => (a as number);
      export function test(): number { return f({a: 5}); }
    `);
    expect(out).toBe(5);
  });

  it("nested object pattern reads through on a valid argument", async () => {
    const out = await run(`
      const f = ({a: {b}}: any): number => (b as number);
      export function test(): number { return f({a: {b: 7}}); }
    `);
    expect(out).toBe(7);
  });

  it("object-pattern default applies for a missing key on a valid object", async () => {
    const out = await run(`
      const f = ({a = 9}: any): number => (a as number);
      export function test(): number { return f({}); }
    `);
    expect(out).toBe(9);
  });

  it("rest in object pattern works on a valid object", async () => {
    const out = await run(`
      const f = ({a, ...r}: any): number => (a as number);
      export function test(): number { return f({a: 1, b: 2, c: 3}); }
    `);
    expect(out).toBe(1);
  });
});
