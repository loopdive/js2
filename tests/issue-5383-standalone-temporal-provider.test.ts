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

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { standaloneIntlShimSource } from "../src/temporal-intl-shim.js";
import { temporalProviderCacheKey } from "../src/temporal-provider.js";

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

/**
 * (#5383 S2c) Compile with the standalone provider's `Intl` shim ahead of the
 * source — the exact text `buildTemporalProvider` prepends for
 * `target: "standalone" | "wasi"`, so these cases exercise the shipped shim
 * rather than a copy of it.
 */
function withIntlShim(source: string): string {
  return `${standaloneIntlShimSource()}\n${source}`;
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

// ---------------------------------------------------------------------------
// #5383 S2 — the polyfill's `__module_init` throws. Three more defects, each
// reduced from the exact statement in the linked bundle that hit it. Diagnosing
// them at all needed #5384 (a host-free standalone throw had no renderer, so
// every one of these read as "non-stringifiable payload").
// ---------------------------------------------------------------------------

describe("#5383 S2 R3 — a minifier's comma-chained class static assignment", () => {
  it("`C.a = …, C.f = function(){}` on a class extending Array registers the static cell", async () => {
    // jsbi's header is ONE expression statement:
    //   JSBI.__kBitConversionInts = new Int32Array(…), JSBI.__clz30 = …,
    //   JSBI.__imul = Math.imul || function (i, _) { return 0 | i * _; };
    // `registerModuleClassStaticAssignments` admitted only a statement whose
    // whole expression is `=`, so the comma chain registered NO value cell. A
    // plain class survives on the host class-object setter; an externref-backed
    // builtin subclass has no such singleton, so the write went through null and
    // the later call read a non-callable: "called value is not a function",
    // thrown from the polyfill's own __module_init before any Temporal code ran.
    const mod = await compileStandalone(`
      class C extends Array {}
      C.g = function () { return 1; }, C.f = function (a, b) { return a * b; };
      export function test() { return C.f(2, 3) + C.g(); }
    `);
    expect(callExport(mod)).toBe(7);
  });

  it("the single-assignment and plain-class spellings keep working", async () => {
    const mod = await compileStandalone(`
      class D extends Array {}
      D.f = function (a) { return a + 1; };
      class E {}
      E.x = 1, E.f = function (a) { return a + 2; };
      export function test() { return D.f(1) + E.f(1) + E.x; }
    `);
    expect(callExport(mod)).toBe(6);
  });
});

describe("#5383 S2 R4 — `Math.<fn>` read as a VALUE, host-free", () => {
  it("`C.f = Math.imul || fallback; C.f(a, b)` calls the real Math.imul", async () => {
    // The jsbi feature-detect. `Math.imul` is truthy, so the fallback never
    // runs — and before this the reified value's body was the generic
    // "not yet implemented in --target standalone" refusal, because
    // `emitMathValueReadBody` could not find `__any_from_extern` /
    // `__any_to_f64` / `__box_number`: nothing had registered them, and a body
    // emitter must not register a native mid-body (#2704).
    const mod = await compileStandalone(`
      class C {}
      C.f = Math.imul || function (a, b) { return 0 | (a * b); };
      C.g = Math.clz32 ? function (i) { return Math.clz32(i) - 2; } : function () { return 30; };
      export function test() { return C.f(0x7fffffff, 3) + C.g(1); }
    `);
    // Math.imul(0x7fffffff, 3) === 2147483645 (exact ToInt32 wraparound, NOT
    // the f64 product); Math.clz32(1) - 2 === 29.
    expect(callExport(mod)).toBe(2147483645 + 29);
  });

  it("an extracted value computes, through a local alias and through `map`", async () => {
    // `var _ = Math.floor` is jsbi's `BigInt(number)` header. Both spellings
    // threw before: the local alias with "Cannot access property on null or
    // undefined" (no host to fall back to), `map` with the refusal body.
    const mod = await compileStandalone(`
      function f(x) { var g = Math.floor, h = Number.isFinite; return h(x) ? g(x) : -1; }
      export function test() {
        var viaMap = [1, 4, 9].map(Math.sqrt)[2];
        return f(3.7) + viaMap + Math.abs(-2) + Math.trunc(1.9) + Math.ceil(0.2);
      }
    `);
    // 3 + 3 + 2 + 1 + 1
    expect(callExport(mod)).toBe(10);
  });

  it("an unrelated same-spelled binding elsewhere no longer declines the alias", async () => {
    // The soundness gate was a file-wide SPELLING test. Minified bundles bind
    // `g`/`_`/`t` in hundreds of scopes and assign most of them, so the gate
    // declined every alias in the polyfill.
    const mod = await compileStandalone(`
      function other(g) { g = 1; return g; }
      function useIt(x) { var g = Math.floor; return g(x); }
      export function test() { return useIt(2.5) + other(0); }
    `);
    expect(callExport(mod)).toBe(3);
  });

  it("a REASSIGNED alias still declines — the gate keeps its meaning", async () => {
    const mod = await compileStandalone(`
      export function test() {
        var g = Math.floor;
        g = function (x) { return x + 100; };
        return g(1.5);
      }
    `);
    // If the alias fold had been taken despite the write, this would answer 1.
    expect(callExport(mod)).toBe(101.5);
  });
});

// ── S2b ──────────────────────────────────────────────────────────────────────
//
// Two defects in the EXTERNREF-BACKED subclass family (`class B extends Array`
// — jsbi's `class JSBI extends Array`), both reduced from the standalone
// polyfill's `__module_init` throw and both invisible in the JS-host lane,
// where the real host prototype does this work.
//
//  R6  An own-field WRITE inside the constructor (`this.sign = s`). The
//      constructor's own assignment flow-grows a `sign` slot onto the vestigial
//      `$B` struct, and the write then took the struct.set path — but the
//      instance is the parent's native carrier, never a `$B`, so the receiver
//      narrowed to `ref.null $B` and the #2084 guard threw
//      `TypeError: Cannot access property on null or undefined`. The same write
//      from OUTSIDE the class always worked (no slot ⇒ the #4149 dynamic-store
//      arm), so the class's own constructor was the one place it failed.
//
//  R7  A method call through a DYNAMIC receiver. Nothing on the carrier says
//      "B", so the dynamic terminals (`__extern_method_call` /
//      `__call_m_<name>`, which resolve by `ref.test`ing instance identity)
//      missed and answered `null` — SILENTLY, which is why it survived. The
//      host lane's answer, `__set_subclass_proto`, is a JS host import, so
//      `emitSetSubclassProto` is a no-op standalone. Methods are now installed
//      on the instance at §17 attributes, and the method trampoline binds
//      `__current_this` as the carrier instead of `ref.null $B`.
//
// This is what stopped the compiled @js-temporal/polyfill: jsbi statics call
// methods on their PARAMETERS (`static toNumber(i) { … i.__unsignedDigit(0) … }`),
// every such call answered null, and the null surfaced five frames later as
// `JSBI.subtract(null, …)`.

describe("#5383 S2b R6 — own-field write/read on an externref-backed subclass instance", () => {
  it("`this.<field> = v` in the constructor of a `class … extends Array`", async () => {
    const mod = await compileStandalone(`
      class B extends Array { constructor(n, s) { super(n); this.sign = s; } }
      export function test() { var b = new B(2, true); return b.sign === true ? 1 : 0; }
    `);
    expect(callExport(mod)).toBe(1);
  });

  it("the jsbi shape — an instance minted by one static, read by another", async () => {
    // `JSBI.subtract(i, _) { const t = i.sign; … }` with `i` from `JSBI.BigInt`.
    const mod = await compileStandalone(`
      class B extends Array {
        constructor(n, s) { super(n); this.sign = s; }
        static make(s) { return new B(2, s); }
        static subtract(i, _) { const t = i.sign; return t === true ? 7 : 8; }
      }
      export function test() { return B.subtract(B.make(true), B.make(false)); }
    `);
    expect(callExport(mod)).toBe(7);
  });

  it("the element/length surface of the Array carrier is untouched", async () => {
    // The write must land in the expando side table, never over the vec's own
    // element storage or its length.
    const mod = await compileStandalone(`
      class B extends Array { constructor(n, s) { super(n); this.sign = s; } }
      export function test() {
        var b = new B(3, true);
        b[0] = 9;
        return b.length * 10 + b[0] + (b.sign === true ? 100 : 0);
      }
    `);
    expect(callExport(mod)).toBe(139);
  });

  it("a plain class and an `extends Error` subclass are unaffected", async () => {
    const mod = await compileStandalone(`
      class P { constructor(n, s) { this.length = n; this.sign = s; } }
      class E extends Error { constructor(m) { super(m); this.sign = true; } }
      export function test() {
        return (new P(2, true).sign === true ? 1 : 0) + (new E("m").sign === true ? 2 : 0);
      }
    `);
    expect(callExport(mod)).toBe(3);
  });
});

describe("#5383 S2b R7 — dynamic method dispatch on an externref-backed subclass instance", () => {
  it("a method called through an untyped parameter runs, with `this` bound", async () => {
    const mod = await compileStandalone(`
      class B extends Array {
        constructor(n, s) { super(n); this.sign = s; }
        d(i) { return this[i]; }
        static mk(n) { var b = new B(1, false); b[0] = n; return b; }
      }
      function callD(o) { return o.d(0); }
      export function test() { return callD(B.mk(5)); }
    `);
    // Pre-fix: `null` — the dispatch missed entirely and nothing reported it.
    expect(callExport(mod)).toBe(5);
  });

  it("`this` reaches elements, an own field, `.length` and a sibling method", async () => {
    // Each is a separate `this` consumer inside the method body; the trampoline
    // used to hand all four a null receiver (`ref.null $B`), so the element read
    // threw and the field read answered null.
    const mod = await compileStandalone(`
      class B extends Array {
        constructor(n, s) { super(n); this[0] = 4; this.sign = s; }
        elem() { return this[0]; }
        field() { return this.sign; }
        len() { return this.length; }
        sib() { return this.elem(); }
      }
      function call(o, which) {
        return which === 0 ? o.elem() : which === 1 ? o.field() : which === 2 ? o.len() : o.sib();
      }
      export function test() {
        var b = new B(2, 3);
        return call(b, 0) + call(b, 1) + call(b, 2) + call(b, 3);
      }
    `);
    // 4 + 3 + 2 + 4
    expect(callExport(mod)).toBe(13);
  });

  it("the installed methods are NOT enumerable — `Object.keys` still sees only the elements", async () => {
    // The install uses §17 method attributes (`{writable, !enumerable,
    // configurable}`), the same flags `C.prototype` gets, so the method name
    // must not appear in the enumerable own-key surface. Asserted as ABSENCE of
    // the key rather than as a key COUNT: a standalone Array-subclass carrier
    // answers `Object.keys(b).length === 0` for its elements too (measured on
    // `origin/main`, unchanged by this PR and out of scope here), so a count
    // would be asserting that unrelated gap rather than this property.
    const mod = await compileStandalone(`
      class B extends Array { constructor(n) { super(n); this[0] = 1; this[1] = 2; } d() { return 7; } }
      function call(o) { return o.d(); }
      export function test() {
        var b = new B(2);
        var keys = Object.keys(b);
        var sawMethod = 0;
        for (var i = 0; i < keys.length; i++) if (keys[i] === "d") sawMethod = 1;
        return call(b) + 100 * sawMethod;
      }
    `);
    expect(callExport(mod)).toBe(7);
  });

  it("a plain class's dynamic dispatch keeps working (the struct arm is untouched)", async () => {
    const mod = await compileStandalone(`
      class P { constructor(v) { this.v = v; } d() { return this.v; } }
      function callD(o) { return o.d(); }
      export function test() { return callD(new P(5)); }
    `);
    expect(callExport(mod)).toBe(5);
  });

  it("an extracted method still sees an absent receiver — the #2025 TypeError is preserved", async () => {
    const mod = await compileStandalone(`
      class B extends Array { constructor(n) { super(n); this[0] = 4; } d() { return this[0]; } }
      export function test() {
        var b = new B(1);
        var f = b.d;
        try { f(); } catch (e) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }
    `);
    // 1 = calling the extracted method with no receiver threw a CATCHABLE
    // TypeError rather than trapping or silently answering.
    expect(callExport(mod)).toBe(1);
  });
});

// ── S2c ──────────────────────────────────────────────────────────────────────
//
// With S2b's subclass family fixed, the standalone `__module_init` stopped in
// the polyfill's `Intl` section: standalone deliberately leaves the `Intl`
// IDENTIFIER null (#5206 — there is no ICU in pure Wasm), and the polyfill
// reads that namespace at MODULE TOP LEVEL, so init threw at
// `"formatToParts" in ai.prototype` before any Temporal object existed.
//
// The fix is provider-local and lexical, not a codegen change: the #5383 S2c
// shim (`src/temporal-intl-shim.ts`) is prepended to the polyfill SOURCE for
// the standalone / WASI provider builds only. An `Intl.<member>` → `undefined`
// codegen arm was written and REVERTED in S2b — it moved the failure to the
// next line and changed what every standalone program sees.
//
// These cases pin the contract the shim has to meet, which is dictated by the
// polyfill's own eager uses:
//   * every EAGER use evaluates without throwing (init must RETURN), and
//   * every LAZY use throws a RangeError that NAMES the target.
//
// Measured with the shim in place (whole linked bundle, `--target standalone`,
// `hostBridge: "off"`, 2026-09-08): compiles in 44 s to 2.96 MB with ZERO
// imports, and `__module_init` RETURNS. Where it stops next is recorded in the
// issue file (S2c findings) — the `Temporal` namespace does not survive the
// linked-provider getter boundary, so the S2 smoke test is still not written.

describe("#5383 S2c — the standalone provider's `Intl` refusal shim", () => {
  it("every EAGER use the polyfill makes at module top level evaluates", async () => {
    // The shapes, verbatim in structure from the bundle:
    //   ct = Intl.DateTimeFormat                                  (cache)
    //   const ai = Intl.DateTimeFormat
    //   "formatToParts" in ai.prototype || delete Impl.prototype.formatToParts
    //   di.supportedLocalesOf = ai.supportedLocalesOf
    //   const {format,formatToParts} = Intl.DurationFormat?.prototype ?? {}
    const mod = await compileStandalone(
      withIntlShim(`
        const ct = Intl.DateTimeFormat;
        const ai = Intl.DateTimeFormat;
        class DateTimeFormatImpl { formatToParts() { return 1; } }
        "formatToParts" in ai.prototype || delete DateTimeFormatImpl.prototype.formatToParts;
        const di = {};
        di.supportedLocalesOf = ai.supportedLocalesOf;
        const durationProto = Intl.DurationFormat?.prototype;
        const tz = Intl.supportedValuesOf?.("timeZone");
        export function test() {
          var bits = 0;
          if (typeof ct === "function") bits += 1;
          // TRUE keeps the polyfill's own formatToParts — the delete branch
          // must not run, or its DateTimeFormat surface loses a method.
          if ("formatToParts" in ai.prototype) bits += 2;
          if (durationProto === undefined) bits += 4;
          if (tz === undefined) bits += 8;
          if (new DateTimeFormatImpl().formatToParts() === 1) bits += 16;
          return bits;
        }
      `),
    );
    expect(callExport(mod)).toBe(31);
  });

  it("a LAZY use throws a catchable RangeError that names the target", async () => {
    // `Temporal.Now.timeZoneId()` is `(new Intl.DateTimeFormat).resolvedOptions().timeZone`
    // in the bundle. The refusal has to be nameable — not a trap, not a wrong
    // answer. The 66 Intl-dependent Temporal rows are out of scope for #5383
    // and this is what they will report.
    const mod = await compileStandalone(
      withIntlShim(`
        export function test() {
          try {
            const f = new Intl.DateTimeFormat("en-US-u-ca-gregory", { day: "numeric" });
            return 0;
          } catch (e) {
            if (!(e instanceof RangeError)) return 1;
            return e.message.indexOf("--target standalone") >= 0 ? 2 : 3;
          }
        }
      `),
    );
    expect(callExport(mod)).toBe(2);
  });

  it("a method on the refusal class throws the same way, so `in`-probing it is safe", async () => {
    const mod = await compileStandalone(
      withIntlShim(`
        const ai = Intl.DateTimeFormat;
        export function test() {
          const proto = ai.prototype;
          try { proto.formatToParts(); } catch (e) { return e instanceof RangeError ? 1 : 2; }
          return 0;
        }
      `),
    );
    expect(callExport(mod)).toBe(1);
  });
});

describe("#5383 S2c — the shim re-keys the standalone provider and leaves the host lane alone", () => {
  const polyfillSource = "export const Temporal = { PlainDate: 1 };\n";

  it("the `gc` key is the fingerprint of the BUNDLE — the host provider is unaffected", () => {
    // The same two-part fingerprint `temporalProviderCacheKey` computes, with
    // the source NOT wrapped. If a future edit ever prepends anything on the
    // host lane this is what fails, and the host artifact sha would move with
    // it (measured identical across S2c: key 372a41be…, sha baff93a9…).
    const optionFingerprint = JSON.stringify({
      target: "gc",
      fast: false,
      nativeStrings: false,
      utf8Storage: false,
      semanticProviders: "auto",
      hostBridge: "auto",
      platform: "web",
    });
    const hash = createHash("sha256");
    for (const part of [polyfillSource, optionFingerprint]) {
      hash.update(String(part.length));
      hash.update(":");
      hash.update(part);
      hash.update("\n");
    }
    expect(temporalProviderCacheKey({ polyfillSource })).toBe(hash.digest("hex"));
  });

  it("standalone and wasi keys differ from `gc` and from each other", () => {
    const gc = temporalProviderCacheKey({ polyfillSource });
    const standalone = temporalProviderCacheKey({ polyfillSource, compileOptions: { target: "standalone" } as never });
    const wasi = temporalProviderCacheKey({ polyfillSource, compileOptions: { target: "wasi" } as never });
    expect(new Set([gc, standalone, wasi]).size).toBe(3);
  });

  it("the shim declares `Intl` once and prefixes its own binding", () => {
    const shim = standaloneIntlShimSource();
    expect(shim.match(/\bconst Intl\b/g)).toHaveLength(1);
    // Collision safety against the bundle's 340 top-level bindings.
    expect(shim).toContain("__js2wasm_IntlDateTimeFormat");
    expect(shim).toContain("--target standalone");
  });
});

// ── S2d — the standalone cross-module OBJECT boundary ───────────────────────
//
// The stop S2c measured: a value the provider mints reaches the consumer with
// ZERO own keys and every read `undefined`, while the SAME read inside the
// provider answers correctly. Two causes, both fixed here and both asserted
// below on a throwaway package (nothing Temporal-specific about either):
//
//   1. the linker replaced the boundary value with a JS host MIRROR even for a
//      provider compiled for a non-JavaScript environment — a mirror bound to
//      `__struct_field_names` / `__sget_*` exports that a standalone binary does
//      not have, handed to a consumer that is wasm and cannot read a JS proxy;
//   2. with the raw struct passing through, the consumer's dynamic terminals
//      are module-local `ref.test` ladders over the struct types THAT module
//      declared, so a provider-minted struct misses every arm. The provider now
//      publishes its own terminals (`standalone-link-boundary.ts`) and the
//      consumer asks them on the paths where its own ladder has already missed.
//
// Base measurements for the assertions (this branch's merge base, host-free
// standalone, `.tmp/s2d/probe3`): keys 0 / read `undefined` for ALL THREE
// carrier shapes below. The `gc` control answered the post-fix values on base
// already — that is what makes this standalone-specific.
describe("#5383 S2d — a provider-minted object survives the standalone getter boundary", () => {
  /** Three ways to build the same three-property object, three carriers. */
  const CARRIERS: Record<string, string> = {
    literal: `export const NS = { a: 1, b: 2, c: 3 };`,
    "assigned own props": `const o = {}; o.a = 1; o.b = 2; o.c = 3; export const NS = o;`,
    defineProperty: `const o = {};
      Object.defineProperty(o, "a", { value: 1, enumerable: true, writable: true, configurable: true });
      o.b = 2; o.c = 3; export const NS = o;`,
  };

  const CONSUMER = `
    export function keysHere() { return Object.keys(NS).length; }
    export function readA() { return NS.a === 1 ? 1 : (NS.a === undefined ? -1 : -2); }
    export function readMissing() { return NS.zzz === undefined ? 1 : 0; }
  `;

  async function linkAndRun(providerSource: string, target: "standalone" | "gc") {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2d-"));
    const packageRoot = join(root, "node_modules", "ns5383");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), providerSource);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = target === "standalone" ? { target: "standalone" as const, hostBridge: "off" as const } : {};
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and test nothing.
    expect(built.linkPlan?.mode).toBe("separate");
    const artifact = (built.linkedModules ?? []).find((entry) => entry.packageName === "ns5383")!;
    const boundary = artifact.exportBoundaries?.NS;
    expect(boundary?.kind).toBe("getter");
    const field = boundary!.field;
    const stub = "/__ns_stub.ts";
    const consumerEntry = "/__main.js";
    const result = await compileMulti(
      {
        [stub]: `export declare function ${field}(): any;\n`,
        [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${CONSUMER}`,
      },
      consumerEntry,
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        canonicalRuntimeTypes: true,
        sharedExceptionTag: true,
        link: [artifact.namespace],
        linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
        ...standalone,
      },
    );
    (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
    expect(result.success).toBe(true);
    // The EMPTY import object is the host-free contract: nothing below may
    // depend on a JS host being present.
    const { instance } = await instantiateLinkedProject(result, target === "standalone" ? {} : undefined);
    const exports = instance.exports as unknown as Record<string, () => unknown>;
    return { keysHere: exports.keysHere(), readA: exports.readA(), readMissing: exports.readMissing() };
  }

  for (const [name, source] of Object.entries(CARRIERS)) {
    it(`host-free standalone: a ${name} carrier keeps its keys and values`, { timeout: 300_000 }, async () => {
      expect(await linkAndRun(source, "standalone")).toEqual({ keysHere: 3, readA: 1, readMissing: 1 });
    });
  }

  it("the gc control answers identically — the host mirror path is untouched", { timeout: 300_000 }, async () => {
    expect(await linkAndRun(CARRIERS.literal, "gc")).toEqual({ keysHere: 3, readA: 1, readMissing: 1 });
  });
});

// ── S2e — a `defineProperty` sidecar key must not cross scopes ───────────────
//
// `ctx.sidecarDefinedPropertyKeys` is keyed by `"<identifierTEXT>:<prop>"`, so
// ONE `Object.defineProperty(e, "length", …)` anywhere routed EVERY `e.length`
// in the module through the runtime descriptor read — including one whose `e`
// is an unrelated local string, which the sidecar has no descriptor for, so the
// read answered `undefined`.
//
// In the compiled polyfill that local is the parameter of the ASCII-lowercase
// helper `function Ao(e){let t="";for(let n=0;n<e.length;n++)…}`: `e.length`
// read `undefined`, the loop never ran, `Ao("iso8601")` answered `""`, and
// `new Temporal.PlainDate(2024,1,1)` threw `RangeError: invalid calendar
// identifier `. Measured 2026-09-08 on the real bundle: renaming that one local
// to `zqx` — nothing else — made the same function correct, which is what
// identifies the KEY rather than the lowering. See sidecar-owner-scope.ts.
describe("#5383 S2e R10 — a defineProperty sidecar key is scoped to its own binding", () => {
  it("a local string named like a defineProperty receiver still reads `.length`", async () => {
    const mod = await compileStandalone(`
      const e = {};
      Object.defineProperty(e, "length", { value: 3, configurable: true, writable: true });
      export function outer() { const v = e.length; return typeof v === "number" ? v : -1; }
      export function test() {
        const e = "iso8601";
        let t = "";
        for (let n = 0; n < e.length; n++) { t += e.charCodeAt(n); }
        return t.length;
      }
    `);
    // The seven char codes of "iso8601" concatenated — 17 characters. Base
    // (before this fix) answered 0: the loop bound read `undefined`.
    expect(callExport(mod)).toBe(17);
    // The defineProperty receiver itself still reads through the sidecar.
    expect(callExport(mod, "outer")).toBe(3);
  });

  it("the same helper, driven the way the polyfill drives it", async () => {
    const mod = await compileStandalone(`
      const e = {};
      Object.defineProperty(e, "length", { value: 1, configurable: true, writable: true });
      function Ao(e) {
        let t = "";
        for (let n = 0; n < e.length; n++) {
          const r = e.charCodeAt(n);
          t += r >= 65 && r <= 90 ? String.fromCharCode(r + 32) : String.fromCharCode(r);
        }
        return t;
      }
      const CALENDARS = ["iso8601", "hebrew", "gregory"];
      export function test() { return CALENDARS.includes(Ao("ISO8601")) ? 1 : 0; }
    `);
    expect(callExport(mod)).toBe(1);
  });
});
