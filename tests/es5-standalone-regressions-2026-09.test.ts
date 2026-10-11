// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 standalone regressions, 2026-09-23 → 09-28 (ES5 9,028 → 9,021 of 9,029).
 *
 * Each block pins one mechanism that broke while the per-edition ratchet was
 * blind (see scripts/test262-edition-ratchet.ts, check 3), with the test262 row
 * it reproduces. ES5 is a completed edition: none of these may regress again.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(body: string, prelude = ""): Promise<unknown> {
  const src = `${prelude}\nexport function test(): any {\n${body}\n}`;
  const r = (await compile(src, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("ES5 · Boolean wrapper toString reads [[BooleanData]] (S15.6.4.2_A1_T1/T2, S11.2.1_A3_T1)", () => {
  // #6205 made ToPrimitive(wrapper, string) return the spec'd STRING; the
  // Boolean toString lowering unboxed that string as a boolean and printed
  // "false" for every `new Boolean(true)`.
  it('new Boolean(true).toString() is "true"', async () => {
    expect(await run(`return new Boolean(true).toString() === "true" ? 1 : 0;`)).toBe(1);
  });
  it('new Boolean(false).toString() is "false"', async () => {
    expect(await run(`return new Boolean(false).toString() === "false" ? 1 : 0;`)).toBe(1);
  });
  it("extra arguments are ignored", async () => {
    // The test262 row's own shape; `toString` takes no parameters, so the
    // extra argument is a type error that skipSemanticDiagnostics lets through.
    expect(await run(`return new Boolean(true).toString(false) === "true" ? 1 : 0;`)).toBe(1);
  });
  it("a wrapper held in a variable", async () => {
    expect(await run(`var b = new Boolean(1); return b.toString() === "true" ? 1 : 0;`)).toBe(1);
  });
});

describe("ES5 · a `new F()` instance classifies as Object, not Function (S11.1.1_A3.2)", () => {
  // #6131 seeded the %Function.prototype% companion; `new F()` instances share
  // the closure-carrier predicate (for expandos), so a dynamic `.toString` on
  // one resolved to Function.prototype.toString and threw its brand TypeError.
  it("a dynamic toString on an instance of a plain constructor", async () => {
    const r = await run(
      `var holder: any = { v: null }; holder.v = new (F as any)(); return holder.v.toString() === "[object Object]" ? 1 : 0;`,
      `function F(this: any) { this.x = 1; }`,
    );
    expect(r).toBe(1);
  });
});

describe("ES5 · `Object(sym) instanceof Symbol` (harness/deepEqual-primitives)", () => {
  // #6051 made Object(sym) a real [[PrimitiveValue]] wrapper; the standalone
  // wrapper instanceof did not know the Symbol brand, so deepEqual stopped
  // treating a boxed symbol as a primitive.
  it("a Symbol wrapper is an instance of Symbol", async () => {
    expect(await run(`var s = Symbol(); return (Object(s) as any) instanceof Symbol ? 1 : 0;`)).toBe(1);
  });
  it("a bare symbol is not", async () => {
    expect(await run(`var s: any = Symbol(); return s instanceof Symbol ? 1 : 0;`)).toBe(0);
  });
});

describe("ES5 · boolean[] keeps its brand when an integer i32 array registered first (S15.4.4.2_A1_T3)", () => {
  // Both lower to an `i32` element and shared one registry key, so the first
  // registration fixed the element brand for both. An integer array
  // registered first made a boolean[] widened into an any[] print `1`.
  it("widening a boolean[] into any[] after an integer array", async () => {
    const r = await run(
      `var ints: number[] = new Array(1, 2, 3); var b: any = new Array(true, true, true); return (b.toString() === "true,true,true" ? 1 : 0) + ints.length * 0;`,
    );
    expect(r).toBe(1);
  });
});
