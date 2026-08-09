// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2047 — Unify the standalone Array.isArray predicate.
//
// Two sprint-61 PRs shipped competing standalone `Array.isArray` paths:
//   - a live inline `ref.test` chain that bakes an INCOMPLETE carrier list at
//     first emission (snapshot bug — a value-read of `Array.isArray` taken
//     before a later array type, e.g. `boolean[]` → `__vec_i32`, is registered
//     answered `false` while a direct call answered `true`); and
//   - a dead-code native helper (`__extern_is_array`, finalize-filled with the
//     complete carrier list) that standalone never called.
//
// This routes the standalone path through the finalize-filled native helper so
// a value-read and a direct call always agree, and filters the exclusively-
// non-array byte carriers (`i32_byte` ArrayBuffer/DataView, `i8_byte`
// Uint8Array) so they report `false` per ES §7.2.2 IsArray.
//
// Known residual (documented in object-runtime.ts): other TypedArrays
// (Float64Array, Int32Array, …) share the generic `__vec_f64` carrier with
// `number[]` and cannot be distinguished by a struct-level `ref.test` without a
// brand bit, so they remain a false-positive pending that follow-up. Only the
// `_byte` carriers are filtered here.
//
// #3562 (2026-07-24): the byte-carrier subtests below silently regressed to red
// on main (invisible outside required checks, #3008) — the `$__vec_base`
// common-supertype WasmGC refactor defeated the leaf-level exclusion: the
// isArray collector matched the abstract base via its `__vec_*` name prefix, so
// `ref.test $__vec_base` subsumed the byte-vec subtypes and
// `Array.isArray(ArrayBuffer/Uint8Array)` wrongly answered `true`. Fixed by
// skipping `$__vec_base` in `collectStandaloneArrayCarrierTypeIdxs`; this file
// is now in the required guard suite (`tests/guard-suite.json`) to stay caught.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function envImportNames(bytes: Uint8Array): string[] {
  const mod = new WebAssembly.Module(bytes);
  return WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, {
    fileName: "issue-2047.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  // Standalone must not leak the host array predicate import — the unified path
  // resolves to the in-module native helper, never an env import.
  const env = envImportNames(r.binary);
  expect(env, `leaked __extern_is_array env import: ${env.join(", ")}`).not.toContain("__extern_is_array");
  // Any other env import (e.g. the DataView view-register helper, unrelated to
  // #2047) is satisfied with a permissive stub so the module instantiates.
  const stub = new Proxy({}, { get: () => () => 0 });
  const imp = { env: stub } as unknown as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  return (instance.exports.test as () => number)();
}

async function runHost(source: string): Promise<number> {
  const r = await compile(source, { fileName: "issue-2047.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imp = r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  (imp as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports.test as () => number)();
}

describe("#2047 unify standalone Array.isArray", () => {
  it("value-read agrees with direct call for boolean[] in one module", async () => {
    // The value-read `f` and the direct `Array.isArray` must produce identical
    // answers. Before the fix the value-read snapshot chain disagreed.
    const value = await runStandalone(`
      export function test(): number {
        const f = Array.isArray;
        const b: boolean[] = [true, false];
        const viaValue = f(b as any) ? 1 : 0;
        const viaDirect = Array.isArray(b as any) ? 2 : 0;
        return viaValue + viaDirect; // expect 3 (both true)
      }
    `);
    expect(value).toBe(3);
  });

  it("value-read captured before a boolean[] type exists still answers true", async () => {
    // The snapshot bug, isolated: `f` is captured at module top level (before
    // any `boolean[]` / `__vec_i32` carrier is registered), then applied to a
    // boolean[]. The finalize-filled native helper sees ALL carriers regardless
    // of capture order.
    const value = await runStandalone(`
      let f = Array.isArray;
      export function test(): number {
        const b: boolean[] = [true];
        return f(b as any) ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("value-read and direct call agree across carrier kinds", async () => {
    const value = await runStandalone(`
      export function test(): number {
        const f = Array.isArray;
        const nums: number[] = [1, 2];
        const bools: boolean[] = [true];
        const strs: string[] = ["a"];
        let acc = 0;
        if (f(nums as any) === Array.isArray(nums as any) && Array.isArray(nums as any)) acc += 1;
        if (f(bools as any) === Array.isArray(bools as any) && Array.isArray(bools as any)) acc += 2;
        if (f(strs as any) === Array.isArray(strs as any) && Array.isArray(strs as any)) acc += 4;
        return acc; // expect 7
      }
    `);
    expect(value).toBe(7);
  });

  it("returns false for ArrayBuffer / DataView / Uint8Array carriers (§7.2.2)", async () => {
    const value = await runStandalone(`
      export function test(): number {
        const ab: any = new ArrayBuffer(8);
        const dv: any = new DataView(new ArrayBuffer(8));
        const u8: any = new Uint8Array(2);
        return (Array.isArray(ab) ? 1 : 0)
          + (Array.isArray(dv) ? 2 : 0)
          + (Array.isArray(u8) ? 4 : 0);
      }
    `);
    expect(value).toBe(0);
  });

  it("byte carriers are false even when a real array carrier coexists", async () => {
    // Regression guard: filtering must not be defeated by another `__vec_f64`
    // (number[]) carrier being present in the same module.
    const value = await runStandalone(`
      export function test(): number {
        const nums: number[] = [1, 2, 3];
        const u8: any = new Uint8Array(2);
        const arrTrue = Array.isArray(nums as any) ? 1 : 0;
        const u8False = Array.isArray(u8) ? 0 : 2;
        return arrTrue + u8False; // expect 3
      }
    `);
    expect(value).toBe(3);
  });

  it("returns false for primitives and plain objects", async () => {
    const value = await runStandalone(`
      export function test(): number {
        const o: any = { a: 1 };
        const n: any = 5;
        const s: any = "x";
        return (Array.isArray(o) ? 1 : 0) + (Array.isArray(n) ? 2 : 0) + (Array.isArray(s) ? 4 : 0);
      }
    `);
    expect(value).toBe(0);
  });

  it("brands native $ObjVec enumeration results as arrays", async () => {
    const value = await runStandalone(`
      export function test(): number {
        const o: any = { a: 1, b: 2 };
        const keys: any = Object.keys(o);
        return Array.isArray(keys) ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("host mode is unchanged: value-read and direct call both detect compiled arrays", async () => {
    // The host path keeps the inline ref.test chain ORed with the JS host
    // predicate. This guards against the standalone unification leaking into
    // host output.
    const value = await runHost(`
      export function test(): number {
        const f = Array.isArray;
        const nums: number[] = [1, 2];
        const viaValue = f(nums as any) ? 1 : 0;
        const viaDirect = Array.isArray(nums as any) ? 2 : 0;
        const notArr = Array.isArray(5 as any) ? 4 : 0;
        return viaValue + viaDirect + notArr; // expect 3
      }
    `);
    expect(value).toBe(3);
  });
});
