// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 B-pre) `Array.prototype.{some,every,filter}.call(arrayLike, cb)` where the
// predicate callback returns an `any`/externref value (e.g. `null`, or a boxed
// value) emitted INVALID Wasm in --target standalone:
//
//   if[0] expected type i32, found call of type externref
//
// Root cause (the #16 / #2043 funcidx-desync class): the native array-like
// generic-method arm captures the `__is_truthy` funcidx BEFORE compiling the
// callback. In standalone/WASI `__is_truthy` is an IN-MODULE native defined func
// (#1471 routes the helper name to the native body), so the callback compile —
// which registers `__closure_*` and (for filter/map) the result builders —
// SHIFTS every defined-func index. The stale-low captured index then made
// `call __is_truthy` land on the wrong function (one returning externref) →
// the `if expected i32, found externref` invalid Wasm. The fix re-resolves
// `__is_truthy` by name AFTER the callback compile, exactly as the sibling
// `__extern_get_idx`/`__extern_has_idx` helpers already are.
//
// Host mode is unaffected: there `__is_truthy` is a stable import, so the
// re-resolve `?? isTruthyFn` keeps the original index (no behaviour change).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileStandalone(source: string) {
  const result = await compile(source, { target: "standalone" });
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  return result;
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compileStandalone(source);
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { run: () => unknown }).run();
}

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm (host)");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  (imports as { setInstance?: (e: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

// The exact invalid-Wasm trigger: a predicate returning `null` (an externref).
const SOME_NULL = `export function run(): number {
  const o: any = { 0: 11, 1: 12, length: 2 };
  // returns null (externref/falsy) for every element → some(...) === false
  return Array.prototype.some.call(o, (v: any) => null) ? 1 : 0;
}`;
const EVERY_NULL = `export function run(): number {
  const o: any = { 0: 11, 1: 12, length: 2 };
  return Array.prototype.every.call(o, (v: any) => null) ? 1 : 0;
}`;
const FILTER_NULL = `export function run(): number {
  const o: any = { 0: 11, 1: 12, 2: 13, length: 3 };
  const r: any = Array.prototype.filter.call(o, (v: any) => null);
  return r.length;
}`;
// Predicate returns the element itself (a boxed `any`) — also externref-typed.
const SOME_TRUTHY_ANY = `export function run(): number {
  const o: any = { 0: 11, 1: 0, length: 2 };
  // 11 is truthy → some(...) === true
  return Array.prototype.some.call(o, (v: any) => v) ? 1 : 0;
}`;
const EVERY_TRUTHY_ANY = `export function run(): number {
  const o: any = { 0: 11, 1: 12, length: 2 };
  // all truthy → every(...) === true
  return Array.prototype.every.call(o, (v: any) => v) ? 1 : 0;
}`;
const EVERY_ONE_FALSY_ANY = `export function run(): number {
  const o: any = { 0: 11, 1: 0, length: 2 };
  // one falsy (0) → every(...) === false
  return Array.prototype.every.call(o, (v: any) => v) ? 1 : 0;
}`;

describe("#2580 B-pre — some/every/filter.call(arrayLike, externref-predicate) standalone", () => {
  it("standalone: some.call with null-returning predicate compiles to VALID wasm (was invalid)", async () => {
    const r = await compileStandalone(SOME_NULL);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("standalone: every.call with null-returning predicate is VALID wasm", async () => {
    const r = await compileStandalone(EVERY_NULL);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("standalone: filter.call with null-returning predicate is VALID wasm", async () => {
    const r = await compileStandalone(FILTER_NULL);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("standalone: no host imports leaked (pure-Wasm generic method)", async () => {
    const r = await compileStandalone(SOME_NULL);
    // standalone modules instantiate with an empty import object
    await expect(WebAssembly.instantiate(r.binary, {})).resolves.toBeDefined();
  });

  it("standalone: some/every truthiness is JS-correct for externref predicate results", async () => {
    expect(await runStandalone(SOME_NULL)).toBe(0); // all null → false
    expect(await runStandalone(EVERY_NULL)).toBe(0); // all null → false
    expect(await runStandalone(SOME_TRUTHY_ANY)).toBe(1); // 11 truthy → true
    expect(await runStandalone(EVERY_TRUTHY_ANY)).toBe(1); // all truthy → true
    expect(await runStandalone(EVERY_ONE_FALSY_ANY)).toBe(0); // a 0 → false
    expect(await runStandalone(FILTER_NULL)).toBe(0); // none kept → length 0
  });

  it("host mode unchanged (stable __is_truthy import — no behaviour change)", async () => {
    expect(await runHost(SOME_NULL)).toBe(0);
    expect(await runHost(SOME_TRUTHY_ANY)).toBe(1);
    expect(await runHost(EVERY_ONE_FALSY_ANY)).toBe(0);
  });
});
