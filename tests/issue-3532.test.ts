// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3532 — a bare empty array literal `[]` in a conditional under a UNION
// contextual type (e.g. flatMap's callback return `U | readonly U[]`) used to
// resolve to a DIFFERENT WasmGC vec type than a sibling non-empty array in the
// other branch, producing an invalid closure (a Wasm `type error in fallthru`).
//
// Root cause: `compileArrayLiteral`'s empty-`[]` element-type resolution only
// handled a contextual type whose symbol was directly `Array`; a union context
// fell through to the `externref` default while the sibling `[x]` resolved to a
// concrete numeric vec. `resolveEmptyArrayElemWasm` now also mines an array
// member out of a union context so `[]` adopts the sibling's element type and
// the two branches unify. With the source bug fixed, the #2717 a-priori guard
// (`inlineCallbackHasEmptyArrayLiteral`) in the native flatMap arm was removed.
//
// Assertion split: the regression was INVALID Wasm, so the gc lane asserts
// module VALIDITY (its runtime flatMap goes through a host import whose result
// marshalling a bare in-test harness can't fully exercise). The standalone lane
// is fully Wasm-native, so it asserts the RUNTIME flattened length directly.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function gcValid(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  return WebAssembly.validate(r.binary);
}

// flatMap gives its callback the union contextual return type `U | readonly U[]`,
// which is precisely the trigger. `.length` on the flattened result is the
// observable.
function flatMapLen(pre: string, body: string): string {
  return `${pre}const a: number[] = [1, 2, 3];
const r = a.flatMap((x) => (${body}));
export function test(): number { return r.length; }`;
}

describe("#3532 — empty `[]` in a conditional under a union contextual type", () => {
  // The exact acceptance-criteria repro.
  it("standalone: `cond ? [] : [x]` compiles, runs, and flattens correctly", async () => {
    // 1,3 odd -> [1],[3]; 2 even -> []  ⇒ flattened [1,3], length 2.
    expect(await runStandalone(flatMapLen("", "x % 2 === 0 ? [] : [x]"))).toBe(2);
  });

  it("gc lane: `cond ? [] : [x]` produces valid Wasm (was an invalid closure)", async () => {
    expect(await gcValid(flatMapLen("", "x % 2 === 0 ? [] : [x]"))).toBe(true);
  });

  // Full discriminator table from the issue — every shape must produce valid
  // Wasm in both lanes and (standalone) the correct flattened length.
  const table: Array<[string, string, string, number]> = [
    // name, preamble, callback body, expected length
    ["empty first  (? [] : [x])", "", "x % 2 === 0 ? [] : [x]", 2],
    ["empty second (? [x] : [])", "", "x % 2 === 0 ? [x] : []", 1],
    ["empty + var   (? [] : arr)", "const arr = [9];\n", "x % 2 === 0 ? [] : arr", 2],
    ["both lits    (? [x,x] : [x])", "", "x % 2 === 0 ? [x, x] : [x]", 4],
    ["lit + var     (? [x] : arr)", "const arr2 = [9];\n", "x % 2 === 0 ? [x] : arr2", 3],
    ["always empty  (=> [])", "", "[]", 0],
    ["always nonempty (=> [x])", "", "[x]", 3],
  ];

  for (const [name, pre, body, expected] of table) {
    it(`standalone: ${name} → length ${expected}`, async () => {
      expect(await runStandalone(flatMapLen(pre, body))).toBe(expected);
    });
    it(`gc lane: ${name} → valid Wasm`, async () => {
      expect(await gcValid(flatMapLen(pre, body))).toBe(true);
    });
  }

  // The single-array-member union is what we fix. A union with TWO DIFFERENT
  // array element types (`number[] | string[]`) stays ambiguous: `[]` must NOT
  // silently pick one — `resolveEmptyArrayElemWasm` keeps the externref default.
  // (Unifying externref-vec `[]` with a concrete-vec sibling in a conditional is
  // a separate, pre-existing limitation, out of scope here — this test only
  // pins that the conservative guard does not guess a wrong element type.)
  it("standalone: `readonly number[]` direct context also lowers `[]` to a number vec", async () => {
    const src = `function f(): number {
  const cond = 1 > 0;
  const a: readonly number[] = cond ? [] : [7];
  return a.length;
}
export function test(): number { return f(); }`;
    expect(await runStandalone(src)).toBe(0);
  });
});
