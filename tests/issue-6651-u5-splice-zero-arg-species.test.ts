// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice U5 — §23.1.3.29 step 11 `A = ? ArraySpeciesCreate(O, 0)` for a
// ZERO-argument `splice()` whose receiver compiles as `externref`, in
// `--target standalone`.
//
// `compileArraySplice`'s zero-argument shortcut ran ArraySpeciesCreate only when
// the receiver compiled to a vec ref; an `externref` receiver was dropped, so
// `@@species` was never consulted and the result was a fresh Array. Every
// test262 module is a runtime-eval module, whose module-global `var array = []`
// compiles as `externref` — that is why
// `built-ins/Array/prototype/splice/create-proto-from-ctor-realm-non-array.js`
// stayed red after its `{concat,filter,map,slice}` siblings passed. The 1+-arg
// splice paths already ran the species prologue on the same receiver.
//
// The pin reaches the same lowering without eval: an `any`-typed binding cast
// to `any[]` compiles as `externref` but dispatches to the native splice.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<number> {
  const source = `
    function id(x: any): any { return x; }
    const CustomCtor: any = function () {};
    const C: any = function () {};
    C[Symbol.species] = CustomCtor;
    export function test(): number {
      let out = 0;
      ${body}
      return out;
    }
  `;
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 U5 — zero-arg splice() on an externref receiver runs ArraySpeciesCreate (standalone)", () => {
  it("constructs C[@@species] for a literal-backed and a call-returned receiver", async () => {
    expect(
      await run(`
        const a1: any = [];
        a1.constructor = C;
        const r1: any = (a1 as any[]).splice();
        if (Object.getPrototypeOf(r1) === CustomCtor.prototype) out += 1;
        const a2: any = id([1, 2]);
        a2.constructor = C;
        const r2: any = (a2 as any[]).splice();
        if (Object.getPrototypeOf(r2) === CustomCtor.prototype) out += 2;
        if (a2.length === 2) out += 4;
      `),
    ).toBe(7);
  });

  it("throws the step-9 TypeError when @@species is not a constructor", async () => {
    expect(
      await run(`
        const a: any = [];
        a.constructor = { [Symbol.species]: 1 };
        try {
          (a as any[]).splice();
        } catch (e) {
          if (e instanceof TypeError) out += 1;
        }
      `),
    ).toBe(1);
  });

  it("guard: without a species constructor the result stays an empty Array (green on base)", async () => {
    expect(
      await run(`
        const a: any = id([1, 2, 3]);
        const r: any = (a as any[]).splice();
        if (Array.isArray(r)) out += 1;
        if (r.length === 0) out += 2;
        if (a.length === 3) out += 4;
        const b: any = [];
        b.constructor = C;
        const r3: any = (b as any[]).splice(0, 0);
        if (Object.getPrototypeOf(r3) === CustomCtor.prototype) out += 8;
      `),
    ).toBe(15);
  });
});
