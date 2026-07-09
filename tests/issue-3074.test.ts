import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3074 — TypedArray harness-wrapper callback stays vacuous in BOTH lanes.
 *
 * A closure/callback held in an `any`-typed PARAMETER and invoked from a
 * higher-order function (`fn(x)`) must dispatch and run its body. #2939 fixed
 * this for the STANDALONE lane by pre-registering nested-scope function-
 * expression / arrow callbacks as inline-dispatch candidates, but the
 * registration was gated on `ctx.standalone`, so the gc/host (default) lane
 * still saw ZERO candidates and silently DROPPED the call (`drop; ref.null.
 * extern`). That is the reopened #3074 cluster — the LARGER of the two
 * (1,535 default vs 448 standalone).
 *
 * These tests mirror the exact test262 harness-wrapper wrap shape:
 *   - the higher-order function lives at MODULE TOP LEVEL (the harness preamble)
 *   - the callback function-expression is defined INSIDE `export function test()`
 *   - `__assert_count` is bumped inside the callback; if the callback never
 *     dispatches it stays at its initial value and `test()` returns the -262
 *     vacuity sentinel (the runner's real vacuity gate).
 */

async function runBoth(src: string): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const target of ["gc", "standalone"] as const) {
    const r = await compile(src, { fileName: "test.ts", target });
    if (!r.success) {
      out[target] = "CE:" + (r.errors?.map((e) => e.message).join("; ") ?? "");
      continue;
    }
    const impObj = r.importObject;
    const { instance } = await WebAssembly.instantiate(r.binary, impObj);
    (impObj as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    out[target] = (instance.exports as { test?: () => number }).test?.() ?? NaN;
  }
  return out;
}

describe("#3074 harness-wrapper callback dispatches on both lanes", () => {
  it("1-arg wrapper, 1-param nested callback executes (not vacuous)", async () => {
    const src = `
let __assert_count: number = 1;
let __harness_cb_expected: number = 0;
function testWithTypedArrayConstructors(fn: any): void {
  const constructors = [Int8Array, Uint8Array, Int16Array, Uint16Array];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    fn(constructors[i]);
  }
}
export function test(): number {
  try {
    testWithTypedArrayConstructors(function (TA: any) { __assert_count = __assert_count + 1; });
  } catch (e) { return -1; }
  if (__harness_cb_expected > 0 && __assert_count === 1) { return -262; }
  return 1;
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(1); // EXECUTED (was -262 vacuous before the fix)
    expect(res.standalone).toBe(1);
  });

  it("2-arg wrapper, 2-param nested callback executes (BigInt / makeCtorArg shape)", async () => {
    const src = `
let __assert_count: number = 1;
let __harness_cb_expected: number = 0;
function __ta_makeCtorArgPassthrough(x: any): any { return x; }
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    fn(constructors[i], __ta_makeCtorArgPassthrough);
  }
}
export function test(): number {
  try {
    testWithBigIntTypedArrayConstructors(function (TA: any, makeCtorArg: any) { __assert_count = __assert_count + 1; });
  } catch (e) { return -1; }
  if (__harness_cb_expected > 0 && __assert_count === 1) { return -262; }
  return 1;
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(1);
    expect(res.standalone).toBe(1);
  });

  it("2-arg wrapper, 1-param callback: arity tolerance (extra arg ignored)", async () => {
    const src = `
let __assert_count: number = 1;
let __harness_cb_expected: number = 0;
function __ta_makeCtorArgPassthrough(x: any): any { return x; }
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) {
    __harness_cb_expected = __harness_cb_expected + 1;
    fn(constructors[i], __ta_makeCtorArgPassthrough);
  }
}
export function test(): number {
  try {
    testWithBigIntTypedArrayConstructors(function (TA: any) { __assert_count = __assert_count + 1; });
  } catch (e) { return -1; }
  if (__harness_cb_expected > 0 && __assert_count === 1) { return -262; }
  return 1;
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(1);
    expect(res.standalone).toBe(1);
  });

  it("callback receives CORRECT args through the dispatch (genuine execution, not just body-runs)", async () => {
    // Sum of 10+20+30+40 = 100 proves the real per-iteration arg reaches the
    // callback body (a false 'executed' that dropped the arg would sum wrong).
    const src = `
let __hits: number = 0;
function harness(fn: any): void {
  const vals = [10, 20, 30, 40];
  for (let i = 0; i < vals.length; i++) { fn(vals[i]); }
}
export function test(): number {
  harness(function (v: any) { __hits = __hits + (v as number); });
  return __hits;
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(100);
    expect(res.standalone).toBe(100);
  });
});
