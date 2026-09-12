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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { runDogfoodScript } from "./dogfood/run-dogfood-script.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const S2K_HERE = dirname(fileURLToPath(import.meta.url));
import { standaloneIntlShimSource } from "../src/temporal-intl-shim.js";
import { temporalProviderCacheKey } from "../src/temporal-provider.js";
import { RUNTIME_RECGROUP_TYPE_NAMES } from "../src/emit/canonical-recgroup.js";

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

/**
 * (#5383 S2k) A structural fingerprint of the canonical runtime rec group —
 * the first recursive group in `binary`'s type section, which codegen emits
 * ahead of everything else and which holds exactly
 * `RUNTIME_RECGROUP_TYPE_NAMES`.
 *
 * WasmGC canonicalizes a rec group AS A WHOLE, so this has to compare the
 * group's own encoding and nothing else — in particular it must see the one
 * bit that distinguishes `sub` from `sub final` on a member, which is
 * invisible to any comparison made by type NAME or by absolute index. Returns
 * "" when the module has no leading rec group.
 */
function canonicalGroupFingerprint(binary: Uint8Array): string {
  let p = 8;
  const leb = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = binary[p++]!;
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v >>> 0;
  };
  while (p < binary.length) {
    const id = binary[p++]!;
    const size = leb();
    if (id !== 1) {
      p += size;
      continue;
    }
    leb(); // type count
    if (binary[p] !== 0x4e) return "";
    const groupStart = p;
    p++;
    const count = leb();
    expect(count, "the canonical group must hold exactly the frozen ABI members").toBe(
      RUNTIME_RECGROUP_TYPE_NAMES.length,
    );
    const valType = (): void => {
      const b = binary[p++]!;
      if (b === 0x63 || b === 0x64) leb(); // (ref null? <heaptype>) — signed, but LEB-shaped
    };
    const comp = (): void => {
      const k = binary[p++]!;
      if (k === 0x5f) {
        const n = leb();
        for (let i = 0; i < n; i++) {
          valType();
          p++; // mutability
        }
      } else if (k === 0x5e) {
        valType();
        p++; // mutability
      } else if (k === 0x60) {
        const a = leb();
        for (let i = 0; i < a; i++) valType();
        const r = leb();
        for (let i = 0; i < r; i++) valType();
      }
    };
    for (let i = 0; i < count; i++) {
      const tag = binary[p]!;
      if (tag === 0x50 || tag === 0x4f) {
        p++;
        const n = leb();
        for (let j = 0; j < n; j++) leb();
      }
      comp();
    }
    return createHash("sha256").update(binary.subarray(groupStart, p)).digest("hex").slice(0, 32);
  }
  return "";
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

// ── S2f R11 — `ref.test $__ta_ctor` is a STRUCTURAL test used as a NOMINAL one ─
//
// `$__ta_ctor` is `(struct (field kind i32) (field brand i32))`, both immutable
// (#5194 r3 F1 widened it from one field exactly to dodge a canonicalization
// collision with `__box_boolean_struct`). #2158/#2009 gives an empty class ROOT
// the SAME shape — `(field $__tag i32)` + `(field $__shape_brand i32)`. WasmGC
// canonicalizes structurally-identical types, so in any module that both holds
// a TypedArray constructor VALUE and declares a field-less class, every
// instance of that class passes `ref.test $__ta_ctor` — and the standalone
// `typeof` natives answered `"function"` for it.
//
// Measured 2026-09-08 on the compiled `@js-temporal/polyfill` under
// `--target standalone`, `hostBridge:"off"`: `typeof` through a one-parameter
// indirection said `"function"` for `new qi.Duration(0,0,0,0,1)` and
// `new qi.PlainDate(2024,1,1)`; the matched struct's two fields dumped as
// `{35, 0}` and `{33, 0}` — a class TAG and a `__shape_brand`, not
// `{kind, TA_CTOR_BRAND}`. The polyfill's own brand check
// `ne(e,…){ if (!e || "object" != typeof e) return !1; … }` therefore rejected
// every Temporal receiver, so every Temporal method and accessor threw
// `invalid receiver`. The fix checks the brand VALUE, not the shape
// (`taCtorIdentityTestInstrs`, `registry/types.ts`).
describe("#5383 S2f R11 — a field-less class instance is not a TypedArray constructor", () => {
  const MODULE = `
    const ctors = [Uint8Array, Int16Array];
    class Empty {}
    class Slots { constructor() { Slots.seen = 1; } }
    function tof(v) { return typeof v; }
    function isFn(v) { return typeof v === "function" ? 1 : 0; }
    export function test() { return tof(new Empty()) === "object" ? 1 : 0; }
    export function emptyIsFn() { return isFn(new Empty()); }
    export function slotsIsFn() { return isFn(new Slots()); }
    export function objIsFn() { return isFn({ a: 1 }); }
    export function ctorIsFn() { return isFn(ctors[0]); }
    export function bpe() { return ctors[1].BYTES_PER_ELEMENT; }
  `;

  it("`typeof` through a call boundary says `object`, not `function`", async () => {
    const mod = await compileStandalone(MODULE);
    // Base (before this fix) answered 0 here and 1 for `emptyIsFn`.
    expect(callExport(mod)).toBe(1);
    expect(callExport(mod, "emptyIsFn")).toBe(0);
    expect(callExport(mod, "slotsIsFn")).toBe(0);
    expect(callExport(mod, "objIsFn")).toBe(0);
  });

  it("a GENUINE TypedArray constructor keeps both answers", async () => {
    const mod = await compileStandalone(MODULE);
    expect(callExport(mod, "ctorIsFn")).toBe(1);
    expect(callExport(mod, "bpe")).toBe(2);
  });
});

// ── S2f R13 — a class VALUE is callable, and R12 carries that across the link ─
//
// S2e recorded this as a BOUNDARY defect ("a class value crosses but reports
// `typeof "object"`"). Re-measured 2026-09-08, it is not: a class value answers
// `typeof "object"` inside ONE standalone module too, the moment it is read
// through a parameter rather than as a bare identifier. A class VALUE is a
// `$ClassName` struct with the same type AND the same `__tag` as an instance
// (#3976 / `class-object-of.ts`), so nothing about its TYPE distinguishes it —
// only its IDENTITY, the lazily-materialised class-object singleton global.
// The compile-time fold answers `"function"` for the bare identifier, which is
// why the gap only shows through an indirection (#2984 path-dependence).
describe('#5383 S2f R13 — a class VALUE answers `typeof "function"` at runtime', () => {
  const MODULE = `
    class PlainDate { constructor(y) { this.y = y; } day() { return 1; } }
    function isFn(x) { return typeof x === "function" ? 1 : 0; }
    function tofn(x) { return typeof x; }
    export function test() { const v = PlainDate; return isFn(v); }
    export function materialized() { const v = PlainDate; return tofn(v) === "function" ? 1 : 0; }
    export function instanceIsObject() { const d = new PlainDate(1); return tofn(d) === "object" ? 1 : 0; }
    export function plainObjectIsObject() { return isFn({ a: 1 }); }
    export function realFn() { const f = function () { return 1; }; return isFn(f); }
  `;

  it("through a parameter — the inline compare and the materialized result agree", async () => {
    const mod = await compileStandalone(MODULE);
    // Base answered 0 for both: the runtime natives had no arm for the carrier.
    expect(callExport(mod)).toBe(1);
    expect(callExport(mod, "materialized")).toBe(1);
  });

  it("an INSTANCE, a plain object and a real function keep their answers", async () => {
    const mod = await compileStandalone(MODULE);
    // The instance shares the class value's struct TYPE and `__tag`; only
    // identity separates them, which is what makes this arm exact.
    expect(callExport(mod, "instanceIsObject")).toBe(1);
    expect(callExport(mod, "plainObjectIsObject")).toBe(0);
    expect(callExport(mod, "realFn")).toBe(1);
  });
});

describe("#5383 S2f R12 — a provider-owned class VALUE is callable in the consumer", () => {
  // The polyfill's own namespace shape:
  // `var qi = Object.freeze({__proto__: null, Duration, Instant, PlainDate, …})`.
  const PROVIDER = `class PlainDate { constructor(y) { this.y = y; } day() { return 1; } }
    const Now = { a: 1 };
    export const NS = Object.freeze({ __proto__: null, PlainDate, Now, b: 2 });`;

  const CONSUMER = `
    export function keys() { return Object.keys(NS).length; }
    export function b() { return NS.b; }
    export function nowA() { return NS.Now.a; }
    export function hasPD() { return NS.PlainDate === undefined ? 0 : 1; }
    export function typeofPD() { const v = NS.PlainDate; return typeof v === "function" ? 1 : (typeof v === "object" ? 2 : 3); }
  `;

  async function linkAndRun() {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2f-"));
    const packageRoot = join(root, "node_modules", "ns5383f");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383f", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383f";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = { target: "standalone" as const, hostBridge: "off" as const };
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    expect(built.linkPlan?.mode).toBe("separate");
    const artifact = (built.linkedModules ?? []).find((e) => e.packageName === "ns5383f")!;
    const field = artifact.exportBoundaries!.NS!.field;
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
    // EMPTY import object — the host-free contract.
    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => unknown>;
    return { keys: ex.keys(), b: ex.b(), nowA: ex.nowA(), hasPD: ex.hasPD(), typeofPD: ex.typeofPD() };
  }

  it("host-free: the class value crosses AND reports `function`", { timeout: 300_000 }, async () => {
    // Base answered `typeofPD: 2` ("object"), which is what made
    // `new Temporal.PlainDate(…)` unreachable from a consumer. The other four
    // answers are S2d's, restated here so this case also guards them.
    expect(await linkAndRun()).toEqual({ keys: 3, b: 2, nowA: 1, hasPD: 1, typeofPD: 1 });
  });
});

// ── S2g — `new` on a class VALUE runs the constructor body ───────────────────
//
// R14. `fillNativeConstructDrivers`'s ordinary tail is a CLOSURE dispatch
// (`__call_fn_method_<N>`). A class reached as a value is the class-object
// singleton — a `$ClassName` struct — so the dispatch missed, the result was
// null, and the driver returned the bare `Object.create(proto)`: an object with
// none of the constructor's own fields. Each class now has a `construct`
// trampoline (`standalone-class-construct.ts`) reached by IDENTITY (`ref.eq`
// against the singleton), which calls the SAME `<Class>_new` a static
// `new C(…)` calls — so field initializers, `super(…)` and parameter defaults
// come from the one lowering rather than a second copy of it.
describe("#5383 S2g R14 — `new K(…)` on a class value runs the constructor", () => {
  it("the three-line reduction: base returned an empty object, not `5`", async () => {
    const mod = await compileStandalone(`
      class PlainDate { constructor(y) { this.y = y; } }
      const mk = (K) => new K(5);
      export function test() { return mk(PlainDate).y; }
    `);
    expect(callExport(mod)).toBe(5);
  });

  it("more args than declared, fewer than declared (the default runs), and `super(…)`", async () => {
    const mod = await compileStandalone(`
      class A { constructor(y) { this.y = y; } }
      class B { constructor(y = 7) { this.y = y; } }
      class Sub extends A { constructor(y) { super(y * 2); this.z = 1; } }
      const mk0 = (K) => new K();
      const mk1 = (K) => new K(5);
      const mk3 = (K) => new K(5, 6, 7);
      export function test() {
        const s = mk1(Sub);
        return mk3(A).y * 1000 + mk0(B).y * 100 + s.y + s.z * 100000;
      }
    `);
    // 5·1000 (extra args dropped) + 7·100 (the `= 7` default ran, so NOT 0)
    // + 10 (`super(y*2)`) + 100000 (the subclass's own field).
    expect(callExport(mod)).toBe(105_710);
  });

  it("a field initializer runs, and the result is a real instance", async () => {
    const mod = await compileStandalone(`
      class Init { n = 3; constructor(y) { this.y = y; } sum() { return this.y + this.n; } }
      const mk = (K, v) => new K(v);
      export function test() {
        const a = mk(Init, 4);
        return a.sum() * 10 + (a instanceof Init ? 1 : 0);
      }
    `);
    // 7 = 4 + the field initializer's 3; `instanceof` holds because the
    // trampoline returns the ordinary `<Class>_new` instance.
    expect(callExport(mod)).toBe(71);
  });

  it("a plain function VALUE still takes the ordinary §10.2.2 tail", async () => {
    const mod = await compileStandalone(`
      class Unrelated { constructor(y) { this.y = y; } }
      function Ctor(x) { this.x = x; }
      const mk = (K) => new K(3);
      export function test() { return mk(Ctor).x * 10 + mk(Unrelated).y; }
    `);
    // The class arm answers null for a closure callee, so the driver falls
    // through to exactly the code it ran before this slice.
    expect(callExport(mod)).toBe(33);
  });
});

describe("#5383 S2g R14 — `new` on a provider-owned class, host-free", () => {
  const PROVIDER = `class PlainDate {
      constructor(y, m, d) { this.y = y; this.m = m; this.d = d; }
    }
    export const NS = Object.freeze({ __proto__: null, PlainDate, b: 2 });`;

  // Own FIELDS only, deliberately. A dynamic read of a PROTOTYPE member
  // (method or accessor) on a foreign instance is a separate, still-open stop —
  // see the S2g findings in plan/issues/5383-standalone-temporal-provider.md;
  // it reproduces in ONE module, with no boundary, so it is not this slice's.
  const CONSUMER = `
    export function year() { const d = new NS.PlainDate(2024, 1, 1); return d.y; }
    export function day() { const d = new NS.PlainDate(2024, 1, 1); return d.d; }
    export function b() { return NS.b; }
  `;

  it("`new NS.PlainDate(2024,1,1)` reaches the constructor body", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2g-"));
    const packageRoot = join(root, "node_modules", "ns5383g");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383g", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383g";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = { target: "standalone" as const, hostBridge: "off" as const };
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    expect(built.linkPlan?.mode).toBe("separate");
    const artifact = (built.linkedModules ?? []).find((e) => e.packageName === "ns5383g")!;
    const field = artifact.exportBoundaries!.NS!.field;
    const consumerEntry = "/__main.js";
    const result = await compileMulti(
      {
        "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
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
    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => unknown>;
    // Base answered `{ day: undefined, year: undefined }`: the member callee
    // reached no construct path at all (null), and once it did, the boundary's
    // ordinary tail returned `Object.create(proto)` — an instance with none of
    // the constructor's own fields.
    expect({ day: ex.day(), year: ex.year(), b: ex.b() }).toEqual({ day: 1, year: 2024, b: 2 });
  });
});

describe("#5383 S2h — a runtime-key read reaches the class PROTOTYPE (standalone)", () => {
  // The S2g reduction, verbatim. `_d` (an own field) and `o.sum(1)` (the
  // `__call_m_sum_1` closed dispatcher) already worked; the accessor and the
  // method VALUE did not, because `__extern_get`'s ladder serves a closed
  // `$ClassName` struct's own fields and has no notion of its prototype.
  const REDUCTION = `
    class PlainDate {
      constructor(d) { this._d = d; }
      get day() { return this._d; }
      sum(k) { return this._d + k; }
    }
    function readDyn(o, k) { return o[k]; }
  `;

  it("a prototype ACCESSOR read under a runtime key answers, with the INSTANCE as `this`", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const v = readDyn(new PlainDate(7), "day");
        return typeof v === "number" ? v : -1;
      }
    `);
    // Base: -1 (`undefined`). The receiver half matters independently — with the
    // prototype built but the delegation done as a plain `__extern_get(proto,
    // key)`, the getter ran with the PROTOTYPE as `this` and THREW.
    expect(callExport(mod)).toBe(7);
  });

  it("a prototype METHOD read under a runtime key answers a callable bound by the call site", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const f = readDyn(new PlainDate(7), "sum");
        if (typeof f !== "function") return -1;
        return f.call(new PlainDate(3), 1) * 10 + 1;
      }
    `);
    // Base: -1 — `typeof o["sum"]` was `"undefined"`. 4 = 3 + 1: the explicit
    // receiver wins, so the value is the canonical UNBOUND method singleton.
    expect(callExport(mod)).toBe(41);
  });

  it("an OWN field and a dynamic method CALL keep their answers", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const own = readDyn(new PlainDate(7), "_d");
        const called = new PlainDate(7).sum(1);
        const o = new PlainDate(7);
        const k = "sum";
        const computed = o[k](2);
        return own * 100 + called * 10 + computed;
      }
    `);
    // 7 / 8 / 9 — all three answered correctly BEFORE this slice, and the
    // `__hasOwnProperty` guard on the new delegation is what keeps the own
    // field from being shadowed by the prototype.
    expect(callExport(mod)).toBe(789);
  });
});

describe("#5383 S2h — prototype members of a PROVIDER-owned instance, host-free", () => {
  const PROVIDER = `class PlainDate {
      constructor(y, m, d) { this.y = y; this.m = m; this.d = d; }
      get day() { return this.d; }
      sum(k) { return this.y + k; }
    }
    export const NS = Object.freeze({ __proto__: null, PlainDate, b: 2 });`;

  const CONSUMER = `
    export function ownField() { const d = new NS.PlainDate(2024, 1, 1); return d.y; }
    export function protoAccessor() { const d = new NS.PlainDate(2024, 1, 1); const v = d.day; return typeof v === "number" ? v : -1; }
    export function protoMethodTypeof() { const d = new NS.PlainDate(2024, 1, 1); return typeof d.sum === "function" ? 1 : 0; }
    export function protoMethodCall() { const d = new NS.PlainDate(2024, 1, 1); return d.sum(1); }
    export function keys() { return Object.keys(NS).length; }
  `;

  it("the accessor, the method value and the method CALL all cross", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2h-"));
    const packageRoot = join(root, "node_modules", "ns5383h");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383h", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383h";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = { target: "standalone" as const, hostBridge: "off" as const };
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    const artifact = (built.linkedModules ?? []).find((e) => e.packageName === "ns5383h")!;
    const field = artifact.exportBoundaries!.NS!.field;
    const consumerEntry = "/__main.js";
    const result = await compileMulti(
      {
        "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
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
    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => unknown>;
    // Base (the S2g branch): accessor -1, typeof 0, and `d.sum(1)` threw
    // "is not a function". The own field and the key count (2 — `PlainDate`
    // and `b`; `__proto__: null` is not an own key) already crossed.
    expect({
      ownField: ex.ownField(),
      protoAccessor: ex.protoAccessor(),
      protoMethodTypeof: ex.protoMethodTypeof(),
      protoMethodCall: ex.protoMethodCall(),
      keys: ex.keys(),
    }).toEqual({ ownField: 2024, protoAccessor: 1, protoMethodTypeof: 1, protoMethodCall: 2025, keys: 2 });
  });

  // STILL OPEN — the remaining S2h stop, measured on this branch
  // (`.tmp/linkprobe.mts`): a STATIC method read off a class VALUE.
  // `typeof NS.PlainDate.mk` is `"undefined"` and `NS.PlainDate.mk(7)` throws
  // "is not a function", module-locally as well as across the boundary
  // (`.tmp/r7.js` answers the same three ways on the S2g base and on this
  // branch — this slice neither fixes nor regresses it). The class OBJECT is a
  // `$ClassName` struct whose static surface lives in the #5195 Step 2 static
  // SIDECAR, and that sidecar is built only for a class with a RUNTIME-KEYED
  // static. Widening it is the rest of #5195 cluster B and carries a known
  // static-FIELD-vs-sidecar precedence residual, so it is its own slice.
  // This is what still blocks `Temporal.Duration.from({hours:1}).total(…)`,
  // and it is why the three-assertion S2 smoke test is not yet writable.
  it.todo("a STATIC method on a provider-owned class value is callable (#5195 cluster B)");
});

describe("#5383 S2i — a STATIC member on a class VALUE (standalone)", () => {
  // The S2h reduction's static twin. `C.sf` / `C.mk(5)` / `C.acc` (the TYPED
  // reads) already worked through the `staticProps` / static-dispatch ladders;
  // every DYNAMIC read of the same surface answered `undefined`, because the
  // class OBJECT is a `$ClassName` struct (#3976) whose static members live in
  // the #5195 Step 2 sidecar `$Object` — built only for a class with a
  // RUNTIME-KEYED static, which `C` is not.
  const REDUCTION = `
    class C {
      static sf = 7;
      static mk(a) { return a + 1; }
      static get acc() { return 11; }
      constructor(d) { this._d = d; }
      get day() { return this._d; }
    }
    function readDyn(o, k) { return o[k]; }
  `;

  it("a static METHOD read under a runtime key answers a callable", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const f = readDyn(C, "mk");
        if (typeof f !== "function") return -1;
        return f(5);
      }
    `);
    // Base: -1 — `typeof C["mk"]` was `"undefined"`.
    expect(callExport(mod)).toBe(6);
  });

  it("a static ACCESSOR read under a runtime key answers", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const v = readDyn(C, "acc");
        return typeof v === "number" ? v : -1;
      }
    `);
    // Base: -1. The half is receiver-free, which is the #5318 Step 1c
    // precondition for installing a static accessor on the sidecar at all.
    expect(callExport(mod)).toBe(11);
  });

  it("a named static method call on a DYNAMIC class-value receiver lands", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      const NS = { C: C, b: 2 };
      export function test() {
        const K = readDyn(NS, "C");
        const v = K.mk(7);
        return typeof v === "number" ? v : -1;
      }
    `);
    // Base: THREW "is not a function" — `__extern_method_call`'s
    // resolve-then-apply is `ref.test $Object`-gated and a class object is a
    // `$ClassName` struct, so it fell to the non-`$Object` arm. This is the
    // shape `Temporal.Duration.from({…})` has.
    expect(callExport(mod)).toBe(8);
  });

  it("`C[k](…)` with a runtime key calls the static", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const k = ("m" + "k").length > 1 ? "mk" : "x";
        const v = C[k](5);
        return typeof v === "number" ? v : -1;
      }
    `);
    // Base: `undefined` (NaN through the f64 result).
    expect(callExport(mod)).toBe(6);
  });

  // THE PRECEDENCE ANSWER (#5383 S2i, the question S2h deferred).
  //
  // The sidecar carries static METHODS and ACCESSORS and deliberately not
  // static FIELDS — a mirrored mutable slot would be two sources of truth. So
  // the question was whether routing every class-value read through it shadows
  // the `staticProps` lowering of a field. It does not, and there was never an
  // overlap to shadow: `ctx.staticProps` is a purely SYNTACTIC lowering
  // (`C.sf` -> `global.get`), with no runtime name->slot map, so the DYNAMIC
  // read never consulted it and answered `undefined` before this slice and
  // still answers `undefined` after. The typed read/write keep `staticProps` as
  // the one source of truth, INCLUDING after a write.
  it("a static FIELD keeps `staticProps`: typed read/write unchanged, dynamic read still `undefined`", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const before = readDyn(C, "sf");
        const typedBefore = C.sf;
        C.sf = 42;
        const after = readDyn(C, "sf");
        const typedAfter = C.sf;
        // 7 / 42 from the staticProps global; both dynamic reads undefined.
        return (before === undefined ? 1000 : 0)
             + (after === undefined ? 2000 : 0)
             + typedBefore * 100 + typedAfter;
      }
    `);
    expect(callExport(mod)).toBe(3000 + 700 + 42);
  });

  it("the INSTANCE surface and the typed static ladders keep their answers", async () => {
    const mod = await compileStandalone(`${REDUCTION}
      export function test() {
        const inst = readDyn(new C(3), "day");
        const typedMethod = C.mk(5);
        const typedAccessor = C.acc;
        return inst * 10000 + typedMethod * 100 + typedAccessor;
      }
    `);
    // 3 / 6 / 11 — the S2h prototype path and both typed static ladders,
    // all three unchanged by the widening.
    expect(callExport(mod)).toBe(30000 + 600 + 11);
  });
});

describe("#5383 S2i — STATIC members of a PROVIDER-owned class value, host-free", () => {
  const PROVIDER = `class PlainDate {
      constructor(y, m, d) { this.y = y; this.m = m; this.d = d; }
      static mk(k) { return k + 1; }
      static get tag() { return 5; }
      get day() { return this.d; }
    }
    export const NS = Object.freeze({ __proto__: null, PlainDate, b: 2 });`;

  const CONSUMER = `
    export function staticTypeof() { return typeof NS.PlainDate.mk === "function" ? 1 : 0; }
    export function staticCall() { return NS.PlainDate.mk(7); }
    export function staticAccessor() { const v = NS.PlainDate.tag; return typeof v === "number" ? v : -1; }
    export function protoAccessor() { const d = new NS.PlainDate(2024, 1, 1); const v = d.day; return typeof v === "number" ? v : -1; }
    export function keys() { return Object.keys(NS).length; }
  `;

  it("the static value, the static CALL and the static accessor all cross", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2i-"));
    const packageRoot = join(root, "node_modules", "ns5383i");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383i", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383i";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = { target: "standalone" as const, hostBridge: "off" as const };
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    const artifact = (built.linkedModules ?? []).find((e) => e.packageName === "ns5383i")!;
    const field = artifact.exportBoundaries!.NS!.field;
    const consumerEntry = "/__main.js";
    const result = await compileMulti(
      {
        "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
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
    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => unknown>;
    // Base (the S2h branch): staticTypeof 0, `NS.PlainDate.mk(7)` threw "is not
    // a function", staticAccessor -1. The prototype accessor and the key count
    // already crossed (S2h) and are carried here as controls.
    expect({
      staticTypeof: ex.staticTypeof(),
      staticCall: ex.staticCall(),
      staticAccessor: ex.staticAccessor(),
      protoAccessor: ex.protoAccessor(),
      keys: ex.keys(),
    }).toEqual({ staticTypeof: 1, staticCall: 8, staticAccessor: 5, protoAccessor: 1, keys: 2 });
  });

  // (#5383 S2k) RESOLVED — S2j's "no reference value crosses from this
  // provider" was a rec-group canonicalization failure, and the mechanism is
  // one bit. The permanent guards for it are the two `describe` blocks below.
});

describe("#5383 S2k — the shared VALUE ABI survives a provider that uses `arguments`", () => {
  // WasmGC canonicalizes a recursive type group AS A WHOLE. The ten types in
  // `RUNTIME_RECGROUP_TYPE_NAMES` (the vec family + the string family) are the
  // frozen ABI of a wasm→wasm link, so if ONE member's `final` bit differs
  // between provider and consumer, all ten become different runtime types in
  // the engine and EVERY `ref.test` on a peer-minted value fails: a
  // provider-minted string is not a string, an array is not an array, an
  // object enumerates nothing.
  //
  // That is exactly what a provider using `arguments` did. It registers
  // `$__arguments_vec_externref` as a subtype of the group member
  // `$__vec_externref`, so `markLeafStructsFinal` left that member `sub`
  // (non-final) — while a consumer with no `arguments` emitted it `sub final`.
  // Measured on the type sections (`.tmp/s2k-types.mjs`): group [0..9] hashed
  // `2d74afdb81b1` in the consumer and `bc74a429728b` in the polyfill
  // provider, differing in that single member and nothing else.
  //
  // `arguments` is only the trigger that happened to be reachable — any
  // module-local subtype of any group member would do it. The fix pins every
  // member open whenever the canonical group is emitted, so the group's
  // identity is a constant of the ABI rather than a function of module
  // content. This reduction uses `arguments` because it is the cheap,
  // real-world trigger; the polyfill is not needed to reproduce it.
  const PROVIDER = `
    function argCount() { return arguments.length; }
    export const probe = argCount(1, 2, 3);
    export const str = "hello";
    export const arr = [1, 2, 3];
    export const obj = { a: 1, b: 2 };
  `;

  const CONSUMER = `
    export function probe() { return NS.probe; }
    export function strType() { return typeof NS.str === "string" ? 1 : 0; }
    export function strLen() { const v = NS.str.length; return typeof v === "number" ? v : -1; }
    export function strEq() { return NS.str === "hello" ? 1 : 0; }
    export function arrIs() { return Array.isArray(NS.arr) ? 1 : 0; }
    export function arrLen() { const v = NS.arr.length; return typeof v === "number" ? v : -1; }
    export function arr0() { const v = NS.arr[0]; return typeof v === "number" ? v : -1; }
    export function objKeys() { return Object.keys(NS.obj).length; }
    export function objA() { const v = NS.obj.a; return typeof v === "number" ? v : -1; }
  `;

  it(
    "a string, an array and an object all cross from a provider that uses `arguments`",
    { timeout: 300_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "issue-5383-s2k-"));
      const packageRoot = join(root, "node_modules", "ns5383k");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "ns5383k", version: "0.0.0", main: "index.js" }),
      );
      writeFileSync(join(packageRoot, "index.js"), PROVIDER);
      const entry = join(root, "entry.js");
      writeFileSync(
        entry,
        `import { probe, str, arr, obj } from "ns5383k";\nconst NS = { probe, str, arr, obj };\n${CONSUMER}\n`,
      );
      const built = await compileProject(entry, {
        allowJs: true,
        skipSemanticDiagnostics: true,
        packageCacheDir: join(root, "providers"),
        target: "standalone",
        hostBridge: "off",
      });
      expect(built.success).toBe(true);
      expect(built.linkPlan?.mode, "the provider must be a SEPARATE module for this to test anything").toBe("separate");
      const { instance } = await instantiateLinkedProject(built, {});
      const ex = instance.exports as unknown as Record<string, () => unknown>;
      // Base (before this fix): every reference row answered 0 / -1 while
      // `probe` (an unboxed f64) answered 3 — the S2j signature exactly.
      expect({
        probe: ex.probe(),
        strType: ex.strType(),
        strLen: ex.strLen(),
        strEq: ex.strEq(),
        arrIs: ex.arrIs(),
        arrLen: ex.arrLen(),
        arr0: ex.arr0(),
        objKeys: ex.objKeys(),
        objA: ex.objA(),
      }).toEqual({
        probe: 3,
        strType: 1,
        strLen: 5,
        strEq: 1,
        arrIs: 1,
        arrLen: 3,
        arr0: 1,
        objKeys: 2,
        objA: 1,
      });
    },
  );

  it("the canonical rec group is byte-identical whether or not the module uses `arguments`", async () => {
    // The direct statement of the invariant, independent of any link: two
    // standalone modules that differ ONLY in whether they use `arguments`
    // must emit the same canonical group. `canonicalRuntimeTypes: true` is
    // what a linked artifact carries.
    const opts = {
      fileName: "issue-5383-s2k.js",
      target: "standalone" as const,
      hostBridge: "off" as const,
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
    };
    const withArgs = await compile(
      `function f() { return arguments.length; }\nexport function test() { return f(1, 2) + "x".length; }`,
      opts as never,
    );
    const without = await compile(`export function test() { return "x".length; }`, opts as never);
    expect(withArgs.success && without.success).toBe(true);
    const a = canonicalGroupFingerprint(withArgs.binary);
    const b = canonicalGroupFingerprint(without.binary);
    // Base: `sub final` vs `sub` on the `$__vec_externref` member — the two
    // fingerprints differed and the link silently lost every reference value.
    expect(a).toEqual(b);
    expect(a).not.toBe("");
  });
});

describe("#5383 S2 smoke — the real standalone Temporal provider", () => {
  // The S2 acceptance test, through `buildTemporalProvider` +
  // `compileWithTemporalGlobal` (the shipped path), host-free. Two of the
  // three assertions pass as of S2k; the third has a named stop with its own
  // reduction, below.
  it(
    "Object.keys(Temporal).length === 9 and new Temporal.PlainDate(2024,1,1).day === 1",
    {
      timeout: 1_800_000,
    },
    async () => {
      // Child process: the 3.3 MB provider compile OOMs a vitest worker when run
      // in-process (measured 2026-09-12, V8 OOM before the first assertion) and
      // would stall its RPC heartbeat besides — the same reason every other
      // dogfood adapter is a child process.
      const report = JSON.parse(
        await runDogfoodScript(join(S2K_HERE, "dogfood", "temporal-s2-smoke-harness.mjs"), ["--json"]),
      );
      expect(report.provider.binaryBytes).toBeGreaterThan(1_000_000);
      const value = (label: string): unknown => {
        const probe = report.probes[label];
        return probe.status === "ok" ? probe.value : `${probe.status}: ${probe.error}`;
      };
      // Base (S2j, and every point its bisect covered — this was never 9 across
      // a real provider): keys 0, hasPlainDate 0, day -1, durationHours -1.
      expect({
        keys: value("keys"),
        hasPlainDate: value("hasPlainDate"),
        day: value("day"),
        durationHours: value("durationHours"),
      }).toEqual({ keys: 9, hasPlainDate: 1, day: 1, durationHours: 1 });
    },
  );

  // STILL OPEN — the third assertion,
  // `Temporal.Duration.from({hours:1}).total("minutes") === 60`.
  //
  // S2k's stop is CLOSED (see the S2l block below): the unit table now builds
  // correctly. Re-measured through the same in-provider probe S2k used, with
  // only the two S2l source files reverted, the error message CHANGED — which
  // is what makes this a new stop and not the old one:
  //
  //   base  (175 chars, ten `null`s)  "unit must be one of year, month, week,
  //                                    day, hour, minute, second, millisecond,
  //                                    microsecond, nanosecond, null ×10,
  //                                    not minutes"
  //   S2l   (58 chars, no `null`s)    "Convert JSBI instances to native numbers
  //                                    using `toNumber`."
  //
  // The new one is JSBI's own `valueOf` guard: something on the `total` path
  // applies an implicit ToNumber/ToPrimitive to a JSBI BigInt instance instead
  // of calling `toNumber()`. It reproduces INSIDE one standalone module with no
  // link (`.tmp/s2l-solo-total.mts`: the Intl shim + the linked polyfill + a
  // probe export, compiled with plain `compile({target:"standalone",
  // hostBridge:"off"})`), so the boundary is again not involved. It is present
  // on the base tree too — `total("minute")`, a SINGULAR unit that was always
  // in the table, answers the same failure on both trees, so this defect never
  // depended on the `fromEntries` one.
  //
  // ── S2m UPDATE (2026-09-12) ─────────────────────────────────────
  //
  // BOTH facts above are now FIXED, and neither was what its description said.
  //
  //  - The JSBI guard was not an implicit ToNumber of ours at all. It was the
  //    polyfill's own `__toPrimitive`, entered because `i.constructor === JSBI`
  //    read FALSE: `class JSBI extends Array`, and standalone that read
  //    answered `Array`. See the `#5383 S2m R15` block for the reduction and
  //    the falsified hypothesis. Through the real polyfill compiled as ONE
  //    standalone module, `Duration.from({hours:1}).total("minutes")` now
  //    answers **60** (`.tmp/s2m-solo-total.mts`; base: the JSBI throw).
  //  - The provider throw now crosses as a catchable error — `#5383 S2m R16`.
  //
  // The assertion is STILL not green, on a THIRD stop, which only the LINK
  // shows. Measured on this branch against the real provider
  // (`.tmp/s2m-total2.mts`, `.tmp/s2m-total.mts`):
  //
  //   | probe (real provider)                     | solo module | linked |
  //   | ----------------------------------------- | ----------- | ------ |
  //   | `d.hours`, `d.sign` (getters)             | 1 / 1       | 1 / 1  |
  //   | `d.abs().hours`, `p.equals(p)`, `p.day`   | —           | ok     |
  //   | `d.total("minutes")`                      | **60**      | a provider-owned OBJECT |
  //
  // So it is not "primitives cannot cross": a TINY hand-written provider
  // answers every shape — number, string, boolean, object, zero-arg, one-arg —
  // correctly (`.tmp/s2m-prim.mts`, 9/9), and object-returning and
  // boolean-returning methods on the REAL provider cross too. What arrives
  // wrong is specifically `total`'s result, which reads `typeof "number"` in
  // the consumer while `String()` of it throws "Cannot convert object to
  // primitive value" — i.e. the consumer's `typeof` ladder and its value
  // decode disagree about a provider-owned carrier. That is a wasm↔wasm VALUE
  // ABI slice of its own, not a Temporal defect.
  //
  // (`d.toString()` is NOT evidence for it: that call throws in the SOLO
  //  module as well, so it is a separate pre-existing gap.)
  it.todo(
    "Temporal.Duration.from({hours:1}).total('minutes') === 60 (blocked: `total`'s result crosses the wasm↔wasm link as a provider-owned carrier that answers `typeof \"number\"` but does not decode as one — solo answers 60; see the S2m findings table — #5383 S2m)",
  );
});

describe("#5383 S2l — `Object.fromEntries` over a computed pair list, standalone", () => {
  // Two independent defects, one call site. Both are standalone-only and both
  // were decided by module CONTENT rather than by the source construct.
  //
  //  (A) SILENTLY WRONG VALUES. `Object.fromEntries`'s lib signature is
  //      `Iterable<readonly [PropertyKey, T]>`, so a callback returning
  //      `[t, e]` is CONTEXTUALLY a tuple and lowers to a nominal
  //      `$__tuple_N` struct with fields `_0`/`_1` — not to the indexable pair
  //      vec the same expression produces when bound to an `any` local first.
  //      The self-hosted `__object_fromEntries` reads each pair with
  //      `__extern_get_idx(pair, 0/1)`, which had arms for `$ObjVec`, typed
  //      vecs and closed array-like structs but NONE for a tuple, and answered
  //      `undefined` for both slots. Ten entries then all wrote
  //      `out[undefined] = undefined`, so the table came out as the single key
  //      `"undefined"`. Fixed by admitting tuple carriers as array-like
  //      candidates in `fillExternArrayLikeStructArms` (length = field count,
  //      `_i` = index i).
  //
  //  (B) ACCIDENTAL REFUSAL. Every non-array-literal argument fell through to
  //      `ensureLateImport`, whose funcMap lookup precedes the #1472 Phase B
  //      refusal — and `__object_fromEntries` is in funcMap only when
  //      something ELSE in the module already pulled in `ensureObjectRuntime`.
  //      So `Object.fromEntries(nt.map(([e,t]) => [t,e]))` compiled (its
  //      array-literal callback body ensures the runtime) while
  //      `Object.fromEntries(nt)`, `nt.slice(0)` and `nt.map((e) => e)` were
  //      refused. The call site now ensures the runtime itself and calls the
  //      native directly when the argument is statically an array or tuple.
  //
  // A non-indexable iterable (a `Map`) deliberately KEEPS the refusal: the
  // native would walk it with `__extern_length` → 0 and hand back `{}`, which
  // is the silent-wrong failure this block exists to remove. #2190 owns that.
  const runStandaloneFromEntries = async (src: string): Promise<unknown> => {
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { test: () => unknown }).test();
  };

  const NT = `const nt: any[] = [["year","years"],["month","months"],["day","days"]];\n`;
  // keys*100 + (swapped lookup ok)*10 + (first value not undefined)*1
  const TAIL = `const ks = Object.keys(o);
      return ks.length * 100 + (o["years"] === "year" ? 10 : 0) + (o[ks[0]] === undefined ? 0 : 1);`;

  it("(A) a destructured-arrow pair list keeps its VALUES (base: 1 key, both slots undefined)", async () => {
    expect(
      await runStandaloneFromEntries(`${NT}export function test(): number {
        const o: any = Object.fromEntries(nt.map(([e, t]: any) => [t, e]));
        ${TAIL}
      }`),
    ).toBe(311);
  });

  it("(A) the same shape with a TYPED source array", async () => {
    expect(
      await runStandaloneFromEntries(`const nt: string[][] = [["year","years"],["month","months"],["day","days"]];
        export function test(): number {
          const o: any = Object.fromEntries(nt.map(([e, t]: string[]) => [t, e]));
          ${TAIL}
        }`),
    ).toBe(311);
  });

  it("(B) a bare array identifier compiles (base: #1472 Phase B refusal)", async () => {
    expect(
      await runStandaloneFromEntries(`${NT}export function test(): number {
        const o: any = Object.fromEntries(nt);
        return Object.keys(o).length * 100 + (o["year"] === "years" ? 10 : 0);
      }`),
    ).toBe(310);
  });

  it("(B) an array-returning method call compiles (base: refusal)", async () => {
    for (const expr of ["nt.slice(0)", "nt.concat([])", "nt.map((e: any) => e)"]) {
      expect(
        await runStandaloneFromEntries(`${NT}export function test(): number {
          const o: any = Object.fromEntries(${expr});
          return Object.keys(o).length * 100 + (o["year"] === "years" ? 10 : 0);
        }`),
        expr,
      ).toBe(310);
    }
  });

  it("the array-LITERAL fast path is unchanged", async () => {
    expect(
      await runStandaloneFromEntries(`export function test(): number {
        const o: any = Object.fromEntries([["a","b"],["c","d"]]);
        return (o.a === "b" && o.c === "d") ? 1 : -1;
      }`),
    ).toBe(1);
  });

  it("a non-indexable iterable still REFUSES rather than answering {}", async () => {
    const r = await compile(
      `export function test(): number {
         const m = new Map<string, string>();
         m.set("year", "years");
         const o: any = Object.fromEntries(m);
         return (o.year === "years") ? 1 : -1;
       }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("__object_fromEntries");
  });

  it("a tuple is array-like to the dyn-reader trio (the (A) mechanism, directly)", async () => {
    // `[string, number]` lowers to `$__tuple_N`; read it through a dynamic
    // `any` receiver so the read goes via `__extern_length`/`__extern_get_idx`
    // rather than a static `struct.get`. Base: length 0 and both reads
    // `undefined`, so the whole expression answered 0.
    expect(
      await runStandaloneFromEntries(`export function test(): number {
        const o: any = Object.fromEntries([["k", "v"]]);
        const p: [string, number] = ["a", 1];
        const dyn: any = p;
        return (o.k === "v" ? 100 : 0) + (dyn.length === 2 ? 10 : 0) + (dyn[0] === "a" ? 1 : 0);
      }`),
    ).toBe(111);
  });
});

describe("#5383 S2m R15 — `i.constructor` on an `extends Array` instance, standalone", () => {
  // S2l's stop was `Temporal.Duration.from({hours:1}).total("minutes")` throwing
  // JSBI's own guard, ``Convert JSBI instances to native numbers using
  // `toNumber`.``, from inside the compiled polyfill. The obvious reading — our
  // lowering applies an implicit ToNumber where JS does not — is WRONG, and was
  // falsified before anything was changed: a 27-probe matrix over every
  // operation the spec does not coerce through (strict equality, `typeof`,
  // ToBoolean, property read, method call, `instanceof`, argument passing,
  // spread, destructuring, `for-of`, `Map` round-trip, optional chaining, …)
  // against a class whose `valueOf` throws found ZERO divergences from node
  // (`.tmp/s2m-valueof.mts`).
  //
  // The coercion is the POLYFILL's own. `JSBI.__toPrimitive`, `__isBigInt` and
  // `BigInt` all open with `i.constructor === JSBI`; when that reads false
  // `__toPrimitive` falls through to `const t = i.valueOf; t.call(i)` — JSBI's
  // deliberately-throwing one. `class JSBI extends Array`, and standalone that
  // read answered **`Array`**: an externref-backed subclass instance's carrier
  // is a `$__vec_externref`, indistinguishable from a plain array, so the
  // generic ladder served the Array builtin's `constructor`. The JS-host lane
  // has answered this since #5377 (the fourth argument to
  // `__set_subclass_proto`, which is a documented no-op standalone).
  //
  // A PLAIN class was never affected — its instance is a closed `$ClassName`
  // struct the #5383 S2h prototype-lookup arm already serves — which is why the
  // matrix above is clean and why the defect needed the builtin-parent shape to
  // show at all.
  const PRELUDE = `
    class Guard extends Array {
      constructor(n, s) { super(n); this.sign = s; Object.setPrototypeOf(this, Guard.prototype); }
      valueOf() { throw new Error("COERCED"); }
      static toPrim(i) {
        if (typeof i !== "object") return i;
        if (i.constructor === Guard) return 1;
        const f = i.valueOf;
        if (f) { const r = f.call(i); if (typeof r !== "object") return r; }
        return 2;
      }
    }
    class Plain { constructor(v) { this.v = v; } }
    function whichCtor(i) {
      const c = i.constructor;
      return c === undefined ? 0 : c === Guard ? 1 : c === Array ? 2 : c === Plain ? 4 : 3;
    }`;

  const run = async (body: string): Promise<unknown> => {
    const { instance } = await compileStandalone(`${PRELUDE}\nexport function run() { ${body} }\n`);
    return (instance.exports as unknown as { run: () => unknown }).run();
  };

  it("the JSBI-shaped ToPrimitive guard takes the constructor branch", { timeout: 300_000 }, async () => {
    // Base: 0 — `i.constructor` read `Array`, so `__toPrimitive` fell through
    // to `i.valueOf` and the module threw `COERCED` out to the embedder. This
    // asserts the VALUE, so a regression that merely stops throwing still fails.
    expect(await run(`return Guard.toPrim(new Guard(2, false));`)).toBe(1);
  });

  it("answers the subclass through an opaque receiver, not the builtin parent", { timeout: 300_000 }, async () => {
    // A typed local was always right (1); only the opaque-parameter spelling —
    // which is how every JSBI static receives its argument — read `Array` (2).
    expect({
      typedLocal: await run(`const x = new Guard(2, false); return x.constructor === Guard ? 1 : 0;`),
      opaqueParam: await run(`return whichCtor(new Guard(2, false));`),
      plainUnaffected: await run(`return whichCtor(new Plain(1)) === 4 ? 1 : 0;`),
      // The install is non-enumerable §17, so the ENUMERABLE surface is
      // untouched. A/B'd against the base by file copy (`.tmp/s2m-keys.mts`):
      // `Object.keys` length and the `for…in` count are identical on both
      // trees, and `constructor` appears in neither key list. `keysLength` is 1
      // rather than node's 2 on BOTH trees — an index element pushed onto a vec
      // carrier is not an own key standalone, a pre-existing gap this slice
      // neither causes nor fixes.
      ctorNotAKey: await run(`const x = new Guard(0, false); x.push(7); const ks = Object.keys(x);
        let n = 0; for (let i = 0; i < ks.length; i++) if (ks[i] === "constructor") n++; return n;`),
      keysLength: await run(`const x = new Guard(0, false); x.push(7); return Object.keys(x).length;`),
      forInCount: await run(`const x = new Guard(0, false); x.push(7); let n = 0; for (const k in x) n++; return n;`),
      stillAnArray: await run(`return Array.isArray(new Guard(2, false)) ? 1 : 0;`),
    }).toEqual({
      typedLocal: 1,
      opaqueParam: 1,
      plainUnaffected: 1,
      ctorNotAKey: 0,
      keysLength: 1,
      forInCount: 2,
      stillAnArray: 1,
    });
  });
});

describe("#5383 S2m R16 — a provider-side throw is CATCHABLE in the consumer", () => {
  // A wasm exception is matched by TAG IDENTITY. Two separately compiled
  // standalone modules each DEFINE their own `__exn`, so a `throw` inside a
  // linked provider matched no handler in the consumer: the consumer's own
  // `try { NS.f() } catch (e) { … }` never ran and the raw
  // `WebAssembly.Exception` escaped to the embedder (measured on both trees in
  // S2l). Every test262 row that asserts `throws RangeError` is unscoreable in
  // that state — the negative half of the Temporal corpus.
  //
  // The JS-host lane's answer (#5226 `sharedExnTag`) is a JS-owned
  // `WebAssembly.Tag` imported as `env.__exn`, which needs a host and is
  // therefore explicitly off for standalone. The host-free twin needs no new
  // ABI: every module already EXPORTS its tag as `__exn_tag`, and
  // `instantiateLinkedProviders` already publishes each provider's export
  // record under its namespace on the consumer's import object. So the CONSUMER
  // imports `<provider-namespace>.__exn_tag` and uses it as its own — one tag
  // per graph, resolved by the linker that is already there, with no `env`
  // import and so no #2961 leak.
  const PROVIDER = `
    export const NS = Object.freeze({
      __proto__: null,
      boom() { throw new RangeError("x"); },
      boomType() { throw new TypeError("t"); },
      boomPlain() { throw new Error("e"); },
      ok() { return 7; },
    });`;

  const CONSUMER = `
    export function ok() { return NS.ok(); }
    export function caught() { try { NS.boom(); return 0; } catch (e) { return 1; } }
    export function message() { try { NS.boom(); return 0; } catch (e) { return e.message === "x" ? 1 : 2; } }
    export function isRangeError() { try { NS.boom(); return 0; }
      catch (e) { return (e instanceof RangeError) ? 1 : (e instanceof Error) ? 2 : 3; } }
    export function ctorIdentity() { try { NS.boom(); return 0; }
      catch (e) { return e.constructor === RangeError ? 1 : e.constructor === undefined ? 3 : 4; } }
    export function isTypeError() { try { NS.boomType(); return 0; }
      catch (e) { return (e instanceof TypeError) ? 1 : (e instanceof Error) ? 2 : 3; } }
    export function plainIsNotRange() { try { NS.boomPlain(); return 0; }
      catch (e) { return (e instanceof RangeError) ? 9 : (e instanceof Error) ? 1 : 3; } }
    export function rethrows() { try { try { NS.boom(); } catch (e) { throw e; } return 0; }
      catch (e) { return (e instanceof RangeError) ? 1 : 2; } }
    export function finallyRuns() { let n = 0; try { NS.boom(); } catch (e) { n += 1; } finally { n += 10; } return n; }
  `;

  it("crosses the link as a catchable error of the right class", { timeout: 600_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2m-"));
    const packageRoot = join(root, "node_modules", "ns5383m");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5383m", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "entry.js");
    writeFileSync(entry, `import { NS } from "ns5383m";\nexport function __probe() { return typeof NS; }\n`);
    const standalone = { target: "standalone" as const, hostBridge: "off" as const };
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...standalone,
    });
    expect(built.success).toBe(true);
    const artifact = (built.linkedModules ?? []).find((e) => e.packageName === "ns5383m")!;
    const field = artifact.exportBoundaries!.NS!.field;
    const consumerEntry = "/__main.js";
    const result = await compileMulti(
      {
        "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
        [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${CONSUMER}`,
      },
      consumerEntry,
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        canonicalRuntimeTypes: true,
        link: [artifact.namespace],
        linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
        ...standalone,
      },
    );
    (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
    expect(result.success).toBe(true);
    // The tag arrives through the provider's own namespace, NOT through `env` —
    // a standalone consumer that leaked an `env` import would fail #2961.
    const consumerImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
      (entry) => entry.kind === "tag",
    );
    expect(consumerImports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([
      `${artifact.namespace}::__exn_tag`,
    ]);

    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => unknown>;
    // Base: every row below except `ok` threw `[object WebAssembly.Exception]`
    // out of the call — the `catch` clause never ran at all.
    expect({
      ok: ex.ok(),
      caught: ex.caught(),
      message: ex.message(),
      isRangeError: ex.isRangeError(),
      ctorIdentity: ex.ctorIdentity(),
      isTypeError: ex.isTypeError(),
      plainIsNotRange: ex.plainIsNotRange(),
      rethrows: ex.rethrows(),
      finallyRuns: ex.finallyRuns(),
    }).toEqual({
      ok: 7,
      caught: 1,
      message: 1,
      isRangeError: 1,
      ctorIdentity: 1,
      isTypeError: 1,
      plainIsNotRange: 1,
      rethrows: 1,
      finallyRuns: 11,
    });
  });

  // NOT fixed here, and deliberately not conflated with the crossing above:
  // `e.constructor.name` and `typeof e.constructor` on a BUILTIN error are
  // already wrong in a SINGLE standalone module with no link at all
  // (`.tmp/s2m-ctorname.mts`: `localCtorIsRange` 1, `localInstanceof` 1,
  // `localMessage` 1, but `localCtorName` and `localTypeofCtor` both 4 — the
  // `__builtin_<Name>` carrier object has no `name` and does not answer
  // `typeof "function"`). The identity comparison is the one upstream
  // `assert.throws` makes (`thrown.constructor !== expectedErrorConstructor`),
  // and that one holds.
  it.todo(
    "`e.constructor.name` / `typeof e.constructor` on a builtin error answer standalone (pre-existing, single-module)",
  );
});

// ── S3 — the runner + CI wiring ───────────────────────────────────
//
// These are ROUTING tests, not conformance tests: they assert WHICH provider a
// lane asks for and what happens when it is not there. The conformance answer
// is measured in the issue file's S3 table (family-123, base vs branch), not
// asserted here — a 3.3 MB provider build per assertion is not a unit test.
//
// The property that matters most is FAIL SOFT, and it is deliberately tested
// from the negative side: a missing or corrupt standalone artifact must leave
// the lane disabled, so the rows keep the ambient `Temporal is not defined`
// verdict rather than timing out, compile-erroring, or taking the shard down.
describe("#5383 S3 the per-target Temporal lane gate", () => {
  const temporal = () => import("../scripts/test262-temporal.mjs");

  const withCacheDir = async (fn: (dir: string) => void | Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "js2wasm-temporal-s3-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("stamps host and standalone under different names, and keeps host's historical name", async () => {
    // One cache dir holds both providers; a shared file name could only ever
    // certify one of them, and the other lane would read a key that does not
    // match the artifact it is about to ask for.
    const { temporalPrewarmStampName, TEMPORAL_PREWARM_STAMP } = await temporal();
    expect(temporalPrewarmStampName(undefined)).toBe(TEMPORAL_PREWARM_STAMP);
    expect(temporalPrewarmStampName(undefined)).toBe("prewarm.json");
    expect(temporalPrewarmStampName("standalone")).toBe("prewarm-standalone.json");
  });

  it("asks for the host-free provider on standalone and the default one on host", async () => {
    const { temporalProviderCompileOptions } = await temporal();
    expect(temporalProviderCompileOptions(undefined)).toBeUndefined();
    expect(temporalProviderCompileOptions("standalone")).toEqual({ target: "standalone", hostBridge: "off" });
  });

  it("gives the two targets DIFFERENT cache keys", async () => {
    // If they collided, one lane's pre-warm would certify the other's artifact.
    const { temporalProviderCompileOptions } = await temporal();
    const polyfillSource = "export const Temporal = 1;\n";
    const host = temporalProviderCacheKey({ polyfillSource });
    const standalone = temporalProviderCacheKey({
      polyfillSource,
      compileOptions: temporalProviderCompileOptions("standalone"),
    });
    expect(standalone).not.toBe(host);
  });

  it("FAILS SOFT: no stamp, or a corrupt one, leaves the standalone lane unlinked", async () => {
    const { test262TemporalLaneEnabled, temporalPrewarmStampName } = await temporal();
    await withCacheDir((dir) => {
      // The shipped state today: nobody pre-warmed a standalone provider.
      expect(test262TemporalLaneEnabled("standalone", dir)).toBe(false);
      // A truncated / half-written artifact is the same answer as none. It must
      // never throw — a throw here would take the whole shard down.
      writeFileSync(join(dir, temporalPrewarmStampName("standalone")), "{ not json");
      expect(test262TemporalLaneEnabled("standalone", dir)).toBe(false);
      // A stamp without a `key` cannot certify anything either.
      writeFileSync(join(dir, temporalPrewarmStampName("standalone")), JSON.stringify({ bytes: 1 }));
      expect(test262TemporalLaneEnabled("standalone", dir)).toBe(false);
    });
  });

  it("opens the standalone lane once a standalone-keyed stamp is present", async () => {
    const { test262TemporalLaneEnabled, writeTemporalPrewarmStamp } = await temporal();
    await withCacheDir((dir) => {
      writeTemporalPrewarmStamp(
        dir,
        { key: "sa-key", namespace: "js2wasm:npm:@js-temporal/polyfill:sa", bytes: 3, buildMs: 1, cacheHit: false },
        "standalone",
      );
      expect(test262TemporalLaneEnabled("standalone", dir)).toBe(true);
      // The host lane never needs a stamp (it may build cold), and writing one
      // target's stamp must not land in the other's slot.
      expect(test262TemporalLaneEnabled(undefined, dir)).toBe(true);
      writeTemporalPrewarmStamp(
        dir,
        { key: "host-key", namespace: "js2wasm:npm:@js-temporal/polyfill:h", bytes: 3, buildMs: 1, cacheHit: false },
        undefined,
      );
      expect(readFileSync(join(dir, "prewarm.json"), "utf-8")).toContain("host-key");
      expect(readFileSync(join(dir, "prewarm-standalone.json"), "utf-8")).toContain("sa-key");
    });
  });

  it("never links on a lane with no provider at all (linear/wasi), stamp or not", async () => {
    const { test262TemporalLaneEnabled, writeTemporalPrewarmStamp } = await temporal();
    await withCacheDir((dir) => {
      for (const target of ["linear", "wasi"]) {
        writeTemporalPrewarmStamp(dir, { key: "x", namespace: "n", bytes: 1, buildMs: 1, cacheHit: false }, target);
        expect(test262TemporalLaneEnabled(target, dir)).toBe(false);
      }
    });
  });

  it("honours the JS2WASM_TEST262_TEMPORAL=0 opt-out on every lane", async () => {
    const { test262TemporalLaneEnabled, writeTemporalPrewarmStamp } = await temporal();
    await withCacheDir((dir) => {
      writeTemporalPrewarmStamp(dir, { key: "k", namespace: "n", bytes: 1, buildMs: 1, cacheHit: false }, "standalone");
      const previous = process.env.JS2WASM_TEST262_TEMPORAL;
      process.env.JS2WASM_TEST262_TEMPORAL = "0";
      try {
        expect(test262TemporalLaneEnabled(undefined, dir)).toBe(false);
        expect(test262TemporalLaneEnabled("standalone", dir)).toBe(false);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST262_TEMPORAL");
        else process.env.JS2WASM_TEST262_TEMPORAL = previous;
      }
    });
  });
});

describe("#5383 S3 the pre-warm step and the CI job", () => {
  const readRepoFile = (...parts: string[]) => readFileSync(join(S2K_HERE, "..", ...parts), "utf-8");

  it("the pre-warm script builds per target and stamps each one", () => {
    const script = readRepoFile("scripts", "prewarm-temporal-provider.mjs");
    expect(script).toContain("--target");
    expect(script).toContain("temporalProviderCompileOptions(target)");
    // The key MUST be computed with the same options the build uses, or the
    // stamp certifies an artifact nobody will ask for.
    expect(script).toContain("temporalProviderCacheKey({ polyfillSource, compileOptions })");
    expect(script).toContain("buildTemporalProvider({ polyfillSource, cacheDir, compileOptions })");
  });

  it("the standalone provider is OPT-IN, in CI and locally", () => {
    // Measured 2026-09-12: linking multiplies an ASSEMBLED standalone row's
    // compile time ~2.5-3.5x (17.4 s → 61.1 s on a 60 KB-harness intl402 row;
    // 4.2 s → 10.9 s on a 10.6 KB one). The fork kill is 30 s, so a default-on
    // artifact would convert large rows from an honest fail into a per-row
    // TIMEOUT. The wiring is complete either way — the flag only decides
    // whether the artifact EXISTS, and the stamp gate does the rest.
    const workflow = readRepoFile(".github", "workflows", "test262-sharded.yml");
    expect(workflow).toContain("standalone_temporal:");
    expect(workflow).toContain("needs.changes.outputs.run_standalone != 'false' && inputs.standalone_temporal");
    const script = readRepoFile("scripts", "run-test262-vitest.sh");
    expect(script).toContain("JS2WASM_TEST262_TEMPORAL_STANDALONE");
  });

  it("the workflow builds the standalone provider SOFT and the host one HARD", () => {
    const workflow = readRepoFile(".github", "workflows", "test262-sharded.yml");
    expect(workflow).toContain("node scripts/prewarm-temporal-provider.mjs --target host");
    expect(workflow).toContain("node scripts/prewarm-temporal-provider.mjs --target standalone");
    // The standalone step must be `continue-on-error`: no standalone baseline
    // was ever measured with a provider, so a failed build is a no-op for the
    // numbers and must not block the merge queue. The host step must NOT be —
    // the published baseline IS measured with the host provider.
    const standaloneStep = workflow.slice(workflow.indexOf("Build and stamp the provider (standalone)"));
    expect(standaloneStep.slice(0, 400)).toContain("continue-on-error: true");
    const hostStep = workflow.slice(
      workflow.indexOf("Build and stamp the provider (host)"),
      workflow.indexOf("Build and stamp the provider (standalone)"),
    );
    expect(hostStep).not.toContain("continue-on-error");
    // …and the host guarantee is still asserted somewhere, now explicitly.
    expect(workflow).toContain("test -f .test262-cache/temporal/prewarm.json");
  });

  it("every shard cell downloads the provider directory, standalone included", () => {
    const workflow = readRepoFile(".github", "workflows", "test262-sharded.yml");
    // A lane that cannot SEE the artifact can never link it. Both shard jobs
    // used to skip the download on standalone cells.
    expect(workflow).not.toMatch(/Download compiled Temporal provider \(#5353\)\n\s+if:/);
    expect(workflow.match(/Download compiled Temporal provider \(#5353\)/g)?.length).toBe(2);
    // And the directory is always uploadable, even when the soft build failed —
    // `download-artifact` fails hard on a missing artifact, which would turn
    // this slice's fail-soft into a red standalone lane.
    expect(workflow).toContain("Ensure the provider directory is uploadable");
  });

  it("the local test262 entry point pre-warms the lane it is about to run", () => {
    const script = readRepoFile("scripts", "run-test262-vitest.sh");
    expect(script).toContain("--target standalone");
    expect(script).toContain("--target host");
  });

  it("a run with no standalone artifact is byte-identical to the pre-S3 behaviour", () => {
    // The whole fail-soft argument in one assertion: with the artifact off (the
    // default), the standalone lane's answer comes from the stamp gate, not
    // from any lane-local condition that could drift.
    const worker = readRepoFile("scripts", "test262-worker.mjs");
    expect(worker).toContain("test262TemporalLaneEnabled");
    const shared = readRepoFile("tests", "test262-shared.ts");
    expect(shared).toContain("test262TemporalLaneEnabled(TEST262_TARGET)");
    const runner = readRepoFile("tests", "test262-runner.ts");
    expect(runner).toContain("test262TemporalLaneEnabled(target)");
  });
});
