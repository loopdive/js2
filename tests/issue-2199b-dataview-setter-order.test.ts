// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2199b — standalone DataView setter operation order (§24.2.1.2 SetViewValue).
 *
 * #2199 added a single combined bounds guard that threw the RangeError BEFORE
 * compiling the setter `value`. But §24.2.1.2 splits into two throw points
 * around `ToNumber(value)`:
 *
 *   step 4  ToIndex(byteOffset)          -> RangeError (index check) — BEFORE value
 *   step 5  numberValue = ToNumber(value)            (value's valueOf runs here)
 *   step 8  getIndex + elementSize > viewByteLength -> RangeError — AFTER value
 *
 * So `dv.setInt16(100, sideEffectingValue)` on an 8-byte view must still RUN the
 * value's `valueOf` (and propagate a throw from it) before the bounds RangeError
 * fires (test262 `range-check-after-value-conversion` /
 * `return-abrupt-from-tonumber-value`), while `dv.setInt16(-1, …)` must throw the
 * index RangeError WITHOUT running the value's `valueOf`
 * (`index-check-before-value-conversion`).
 *
 * This slice splits the guard: the NaN/negative INDEX throw stays before the
 * value compile; the BOUNDS throw moves after it. Getters (no value) keep both
 * throws adjacent. Same file, additive reorder, zero new host imports.
 *
 * Standalone native byte buffers don't marshal across the export boundary, so
 * each case returns a number the test asserts directly. (The side-effect is
 * observed via a module-level counter the setter's value expression bumps; a
 * throwing `valueOf` object literal as the setter value hits a separate,
 * pre-existing object->f64 coercion limitation and is out of scope here.)
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const labels = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(
    labels.filter((l) => !l.startsWith("wasi")),
    "standalone module must have zero host imports",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2199b standalone DataView setter ToNumber-vs-bounds order", () => {
  it("out-of-bounds set still runs the value's valueOf (range check after conversion)", async () => {
    // A function-call value expression with an observable side effect; the side
    // effect must run even though the offset is out of bounds.
    expect(
      await runNum(
        `let ran = 0;
         function v(): number { ran = 1; return 7; }
         export function test(): number {
           const dv = new DataView(new ArrayBuffer(8));
           try { dv.setInt16(100, v()); } catch (e) {}
           return ran;
         }`,
      ),
    ).toBe(1);
  });

  it("out-of-bounds set still throws RangeError after the value runs", async () => {
    expect(
      await runNum(
        `function v(): number { return 7; }
         export function test(): number {
           const dv = new DataView(new ArrayBuffer(8));
           try { dv.setInt16(100, v()); } catch (e) { return e instanceof RangeError ? 1 : 2; }
           return 0;
         }`,
      ),
    ).toBe(1);
  });

  it("negative-index set throws the index RangeError WITHOUT running the value (index check first)", async () => {
    expect(
      await runNum(
        `let ran = 0;
         function v(): number { ran = 1; return 7; }
         export function test(): number {
           const dv = new DataView(new ArrayBuffer(8));
           try { dv.setInt16(-1, v()); } catch (e) {}
           return ran;
         }`,
      ),
    ).toBe(0);
  });

  it("negative-index set throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number {
           const dv = new DataView(new ArrayBuffer(8));
           try { dv.setInt16(-1, 5); } catch (e) { return e instanceof RangeError ? 1 : 2; }
           return 0;
         }`,
      ),
    ).toBe(1);
  });
});

describe("#2199b regression guards — valid + getter paths unchanged", () => {
  it("valid setInt32/getInt32 round-trip", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); dv.setInt32(0, 123); return dv.getInt32(0); }`,
      ),
    ).toBe(123);
  });

  it("valid setFloat64 at the last valid offset", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(16)); dv.setFloat64(8, 2.5); return dv.getFloat64(8); }`,
      ),
    ).toBe(2.5);
  });

  it("getter out-of-bounds still throws RangeError (#2199 unchanged)", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); try{ dv.getInt32(100); }catch(e){ return e instanceof RangeError?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("setter out-of-bounds (in-bounds value) throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); try{ dv.setUint8(100, 5); }catch(e){ return e instanceof RangeError?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });
});
