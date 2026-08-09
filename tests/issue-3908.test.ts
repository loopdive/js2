// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3908 — the linear backend's inline `Array.prototype.find` lowering
// (`compileArrayHOF` in src/codegen-linear/index.ts) hard-coded its result
// accumulator local to i32, while the *element* local takes the array's element
// ValType (f64 for `number[]`/`boolean[]`). On a numeric array that produced a
// module which failed Wasm validation at instantiation:
//
//   WebAssembly.instantiate(): Compiling function #50:"run" failed:
//   local.set[0] expected type i32, found local.get of type f64
//
// Both ends of the lowering were wrong, so the shape under test is specifically
// "an f64 element flowing through find's accumulator slot":
//   * inside the loop  — `local.get <elem:f64>` / `local.set <result:i32>`
//   * after the loop   — `local.get <result:i32>` read back into the caller's
//     f64 local (inferExprType sees `number | undefined` → f64)
//
// These tests assert the module VALIDATES and computes the right value, and
// that the i32 (reference-element) path is unregressed. They stay at the
// source level on purpose: the defect was a local-slot ValType mismatch, which
// only a real instantiate can catch.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiateLinear(source: string) {
  const result = await compile(source, { fast: true, target: "linear" });
  expect(result.errors.map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  // The bug was invisible until instantiation — validation is the assertion.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, Function>;
}

/** The body of one `(func $name …)` in the emitted WAT. */
function funcBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `no $${name} in the emitted module`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
}

describe("#3908 linear backend: Array.prototype.find result slot matches the element type", () => {
  it("validates and finds a match in a number[] (the reported repro)", async () => {
    const e = await instantiateLinear(`
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < 3; i = i + 1) {
    const found = arr.find((x: number): boolean => x === 50);
    if (found !== undefined) sum = sum + found;
  }
  return sum;
}`);
    expect(e.run()).toBe(150);
  });

  it("returns the not-found sentinel without trapping when no element matches", async () => {
    // The sentinel must be `f64.const 0` for an f64 element slot, not
    // `i32.const 0` — an i32 zero into an f64 local is the same validation
    // failure, just on the initialization path rather than the store path.
    const e = await instantiateLinear(`
export function run(): number {
  const arr: number[] = [];
  for (let i = 1; i < 20; i = i + 1) {
    arr.push(i);
  }
  const found = arr.find((x: number): boolean => x === 999);
  if (found !== undefined) return found;
  return -1;
}`);
    expect(e.run()).toBe(-1);
  });

  it("keeps a fractional element intact — the slot is a real f64, not a truncated i32", async () => {
    // If the accumulator were ever "fixed" by truncating the element into an
    // i32 slot instead of widening the slot, this returns 2 rather than 2.5.
    const e = await instantiateLinear(`
export function run(): number {
  const arr: number[] = [];
  arr.push(1.5);
  arr.push(2.5);
  arr.push(3.5);
  const found = arr.find((x: number): boolean => x > 2);
  if (found !== undefined) return found;
  return 0;
}`);
    expect(e.run()).toBe(2.5);
  });

  it("still validates for a boolean[] element (also an f64 slot in the linear lane)", async () => {
    const e = await instantiateLinear(`
export function run(): number {
  const arr: boolean[] = [];
  arr.push(false);
  arr.push(true);
  const found = arr.find((x: boolean): boolean => x);
  if (found !== undefined) return 1;
  return 0;
}`);
    expect(e.run()).toBe(1);
  });

  it("does not regress the i32 (reference element) path", async () => {
    // A string[] keeps its element in an i32 pointer slot, so `find`'s
    // accumulator must stay i32 and its sentinel a null pointer.
    const e = await instantiateLinear(`
export function run(): number {
  const arr: string[] = [];
  arr.push("alpha");
  arr.push("beta");
  const found = arr.find((s: string): boolean => s.length === 4);
  if (found !== undefined) return found.length;
  return 0;
}`);
    expect(e.run()).toBe(4);
  });

  it("emits a find accumulator local whose declared type matches the element local", async () => {
    // Structural guard on the lowering itself: whatever the caller does with
    // the value, `__hof_result_*` must be declared with the same ValType as the
    // callback's element parameter. Reading the WAT pins the shape rather than
    // just its observable effect, so a future refactor that reintroduces a
    // hard-coded i32 fails here with a pointed message.
    const result = await compile(
      `
export function run(): number {
  const arr: number[] = [];
  arr.push(7);
  const found = arr.find((x: number): boolean => x === 7);
  if (found !== undefined) return found;
  return 0;
}`,
      { fast: true, target: "linear", emitWat: true, optimize: 0 },
    );
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    // The callback param `x` is an f64 element slot...
    expect(wat).toMatch(/\(local \$x f64\)/);
    // ...so find's accumulator must be f64 too, never i32.
    expect(wat).toMatch(/\(local \$__hof_result_\d+ f64\)/);
    expect(wat).not.toMatch(/\(local \$__hof_result_\d+ i32\)/);
  });

  it("caches a resolved array parameter before scanning it", async () => {
    const result = await compile(
      `
export function run(arr: number[]): number {
  const found = arr.find((x: number): boolean => x === 7);
  if (found !== undefined) return found;
  return 0;
}`,
      { fast: true, target: "linear", emitWat: true, optimize: 0 },
    );
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    const importedFunctionCount = [...wat.matchAll(/^ {2}\(import .+ \(func /gm)].length;
    const definedFunctionNames = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => match[1]);
    const resolverOffset = definedFunctionNames.indexOf("__arr_resolve");
    expect(resolverOffset, "no $__arr_resolve in the emitted module").toBeGreaterThanOrEqual(0);

    const resolverIndex = importedFunctionCount + resolverOffset;
    const run = funcBody(wat, "run");
    expect(run).toMatch(new RegExp(`local\\.get 0\\s+call ${resolverIndex}\\s+local\\.tee 0`));
  });
});
