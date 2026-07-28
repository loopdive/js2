// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pin: a type alias of a numeric type must not make the linear backend emit
 * invalid wasm (#3673 round 37, "bug 2").
 *
 * `resolveType` switched on the *source text* of the annotation, so anything
 * that was not spelled `number` / `boolean` / `bigint` / `string` / `void`
 * fell into the `i32` (object-pointer) default. A `number` alias therefore got
 * an `i32` slot in the signature while the body compiled its arithmetic as
 * `f64`, and the module failed validation:
 *
 *   f64.add[0] expected type f64, found local.get of type i32
 *
 * This was reported against `type i32 = number` (the GC lane's native-i32
 * annotation) but it was never `i32`-specific: `type Meters = number` broke
 * identically, which is why the fix resolves the alias through the checker
 * rather than adding more names to the text switch.
 *
 * The linear lane represents every JS number as `f64`. `type i32 = number` is,
 * to TypeScript, exactly `number`, so it lowers as `number` here: valid and
 * numerically correct, just without the GC lane's native-i32 *optimisation*.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function linearExports(source: string): Promise<Record<string, CallableFunction>> {
  const result = await compile(source, { target: "linear" });
  expect(result.errors ?? []).toEqual([]);
  expect(result.success).toBe(true);
  // `WebAssembly.compile` reports *why* a module is invalid; `validate` only
  // says no. Use it so a regression names the offending instruction.
  await WebAssembly.compile(result.binary!);
  expect(WebAssembly.validate(result.binary!)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return instance.exports as unknown as Record<string, CallableFunction>;
}

describe("linear backend: numeric type aliases", { timeout: 60_000 }, () => {
  it("accepts `type i32 = number` in a parameter and a return type", async () => {
    const exports = await linearExports(`
type i32 = number;
export function add(a: i32, b: i32): i32 {
  return a + b;
}
`);
    expect(exports.add(3, 4)).toBe(7);
  });

  it("accepts `type i32 = number` on a local", async () => {
    const exports = await linearExports(`
type i32 = number;
export function scale(a: number): number {
  const factor: i32 = 5;
  return a * factor;
}
`);
    expect(exports.scale(6)).toBe(30);
  });

  it("accepts the alias in a parameter, a return type and a local at once", async () => {
    const exports = await linearExports(`
type i32 = number;
export function combine(a: i32, b: i32): i32 {
  const sum: i32 = a + b;
  let doubled: i32 = sum * 2;
  return doubled;
}
`);
    expect(exports.combine(3, 4)).toBe(14);
  });

  it("accepts an alias-only return type with no parameters", async () => {
    const exports = await linearExports(`
type i32 = number;
export function seven(): i32 { return 7; }
`);
    expect(exports.seven()).toBe(7);
  });

  it("keeps fractional values — the alias does not silently truncate", async () => {
    // The linear lane holds numbers as f64. `type i32 = number` is a hint the
    // backend is free to ignore; what it must never do is emit invalid bytes
    // or quietly change the arithmetic to something the source did not ask for.
    const exports = await linearExports(`
type i32 = number;
export function half(a: i32): i32 { return a / 2; }
`);
    expect(exports.half(7)).toBe(3.5);
  });

  it("is not i32-specific: a domain alias of number behaves the same", async () => {
    const exports = await linearExports(`
type Meters = number;
export function grow(a: Meters): Meters { return a + 1; }
`);
    expect(exports.grow(41)).toBe(42);
  });

  it("handles the other native-width aliases", async () => {
    const exports = await linearExports(`
type i64 = number;
type f32 = number;
export function viaI64(a: i64): i64 { return a + 1; }
export function viaF32(a: f32): f32 { return a + 1; }
`);
    expect(exports.viaI64(41)).toBe(42);
    expect(exports.viaF32(41)).toBe(42);
  });

  it("handles an aliased class field", async () => {
    const exports = await linearExports(`
type i32 = number;
class Counter {
  value: i32;
  constructor(value: i32) { this.value = value; }
  bump(): i32 { return this.value + 1; }
}
export function run(start: number): number {
  const c = new Counter(start);
  return c.bump();
}
`);
    expect(exports.run(41)).toBe(42);
  });

  it("handles an alias of a numeric literal union", async () => {
    const exports = await linearExports(`
type Bit = 0 | 1;
export function flip(b: Bit): number { return b === 0 ? 1 : 0; }
`);
    expect(exports.flip(0)).toBe(1);
    expect(exports.flip(1)).toBe(0);
  });

  it("leaves non-numeric aliases as pointers", async () => {
    // The default must still be "pointer" for reference-shaped aliases — the
    // fix narrows the default, it does not invert it. A string alias round-trips
    // a pointer through a parameter and back out of a return slot.
    //
    // (Aliases of *collection* types — `type Row = number[]` — remain rejected
    // with "Unsupported element access on non-collection type": the collection
    // detector matches source text separately from `resolveType`. That is a
    // pre-existing gap, and it is a clean compile error rather than the invalid
    // bytes this suite pins, so it is left alone here.)
    const exports = await linearExports(`
type Text = string;
export function echoLength(s: Text): number { return s.length; }
export function run(): number { return echoLength("hello world"); }
`);
    expect(exports.run()).toBe(11);
  });
});
