// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1776: the test262 harness helper `isSameValue(a: any, b: any)` compiles both
// params to `externref`, so its `a === b` / `a !== a` comparisons reach the
// externref dynamic-equality path. Under `--target standalone` (and WASI) that
// path used to delegate to the JS-host `__host_eq` / `__host_loose_eq` imports,
// which (a) leak an unsatisfiable `env::__host_eq` import that breaks pure-Wasm
// `WebAssembly.instantiate`, and (b) feed externref locals into numeric helper
// signatures, producing the `f64.eq ... found call of type i32` /
// `call[0] expected type f64/i32, found local.get of type externref` validator
// failures. The fix lowers externref equality to a Wasm-native tag dispatch
// (number / boolean / reference-identity) with no host import.

const HARNESS_SHIM = `
  let __fail: number = 0;
  let __assert_count: number = 0;

  function isSameValue(a: any, b: any): number {
    if (a === b) { return 1; }
    if (a !== a && b !== b) { return 1; }
    return 0;
  }

  function assert_sameValue(actual: any, expected: any): void {
    __assert_count = __assert_count + 1;
    if (!isSameValue(actual, expected)) {
      if (!__fail) __fail = __assert_count;
    }
  }
`;

describe("#1776 standalone isSameValue externref equality", () => {
  it("compiles and instantiates with no leaked host import (standalone)", async () => {
    const r = await compile(
      HARNESS_SHIM +
        `
        export function test(): number {
          assert_sameValue(1, 1);
          assert_sameValue(NaN, NaN);
          assert_sameValue(true, true);
          assert_sameValue(0, 0);
          return __fail;
        }
      `,
      { fileName: "issue-1776.ts", target: "standalone" },
    );

    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

    // No `env::*` host import may leak in standalone mode (acceptance #1776).
    const hostImports = [...r.wat.matchAll(/\(import "env" "([^"]+)"/g)].map((m) => m[1]);
    expect(hostImports, `leaked host imports: ${hostImports.join(", ")}`).toEqual([]);
    // `__host_eq` / `__host_loose_eq` must not appear as a leaked env IMPORT.
    // (#2508 added a legitimate native `(func $__host_eq …)` for array search,
    // so a bare substring check no longer distinguishes the leak — gate on the
    // import form specifically.)
    expect(hostImports.includes("__host_eq")).toBe(false);
    expect(hostImports.includes("__host_loose_eq")).toBe(false);

    // Must compile (validate) AND instantiate with an EMPTY import object — a
    // true standalone module. Wrap with the function WAT on failure for triage.
    let instance: WebAssembly.Instance;
    try {
      const res = await WebAssembly.instantiate(r.binary, {});
      instance = res.instance;
    } catch (err) {
      const start = r.wat.indexOf("(func $isSameValue");
      const next = start >= 0 ? r.wat.indexOf("(func ", start + 1) : -1;
      const fnWat = start >= 0 ? r.wat.slice(start, next >= 0 ? next : undefined) : r.wat;
      throw new Error(`${String(err)}\n${fnWat}`);
    }

    // All four assertions hold → __fail stays 0.
    expect((instance.exports.test as () => number)()).toBe(0);
  });

  it("returns correct isSameValue results for number / NaN / +0 / boolean (standalone)", async () => {
    const r = await compile(
      HARNESS_SHIM +
        `
        export function eqNum(): number { return isSameValue(1, 1); }
        export function neqNum(): number { return isSameValue(2, 3); }
        export function nan(): number { return isSameValue(NaN, NaN); }
        export function zero(): number { return isSameValue(0, 0); }
        export function boolTrue(): number { return isSameValue(true, true); }
        export function boolMix(): number { return isSameValue(true, false); }
      `,
      { fileName: "issue-1776-results.ts", target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const e = instance.exports as Record<string, () => number>;
    expect(e.eqNum()).toBe(1);
    expect(e.neqNum()).toBe(0);
    expect(e.nan()).toBe(1); // SameValue(NaN, NaN) === true
    expect(e.zero()).toBe(1);
    expect(e.boolTrue()).toBe(1);
    expect(e.boolMix()).toBe(0);
  });

  it("preserves object reference identity in dynamic equality (standalone)", async () => {
    const r = await compile(
      `
        class P { x: number = 1; }
        function eq(a: any, b: any): number { return a === b ? 1 : 0; }
        export function sameRef(): number { let p = new P(); return eq(p, p); }
        export function diffRef(): number { let p = new P(); let q = new P(); return eq(p, q); }
      `,
      { fileName: "issue-1776-identity.ts", target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const e = instance.exports as Record<string, () => number>;
    expect(e.sameRef()).toBe(1);
    expect(e.diffRef()).toBe(0);
  });

  it("validates the f64.eq variant: !== inside the harness (standalone)", async () => {
    // The reopened evidence cited a `f64.eq[0] expected type f64, found call of
    // type i32` variant. Drive the `!==` / `!= NaN` paths that produced it.
    const r = await compile(
      HARNESS_SHIM +
        `
        export function test(): number {
          assert_sameValue(NaN, NaN);
          assert_sameValue(1, 1);
          return __fail;
        }
      `,
      { fileName: "issue-1776-neq.ts", target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Must validate (catches the f64.eq/i32 + externref-into-numeric variants).
    await WebAssembly.compile(r.binary);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(0);
  });

  it("still validates and instantiates the harness shim under --target wasi", async () => {
    const r = await compile(
      HARNESS_SHIM +
        `
        export function test(): number {
          assert_sameValue(42, 42);
          return __fail;
        }
      `,
      { fileName: "issue-1776-wasi.ts", target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No `env::__host_eq` host IMPORT may leak (a native `(func $__host_eq …)`
    // from #2508 is fine). wasi modules import wasi_snapshot_preview1 funcs only.
    const wasiHostImports = [...r.wat.matchAll(/\(import "env" "([^"]+)"/g)].map((m) => m[1]);
    expect(wasiHostImports.includes("__host_eq")).toBe(false);
    await WebAssembly.compile(r.binary);
  });

  it("keeps JS-host mode equality intact (string / number / NaN / boolean)", async () => {
    const r = await compile(
      HARNESS_SHIM +
        `
        export function num(): number { return isSameValue(1, 1); }
        export function nan(): number { return isSameValue(NaN, NaN); }
        export function bool(): number { return isSameValue(true, true); }
        export function str(): number { return isSameValue("hi", "hi"); }
      `,
      { fileName: "issue-1776-jshost.ts" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
    const e = instance.exports as Record<string, () => number>;
    expect(e.num()).toBe(1);
    expect(e.nan()).toBe(1);
    expect(e.bool()).toBe(1);
    expect(e.str()).toBe(1);
  });
});
