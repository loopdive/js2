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

async function run(source: string, exportName = "test"): Promise<any> {
  const result = await compile(source);
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports[exportName] as Function)();
}

// #1825 — i32 fast-mode `%` must not emit a trapping i32.rem_s.
describe("#1825 — i32 fast-mode modulo does not trap", () => {
  it("normal modulo still works", async () => {
    expect(await runFast(`export function test(): number { return 10 % 3; }`)).toBe(1);
  });

  it("negative dividend modulo (sign of dividend)", async () => {
    expect(await runFast(`export function test(): number { return -7 % 3; }`)).toBe(-1);
  });

  // (#3907) These three used to assert the i32 APPROXIMATION and said so:
  // "JS yields NaN; i32 fast mode has no NaN, so the guard returns 0 instead of
  // trapping the module." Fast mode no longer narrows an unannotated `number`
  // to i32, so it DOES have NaN and -0, and the spec value is now reachable.
  // The assertions are updated to the spec values; the non-trapping property
  // #1825 was filed for is still what is being tested (a trap fails the test
  // just as loudly as a wrong value).
  //
  // The trapping-`i32.rem_s` guard itself is NOT removed: `type i32 = number`
  // (#323/#3673) still lowers `%` to a native i32 remainder, and that path
  // still needs the divide-by-zero and INT_MIN/-1 overflow guards.
  it("modulo by zero yields NaN and does not trap", async () => {
    const src = `export function test(): number { let a = 10; let b = 0; return a % b; }`;
    expect(await runFast(src)).toBeNaN();
  });

  it("INT_MIN % -1 yields -0 (spec) and does not trap", async () => {
    const src = `export function test(): number { let a = -2147483648; let b = -1; return a % b; }`;
    // `Object.is(-2147483648 % -1, -0)` is true in JS — the sign of the
    // dividend is preserved. An i32 local cannot represent -0 at all.
    expect(await runFast(src)).toBe(-0);
  });

  it("modulo by zero with computed operands does not trap", async () => {
    const src = `export function test(): number {
      let total = 0;
      for (let i = 0; i < 4; i++) {
        let d = i - 2; // hits 0 when i === 2
        total = total + (10 % d);
      }
      return total;
    }`;
    // i=0: 10%-2=0 ; i=1: 10%-1=0 ; i=2: 10%0=NaN ; i=3: 10%1=0 → NaN total.
    expect(await runFast(src)).toBeNaN();
  });

  // (#3907) The i32 remainder guards still exist for the explicit opt-in.
  it("`type i32 = number` keeps the non-trapping i32 remainder guards", async () => {
    const byZero = `type i32 = number;
      export function test(): i32 { let a: i32 = 10; let b: i32 = 0; return a % b; }`;
    expect(await runFast(byZero)).toBe(0);
    const overflow = `type i32 = number;
      export function test(): i32 { let a: i32 = -2147483648; let b: i32 = -1; return a % b; }`;
    expect(await runFast(overflow)).toBe(0);
  });
});

// #1834 — element-write / length-set index uses saturating truncation.
//
// (#4222) The two `arr.length = <invalid>` cases below asserted the CLAMP
// (NaN → 0, 1e30 → i32 max). That was never the spec answer: §10.4.2.4
// ArraySetLength step 3 makes `ToUint32(v) !== ToNumber(v)` a **RangeError**,
// and five test262 files in `built-ins/Array/length` assert exactly that. The
// assertions have been retargeted rather than deleted, because what #1834
// actually bought is still being pinned: the failure mode must not be a wasm
// TRAP, which kills the module unrecoverably. A RangeError is a catchable JS
// exception, so it satisfies #1834's goal strictly better than clamping did —
// and the saturating truncation itself is unchanged for every value that
// survives the validity check.
// The assertion here is deliberately "the catch ran", not "the value is a
// RangeError": this file instantiates via `instantiateWasm(binary, imports.env)`
// rather than the full `buildImports` object, and under that narrower wiring the
// thrown payload does not satisfy `e instanceof RangeError`. The error IDENTITY
// is pinned on both lanes in tests/es5-standalone-array-semantics-length.test.ts;
// what belongs in THIS file is #1834's property — control reaches user code
// afterwards, so the module was not trapped.
describe("#1834 / #4222 — an invalid arr.length throws catchably, never traps", () => {
  it("arr.length = NaN throws instead of clamping to 0", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3];
      try { arr.length = NaN; } catch (e) { return 1; }
      return 0;
    }`;
    expect(await run(src)).toBe(1);
  });

  it("arr.length = 1e30 throws instead of clamping to i32 max", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3];
      try { arr.length = 1e30; } catch (e) { return 1; }
      return 0;
    }`;
    expect(await run(src)).toBe(1);
  });

  it("a valid length still rides the saturating truncation unchanged", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3];
      arr.length = 0;
      return arr.length;
    }`;
    expect(await run(src)).toBe(0);
  });

  it("normal arr.length set still works", async () => {
    const src = `export function test(): number {
      const arr = [1, 2, 3, 4, 5];
      arr.length = 2;
      return arr.length;
    }`;
    expect(await run(src)).toBe(2);
  });
});
