// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5383 S1 — the compiled `@js-temporal/polyfill` must produce a VALID,
// import-free module under `--target standalone` (`hostBridge: "off"`), so a
// standalone `Temporal` provider can be linked at all.
//
// Two independent defects blocked that, each reduced here to a few lines. Both
// are regression-guarded by `WebAssembly.Module` acceptance / the import list,
// not by a runtime value alone: the failure mode is a module that never gets
// as far as running.
//
//  R1  ToBoolean of an `anyref` (`src/codegen/coercion-engine.ts`,
//      `emitToBoolean`). `WeakMap.prototype.get` / `Map.prototype.get` hand
//      back `{ kind: "anyref" }` (weak-collections-runtime.ts L191-197,
//      map-runtime.ts). The #1917 ToBoolean cascade had rows for f64 /
//      externref / typed struct refs / i64 / i32 but NONE for a bare `anyref`,
//      so the value fell through to the i32 no-op tail and an `anyref` was left
//      where the consuming `if` needs i32:
//        `Compiling function #225:"OneObjectCache_setObject" failed:
//         if[0] expected type i32, found call of type anyref`
//      Note the `Map` twin is the same defect — it merely happened not to be
//      exercised as a bare condition in the original reduction (a `const t =
//      m.get(k)` binding coerces on the way into the local).
//
//  R2  `recv.m?.(args)` (`src/codegen/expressions/calls-optional.ts`,
//      `compileOptionalPropertyValueCall`) built its argument list and invoked
//      the callee through the JS-host `__js_array_new` / `__js_array_push` /
//      `__call_function` / `__get_undefined` unconditionally. Under standalone
//      those have no provider — a #2961 leak. This ONE call site accounted for
//      the entire `env` import set of the compiled polyfill.
//
// The whole polyfill is not compiled here (~60 s, 2.9 MB): `.tmp/sa-temporal/`
// carries that probe. These are the reductions.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface StandaloneModule {
  binary: Uint8Array;
  imports: string[];
  instance: WebAssembly.Instance;
}

/**
 * Compile `source` for `--target standalone` with the JS host bridge OFF,
 * assert it validates, assert it imports nothing, and instantiate it with an
 * EMPTY import object — the host-free contract the standalone Temporal
 * provider has to satisfy.
 */
async function compileStandalone(source: string): Promise<StandaloneModule> {
  const result = await compile(source, {
    fileName: "issue-5383.js",
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // `new WebAssembly.Module` (not `validate`) so a failure names the offending
  // function and the type mismatch, which is the whole diagnostic value here.
  const wasmModule = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(wasmModule).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "standalone module leaked host imports (#2961)").toEqual([]);
  const instance = await WebAssembly.instantiate(wasmModule, {});
  return { binary: result.binary, imports, instance };
}

function callExport(mod: StandaloneModule, name = "test"): unknown {
  return (mod.instance.exports as Record<string, () => unknown>)[name]!();
}

describe("#5383 S1 R1 — ToBoolean of an anyref (WeakMap/Map `get` as a condition)", () => {
  it("WeakMap.get on a static field, used as an `if` condition (the polyfill's OneObjectCache_setObject)", async () => {
    // The literal shape of `OneObjectCache.setObject` in @js-temporal/polyfill.
    // Pre-fix: `C_setObject` failed to compile — if[0] expected i32, found anyref.
    const mod = await compileStandalone(`
      class C {
        setObject(e) {
          if (C.objectMap.get(e)) throw new RangeError("dup");
          C.objectMap.set(e, this);
        }
      }
      C.objectMap = new WeakMap();
      export function test() {
        var c = new C(); var o = {};
        c.setObject(o);
        try { c.setObject(o); } catch (e) { return e instanceof RangeError ? 1 : 2; }
        return 0;
      }
    `);
    // 1 = the second setObject threw the RangeError, i.e. `get` answered TRUTHY
    // for a present key. 0 would mean the condition read falsy.
    expect(callExport(mod)).toBe(1);
  });

  it("WeakMap.get as a ternary condition — hit and miss", async () => {
    const mod = await compileStandalone(`
      const m = new WeakMap(); const o = {}; const other = {};
      m.set(o, 1);
      export function test() {
        return (m.get(o) ? 10 : 0) + (m.get(other) ? 5 : 1);
      }
    `);
    // hit → 10, miss → 1. A miss answers the `$undefined` singleton (#2106),
    // which `__is_truthy` must classify FALSY — 11, not 15.
    expect(callExport(mod)).toBe(11);
  });

  it("Map.get as a bare `if` condition — the same cascade row, and empty string / 0 stay falsy", async () => {
    const mod = await compileStandalone(`
      const m = new Map();
      m.set("t", 1); m.set("zero", 0); m.set("empty", "");
      export function test() {
        var n = 0;
        if (m.get("t")) n += 1;
        if (m.get("zero")) n += 100;
        if (m.get("empty")) n += 1000;
        if (m.get("absent")) n += 10000;
        return n;
      }
    `);
    // Only the truthy entry counts: routing through `__is_truthy` (rather than
    // a bare non-null test) is what keeps 0 / "" / a miss falsy.
    expect(callExport(mod)).toBe(1);
  });

  it("WeakMap.get on the left of `&&` and inside `!`", async () => {
    const mod = await compileStandalone(`
      const m = new WeakMap(); const k = {}; const k2 = {};
      m.set(k, { v: 3 });
      export function test() {
        var a = m.get(k) && 1;
        var b = !m.get(k2);
        return (a === 1 ? 1 : 0) + (b ? 2 : 0);
      }
    `);
    expect(callExport(mod)).toBe(3);
  });
});

describe("#5383 S1 R2 — `recv.m?.(args)` must not leak JS-host imports (#2961)", () => {
  it("optional method-value call on a dynamic receiver links host-free and calls through", async () => {
    // `compileStandalone` already asserts the import list is EMPTY; pre-fix this
    // shape emitted env::__js_array_new, __js_array_push, __call_function and
    // __get_undefined and could not be instantiated at all.
    const mod = await compileStandalone(`
      export function test() {
        var o = { add: function (a, b) { return a + b; } };
        return o.add?.(2, 3);
      }
    `);
    expect(callExport(mod)).toBe(5);
  });

  it("optional method-value call short-circuits to `undefined`, not `null`", async () => {
    const mod = await compileStandalone(`
      export function test() {
        var o = {};
        var r = o.missing?.(1);
        // The short-circuit result must be the lane's real undefined (#2106
        // tag-1 singleton), NOT a null externref -- r === undefined is the
        // whole point of the shape.
        return (r === undefined ? 1 : 0) + (r === null ? 10 : 0) + (typeof r === "undefined" ? 100 : 0);
      }
    `);
    expect(callExport(mod)).toBe(101);
  });

  it("receiver and arguments are evaluated exactly once, in order", async () => {
    const mod = await compileStandalone(`
      export function test() {
        var log = "";
        var o = { f: function (a, b) { log += "f"; return a + b; } };
        function recv() { log += "r"; return o; }
        function arg(n) { return function () { log += "a" + n; return n; }; }
        recv().f?.(arg(1)(), arg(2)());
        return log === "ra1a2f" ? 1 : 0;
      }
    `);
    expect(callExport(mod)).toBe(1);
  });
});
