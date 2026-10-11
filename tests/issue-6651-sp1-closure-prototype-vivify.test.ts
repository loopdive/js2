// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane SP1 — §10.2.5 MakeConstructor for a function value with no
// compile-time prototype global, on `--target standalone`.
//
// ## The cause
//
// A standalone function value's prototype object is keyed by a COMPILE-TIME
// NAME, in two registries (`ctx.fnctorPrototypeObject` for user fnctors,
// `ctx.protoGlobals` for classes). An anonymous function EXPRESSION written
// straight into a property —
//
//     sample.constructor[Symbol.species] = function (count) { … };
//
// — is in neither, so `Get(S, "prototype")` answered `undefined` and everything
// downstream of §10.2.5 failed: `__native_construct_<N>` (#3981) links the
// constructed `this` with `__object_create(proto)`, so `this` came back with NO
// `[[Prototype]]`, and `instanceof` / `Object.getPrototypeOf` disagreed with the
// spec. `closure-prototype-edge.ts`'s `prototype` GET arm now performs
// MakeConstructor LAZILY on that miss: it mints one `$Object` and defines it as
// the closure's own `prototype` in the #3468 bag, so the object is stable across
// reads and the construct driver, `instanceof` and `Object.getPrototypeOf` all
// agree on ONE identity.
//
// ## Measured
//
// Probes below are the compile+run harness; the test262 evidence is in the lane
// receipt at the end of
// `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`. The headline:
// on an instrumented copy of
// `built-ins/TypedArray/prototype/slice/speciesctor-get-species-custom-ctor-invocation.js`
// run through the authoritative lane, `typeof S.prototype === "object"`,
// `Object.getPrototypeOf(ctorThis) === S.prototype` and
// `S.prototype.isPrototypeOf(ctorThis)` were ALL false/undefined on the base and
// are ALL correct after. The row itself still fails on a SECOND, unrelated cause
// (a captured-`var` value-representation defect — see the receipt and the
// residual control at the bottom of this file).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a test262-shaped module (loose, untyped, top-level statements) the way
 * the runner does — `skipSemanticDiagnostics` + `deferTopLevelInit` — and answer
 * the accumulated `__r` bitmask.
 *
 * The runner's option shape is load-bearing, not cosmetic: an annotated probe
 * takes a DIFFERENT lowering from the one the harness generates (the #6651 "two
 * disjoint lowerings, picked by the operand's static shape" hazard), so every
 * case below keeps the verbatim untyped spelling.
 */
async function runTest262Shaped(body: string): Promise<number> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // A leaked `env` import would mean the case ran on a JS-host fast path and the
  // answer is not the standalone substrate's.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

describe("#6651 SP1 — lazy §10.2.5 MakeConstructor for a first-class function value", () => {
  // THE FIX. Measured on reverted sources: 1 (only `typeof S === "function"`);
  // with the vivify: 63. Both spellings in one case: a plain string-keyed
  // expando and the symbol-keyed nesting the species rows actually use.
  it("§10.2.5 — an anonymous function expression in a property has a `prototype` OBJECT", async () => {
    expect(
      await runTest262Shaped(`
var o = {};
o.s = function (c) { return c; };
var sample = {};
sample.constructor = {};
sample.constructor[Symbol.species] = function (c) { return c; };
var S = sample.constructor[Symbol.species];
var b = 0;
if (typeof o.s === 'function') b |= 1;
if (typeof o.s.prototype === 'object') b |= 2;
if (o.s.prototype !== null && o.s.prototype !== undefined) b |= 4;
if (typeof S.prototype === 'object') b |= 8;
var inst = Object.create(S.prototype);
if (Object.getPrototypeOf(inst) === S.prototype) b |= 16;
if (inst instanceof S) b |= 32;
__r = b;
`),
    ).toBe(63);
  });

  // §7.3.20 through the #3981 construct driver. On reverted sources this was 21
  // (`prototype` undefined ⇒ `__object_create(null)` ⇒ instanceof false and the
  // proto identity false); with the vivify it is 119.
  it("§9.2.2 Construct on a first-class closure links `this` to the function's prototype", async () => {
    expect(
      await runTest262Shaped(`
var ran = 0;
var S0 = function (c) { ran = 1; };
var A = S0;
var b = 0;
if (typeof A === 'function') b |= 1;
if (typeof A.prototype === 'object') b |= 2;
var t; try { t = new A(2); } catch (e) { b |= 128; }
if (ran === 1) b |= 4;
if (t === null) b |= 8;
if (t !== null && t !== undefined && typeof t === 'object') b |= 16;
if (t instanceof A) b |= 32;
if (t !== null && t !== undefined && Object.getPrototypeOf(t) === A.prototype) b |= 64;
__r = b;
`),
    ).toBe(119);
  });

  // ── Negative controls: what the vivify must NOT reach ────────────────────
  //
  // The arm is gated on a `ref.test` against `ctx.constructibleClosureTypeIdxs`
  // (#3371) — the exact wrapper identities that implement [[Construct]]. An
  // arrow, a concise method and a bound function are absent from that set, so
  // §15.3's "an arrow has no `prototype`" holds BY CONSTRUCTION. Every bit here
  // must stay 0, on the base and after.

  it("§15.3 — an arrow, a concise method and a bound function get NO `prototype`", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
var arrow = (x) => x;
var meth = { m(x) { return x; } }.m;
function base() {}
var bound = base.bind({});
if (typeof arrow.prototype !== 'undefined') b |= 1;
if (typeof meth.prototype !== 'undefined') b |= 2;
if (typeof bound.prototype !== 'undefined') b |= 4;
if (arrow.hasOwnProperty('prototype')) b |= 8;
__r = b;
`),
    ).toBe(0);
  });

  it("an explicit `f.prototype = …` keeps precedence, and the vivified object is stable", async () => {
    // §7.3.20 step 5 requires a present-but-non-object `prototype` to stay
    // observable (a TypeError for `instanceof`), so the own-bag entry must keep
    // precedence over MakeConstructor: bits 1-2 are green on the base too. Bits
    // 4-32 are the vivify's own contract — ONE stable identity per closure, and
    // a later explicit write replaces it.
    expect(
      await runTest262Shaped(`
var u = {};
u.s = function (c) {};
u.s.prototype = undefined;
var o = {};
o.s = function (c) {};
var b = 0;
if (u.s.prototype === undefined) b |= 1;
if (typeof u.s.prototype !== 'object') b |= 2;
var p1 = o.s.prototype;
var p2 = o.s.prototype;
if (p1 === p2) b |= 4;
if (typeof p1 === 'object' && p1 !== null) b |= 8;
o.s.prototype = { tag: 5 };
if (o.s.prototype.tag === 5) b |= 16;
if (o.s.prototype !== p1) b |= 32;
__r = b;
`),
    ).toBe(63);
  });

  it("a NAMED fnctor keeps its compile-time prototype identity (the edge still wins)", async () => {
    // The #2660 M3 identity edge is consulted BEFORE the vivify, so a function
    // the compiler could name keeps the one object `new F()`, `F.prototype` and
    // the `constructor` back-ref all agree on. Green on the base too — this is
    // the guard that the vivify did not introduce a SECOND identity.
    expect(
      await runTest262Shaped(`
function F() {}
F.prototype.q = 7;
var t = new F();
var b = 0;
if (t.q === 7) b |= 1;
if (Object.getPrototypeOf(t) === F.prototype) b |= 2;
if (t instanceof F) b |= 4;
var K = F;
if (K.prototype === F.prototype) b |= 8;
if (t.constructor === F) b |= 16;
__r = b;
`),
    ).toBe(31);
  });

  // ── Residual pins: today's (spec-wrong) answers this slice did NOT close ──

  it("CLOSED by #6954 — `new` on a closure read out of a property constructs", async () => {
    // `new A(2)` where `A` came from `o.s` used to evaluate to **null** with
    // the body never run (answer 11 = 1|2|8). #6954 ended the standalone
    // dynamic-`new` chains in a runtime-function [[Construct]] arm, so the
    // body runs and the result is an object: 1|2|4 = 7, node's answer.
    expect(
      await runTest262Shaped(`
var ran = 0;
var o = {};
o.s = function (c) { ran = 1; };
var A = o.s;
var b = 0;
if (typeof A === 'function') b |= 1;
if (typeof A.prototype === 'object') b |= 2;
var t; try { t = new A(2); } catch (e) { b |= 128; }
if (ran === 1) b |= 4;
if (t === null) b |= 8;
__r = b;
`),
    ).toBe(7);
  });
});
