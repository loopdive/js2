import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import type { CompileOptions } from "../src/index.js";

// #2592 — standalone TypedArray.of / TypedArray.from static factories. Both CE'd
//   with "'__get_builtin' (dynamic-shape …) not supported in --target standalone"
//   because the receiver identifier (Int32Array / Uint8Array / …) never reached
//   the Array.of / Array.from native lowerings (keyed on "Array"). Now lowered
//   natively: build the element vec directly (representation fixed by the
//   constructor NAME via typedArrayVecStorage — i8_byte for standalone
//   Uint8Array, f64 otherwise), matching `new TA([...])` fidelity.
//
// Scope (Phase 1): `.of(...)` (no spread) and `.from(arrayLike)` (no mapFn).
// mapFn / spread / non-array iterables fall through to the existing path
// (mapFn integer-width wrapping → #2593).
async function run(source: string, opts: CompileOptions = {}): Promise<Record<string, Function>> {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

const bothModes = (name: string, source: string, expected: number) => {
  it(`${name} (standalone)`, async () => {
    const e = await run(source, { target: "standalone" });
    expect(e.test!()).toBe(expected);
  });
  it(`${name} (gc/host)`, async () => {
    const e = await run(source);
    expect(e.test!()).toBe(expected);
  });
};

describe("#2592 — TypedArray.of static factory", () => {
  bothModes(
    "Int32Array.of(10, 20, 30) → len 3, elements preserved",
    `export function test(): number {
       const a = Int32Array.of(10, 20, 30);
       return a.length * 1000 + a[0] + a[1] + a[2]; // 3060
     }`,
    3060,
  );

  bothModes(
    "Uint8Array.of(1, 2, 3, 4) → len 4",
    `export function test(): number {
       const a = Uint8Array.of(1, 2, 3, 4);
       return a.length * 100 + a[0] + a[3]; // 405
     }`,
    405,
  );

  bothModes(
    "Float64Array.of() → empty (len 0, no trap)",
    `export function test(): number { return Float64Array.of().length; }`,
    0,
  );

  bothModes(
    "Float64Array.of(1.5, 2.5) → fractional values kept",
    `export function test(): number {
       const a = Float64Array.of(1.5, 2.5);
       return a.length * 10 + (a[0] + a[1]); // 24
     }`,
    24,
  );
});

describe("#2592 — TypedArray.from static factory (array-like, no mapFn)", () => {
  bothModes(
    "Int32Array.from([5, 10, 15]) → len 3, elements preserved",
    `export function test(): number {
       const a = Int32Array.from([5, 10, 15]);
       return a.length * 1000 + a[0] + a[1] + a[2]; // 3030
     }`,
    3030,
  );

  bothModes(
    "Float64Array.from(numberVar) → copies a number[] source",
    `export function test(): number {
       const src = [1.0, 2.0, 3.0, 4.0];
       const a = Float64Array.from(src);
       return a.length * 100 + a[0] + a[3]; // 405
     }`,
    405,
  );

  bothModes(
    "Uint8Array.from([7, 8, 9]) → f64 source re-coerced to i8 element",
    `export function test(): number {
       const a = Uint8Array.from([7, 8, 9]);
       return a.length * 100 + a[0] + a[2]; // 316
     }`,
    316,
  );

  bothModes(
    "Uint8Array.from(Uint8Array) → i8 source copied (array.get_u)",
    `export function test(): number {
       const src = Uint8Array.of(100, 50, 25);
       const a = Uint8Array.from(src);
       return a.length * 1000 + a[0] + a[1] + a[2]; // 3175
     }`,
    3175,
  );

  bothModes(
    "Int32Array.from([]) → empty (len 0, no trap)",
    `export function test(): number { return Int32Array.from([]).length; }`,
    0,
  );
});

describe("#2592 — Array.of / Array.from unaffected (no regression)", () => {
  bothModes(
    "Array.of(11, 22, 33) still builds a dense array",
    `export function test(): number {
       const a = Array.of(11, 22, 33);
       return a.length * 100 + a[0] + a[2]; // 344
     }`,
    344,
  );

  bothModes(
    "Array.from([4, 5, 6]) still copies",
    `export function test(): number {
       const a = Array.from([4, 5, 6]);
       return a.length * 100 + a[0] + a[2]; // 310
     }`,
    310,
  );
});
