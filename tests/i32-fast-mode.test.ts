// (#3907) This suite was written as "fast mode: i32 default numbers" — fast
// mode lowered EVERY TypeScript `number` to a Wasm i32. That is not a
// representation choice, it is a different language: `Math.sqrt(2)` returned 1,
// `100000 * 100000` returned 1410065408, and the `mixed/fibonacci` benchmark
// returned -269,534,592 where JS returns 8,320,400,000 — while being published
// as 1.59x faster than JS.
//
// Fast mode now carries the spec f64 representation like every other lane. i32
// storage/arithmetic is reached ONLY through a proof: the explicit
// `type i32 = number` opt-in (#323/#3673), a `detectI32LoopVar`-proven counter,
// a `collectI32CoercedLocals`-proven local (#1120/#1236/#2789), or an enclosing
// ToInt32. Every VALUE assertion below is unchanged — they were always testing
// small integers, where the two representations agree. The two WAT-shape
// assertions at the bottom were the ones that encoded the unsound premise, and
// they now pin the sound contract instead.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = await compile(source, { fast: true });
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports[exportName] as Function)();
}

describe("fast mode: numbers are IEEE-754 doubles, i32 only where proven", () => {
  it("integer literal returns correct value", async () => {
    expect(await runFast(`export function test(): number { return 42; }`)).toBe(42);
  });

  it("integer addition", async () => {
    expect(await runFast(`export function test(): number { return 10 + 32; }`)).toBe(42);
  });

  it("integer subtraction", async () => {
    expect(await runFast(`export function test(): number { return 50 - 8; }`)).toBe(42);
  });

  it("integer multiplication", async () => {
    expect(await runFast(`export function test(): number { return 6 * 7; }`)).toBe(42);
  });

  it("integer modulo", async () => {
    expect(await runFast(`export function test(): number { return 10 % 3; }`)).toBe(1);
  });

  it("integer comparison (less than)", async () => {
    expect(await runFast(`export function test(): number { return 3 < 5 ? 1 : 0; }`)).toBe(1);
  });

  it("integer comparison (equals)", async () => {
    expect(await runFast(`export function test(): number { return 42 === 42 ? 1 : 0; }`)).toBe(1);
  });

  it("loop counter stays i32", async () => {
    const src = `export function test(): number {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum = sum + i;
      }
      return sum;
    }`;
    expect(await runFast(src)).toBe(45);
  });

  it("function params are i32", async () => {
    const src = `export function test(): number {
      return add(20, 22);
    }
    function add(a: number, b: number): number { return a + b; }`;
    expect(await runFast(src)).toBe(42);
  });

  it("bitwise operations are direct (no f64 conversion)", async () => {
    const src = `export function test(): number { return (0xFF & 0x0F) | 0x30; }`;
    expect(await runFast(src)).toBe(0x3f);
  });

  it("negative numbers work", async () => {
    expect(await runFast(`export function test(): number { return -5 + 3; }`)).toBe(-2);
  });

  // (#3907) An unannotated `number` carries the SAME f64 representation in both
  // modes. `fast` is a performance mode, not a different numeric semantics —
  // the two emitted signatures must be identical.
  it("an unannotated `number` gets the f64 representation in fast mode too", async () => {
    const src = `export function test(): number { return 1 + 2; }`;
    const fast = await compile(src, { fast: true });
    const plain = await compile(src);
    expect(fast.success).toBe(true);
    expect(plain.success).toBe(true);
    expect(fast.wat).toContain("(func $test (result f64)");
    expect(plain.wat).toContain("(func $test (result f64)");
    // No i32 narrowing of the result in either mode.
    expect(fast.wat).not.toContain("(func $test (result i32)");
  });

  // (#3907) …and a value that does NOT fit in an int32 survives, which is the
  // whole point: this is the shape that returned -269,534,592 before.
  it("a number past 2^31 survives fast mode", async () => {
    expect(
      await runFast(`export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10000; i = i + 1) { sum = sum + 832040; }
        return sum;
      }`),
    ).toBe(8_320_400_000);
  });

  // (#323/#3673) The documented explicit opt-in still reaches native i32, in
  // BOTH modes. Wrapping is the contract the author asked for here.
  it("`type i32 = number` still lowers to native i32 arithmetic", async () => {
    const src = `type i32 = number;
      export function test(): i32 { let a: i32 = 100000; let b: i32 = 100000; return a * b; }`;
    const result = await compile(src, { fast: true });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $test (result i32)");
    expect(result.wat).toContain("i32.mul");
    // i32 wrap — the annotation's documented semantics, not the f64 product.
    expect(await runFast(src)).toBe(1410065408);
  });
});
