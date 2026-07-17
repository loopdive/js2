// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3201 — expando-method dispatch on native (WasmGC ref) receivers, JS-host lane.
//
// The Sputnik classifier idiom
//   `arr.getClass = Object.prototype.toString; arr.getClass()`
// (65+ test262 files across splice/slice/concat — the `S15.4.4.*` families)
// silently produced `null`: the receiver-method ladder had no arm for an
// UNKNOWN method on a statically-typed struct/vec receiver, so the call fell
// to the calls.ts "graceful fallback" (evaluate for side effects, return
// null).
//
// Three coordinated fixes:
//   1. call-receiver-method.ts — end-of-ladder arm (JS-host lane only):
//      delegate unknown methods on ref/ref_null receivers to the generic
//      `__extern_method_call(recv, name, args)` (#799 WI3 / #3123 machinery).
//   2. calls.ts `emitFnctorSubclassDynamicMethodCall` gains
//      `rawStructReceiver` — the receiver marshals as the RAW wasm ref
//      (extern.convert_any), NOT through coerceType's `__make_iterable` COPY:
//      the `_wasmStructProps` expando sidecar is keyed by the raw struct, so
//      a copy could never find the stored method.
//   3. runtime.ts `_wrapVecForHost` — the array-backed host view of a vec now
//      surfaces sidecar expandos in its get/has traps (own expando shadows
//      Array.prototype, per ordinary lookup order), callable-wrapping raw
//      closure structs at read time (writes during module-init run before
//      setExports, so write-time wrapping can't resolve the exports).

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime-instantiate.js";

describe("#3201 — expando methods on native receivers (JS-host lane)", () => {
  it("Sputnik classifier idiom on a splice result: [object Array]", async () => {
    const src = `
      var x = [0, 1, 2, 3];
      var arr = x.splice(0, 3);
      arr.getClass = Object.prototype.toString;
      export function test(): string { return String(arr.getClass()); }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("[object Array]");
  });

  it("classifier idiom directly on an array literal", async () => {
    const src = `
      var x = [1, 2];
      x.getClass = Object.prototype.toString;
      export function test(): string { return String(x.getClass()); }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("[object Array]");
  });

  it("user-function expando on a vec dispatches with the stored closure", async () => {
    const src = `
      var x = [1, 2];
      x.f = function (): string { return "hi"; };
      export function test(): string { return String(x.f()); }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("hi");
  });

  it("builtin expando on a plain object: [object Object]", async () => {
    const src = `
      var o = { a: 1 };
      o.getClass = Object.prototype.toString;
      export function test(): string { return String(o.getClass()); }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("[object Object]");
  });

  it("expando does not shadow real Array.prototype methods for OTHER keys", async () => {
    // The sidecar hit must be an OWN-key check — an unrelated expando must
    // leave `join`/`indexOf` on the array view untouched.
    const src = `
      var x = [3, 1];
      x.tag = function (): string { return "t"; };
      export function test(): string { return x.join("-") + "|" + String(x.indexOf(1)) + "|" + String(x.tag()); }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("3-1|1|t");
  });
});
