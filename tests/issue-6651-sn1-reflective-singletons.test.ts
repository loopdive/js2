// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane SN1 — three UNRELATED one-row ES2015 causes on `--target
// standalone`, batched under one control run because at this point in the
// edition the measurement overhead dominates each individual fix.
//
// THE THREE CAUSES (each standalone-only; all three rows already PASS on the
// host lane, measured — see the receipt in
// `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`):
//
//  1. §20.4.3.2/§20.4.3.3 — `Symbol.prototype.{valueOf,toString}` have native
//     standalone bodies (`symbol-proto-valueof.ts` #4776,
//     `symbol-proto-tostring.ts` #5269 B-c), but only the VALUE-ERASED spelling
//     reached them. The DIRECT `Symbol.prototype.toString.call(sym)` fell past
//     `tryEmitNativeProtoReflectiveCall`'s resolver — which enumerates
//     Number/Boolean/Promise one member at a time and had no `Symbol` arm — to
//     the #1888 Slice 3/4 borrowed-method tail, which refuse-louds and answers
//     `undefined`. One resolver arm, no new substrate.
//     Row: built-ins/Symbol/prototype/toString/toString.js
//
//  2. Annex B §B.2.2.1.1 — `__object_proto_get` re-applies the two
//     `$Object.$proto === null` encodings, but its implicit-`%Object.prototype%`
//     terminal `ref.test`s the receiver against the OPEN `$Object` carrier. A
//     receiver the compiler builds as a CLOSED WasmGC struct (an ordinary object
//     literal) fails that test, so `get.call({})` answered `null` while
//     `get.call(Object.create(proto))` and `get.call(Object.create(null))` were
//     both already right — the most obviously-ordinary shape was the one that
//     failed. Promote the literal receiver to the open carrier.
//     Row: built-ins/Object/prototype/__proto__/get-ordinary-obj.js
//
//  3. §20.4.2.6 step 1 — the #5269 A-6 static gate throws only for a
//     STATICALLY-proven non-symbol, and `ObjectConstructor` is declared
//     `(value: any): any`, so `Object(Symbol())` — a Symbol WRAPPER, the one
//     shape `keyFor` must reject while looking most symbol-like — read as
//     `"mixed"` and fell into the i32-id lane, answering `undefined`. §7.1.18
//     ToObject always answers an Object, so `Object(v)` is provably not a Symbol
//     for EVERY `v`: a spec fact about the callee, sound under a `mixed` operand
//     type.
//     Row: built-ins/Symbol/keyFor/arg-non-symbol.js
//
// MEASURED — `--target standalone`, authoritative lane
// (`tests/test262-shared.ts::runTest262Chunk`, `TEST262_PATH_FILTER_FILE`,
// `--isolate`, `TEST262_IT_TIMEOUT_MS=120000`, `COMPILER_POOL_SIZE=2`,
// shard-completion manifest 346/346 settled on both runs):
//   belt = every built-ins/Symbol + built-ins/Object/prototype row (346)
//   before 295 pass (bundle 18b8bb6b6ee8755f, adapter c6db7c5233bcf86c)
//   after  298 pass (bundle 16de438c6cf0216a, adapter d14510702e20fa46)
//   +3 gained, 0 LOST, 0 changed-but-still-not-pass
//   host belt (39 rows, built-ins/Symbol/{keyFor,prototype/toString,
//     prototype/valueOf} + built-ins/Object/prototype/__proto__):
//     33 pass before AND after — +0/−0. All three arms are `ctx.standalone`-
//     gated, and this pair is the measurement of that, not an assumption.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a test262-shaped module (loose, untyped, top-level statements) the way
 * the runner does — `skipSemanticDiagnostics` + `deferTopLevelInit` — and answer
 * the accumulated `__r` bitmask.
 *
 * The runner's option shape is load-bearing, not cosmetic: a probe that
 * annotates the operands takes a DIFFERENT lowering from the harness's, so every
 * assertion below keeps the verbatim test262 spelling.
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

describe("#6651 SN1 cause 1 — Symbol.prototype.{toString,valueOf} in their DIRECT reflective spelling", () => {
  // THE FIX. Measured on reverted sources: 0 (the direct `.call` answered
  // `undefined` for `toString` and a non-identical value for `valueOf`).
  it("§20.4.3.3 / §20.4.3.2 — Symbol.prototype.<m>.call(sym)", async () => {
    expect(
      await runTest262Shaped(`
var s = Symbol('66');
var b = 0;
if (Symbol.prototype.toString.call(s) === 'Symbol(66)') b |= 1;
if (Symbol.prototype.valueOf.call(s) === s) b |= 2;
if (Symbol.prototype.toString.call(Object(s)) === 'Symbol(66)') b |= 4;
if (Symbol.prototype.toString.call(Symbol()) === 'Symbol()') b |= 8;
__r = b;
`),
    ).toBe(15);
  });

  // The `thisSymbolValue` prologue must still reject a non-Symbol receiver. This
  // is the half that makes the arm a FIX rather than a silent-wrong answer: a
  // synthesised `recv.toString()` would have answered "[object Object]" here.
  it("thisSymbolValue rejects every non-Symbol receiver with a TypeError", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
try { Symbol.prototype.toString.call({}); } catch (e) { if (e instanceof TypeError) b |= 1; }
try { Symbol.prototype.toString.call(undefined); } catch (e) { if (e instanceof TypeError) b |= 2; }
try { Symbol.prototype.toString.call(1); } catch (e) { if (e instanceof TypeError) b |= 4; }
try { Symbol.prototype.toString.call('x'); } catch (e) { if (e instanceof TypeError) b |= 8; }
try { Symbol.prototype.valueOf.call({}); } catch (e) { if (e instanceof TypeError) b |= 16; }
__r = b;
`),
    ).toBe(31);
  });

  // NEGATIVE CONTROLS — the two spellings that ALREADY worked before this slice
  // and must keep working. `.apply` and the value-erased `var m = …` form reach
  // the native bodies by different routes, which is how the direct form's
  // failure was localised in the first place.
  it("the `.apply` and value-erased spellings are unchanged", async () => {
    expect(
      await runTest262Shaped(`
var s = Symbol('66');
var b = 0;
if (Symbol.prototype.toString.apply(s) === 'Symbol(66)') b |= 1;
var m = Symbol.prototype.toString;
if (m.call(s) === 'Symbol(66)') b |= 2;
if (s.toString() === 'Symbol(66)') b |= 4;
if (Object(s).toString() === 'Symbol(66)') b |= 8;
if (String(s) === 'Symbol(66)') b |= 16;
__r = b;
`),
    ).toBe(31);
  });

  // NEGATIVE CONTROL — the resolver arm is enumerated per member, so a member
  // with no native body must NOT be routed through it. `description` is an
  // accessor, not a method, and `Symbol.prototype[Symbol.toPrimitive]` is not
  // named by the arm; neither may start throwing.
  it("a Symbol.prototype member outside the arm keeps its existing answer", async () => {
    expect(
      await runTest262Shaped(`
var s = Symbol('d');
var b = 0;
if (s.description === 'd') b |= 1;
if (typeof Symbol.prototype.valueOf === 'function') b |= 2;
if (typeof Symbol.prototype.toString === 'function') b |= 4;
__r = b;
`),
    ).toBe(7);
  });
});

describe("#6651 SN1 cause 2 — Object.prototype.__proto__ getter on an ordinary object literal", () => {
  // THE FIX, verbatim from built-ins/Object/prototype/__proto__/get-ordinary-obj.js.
  // Measured on reverted sources: 6 (the two `Object.create` arms alone).
  it("§B.2.2.1.1 — get.call({}) is %Object.prototype%", async () => {
    expect(
      await runTest262Shaped(`
var get = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').get;
var proto = {};
var withCustomProto = Object.create(proto);
var withNullProto = Object.create(null);
var b = 0;
if (get.call({}) === Object.prototype) b |= 1;
if (get.call(withCustomProto) === proto) b |= 2;
if (get.call(withNullProto) === null) b |= 4;
__r = b;
`),
    ).toBe(7);
  });

  // NEGATIVE CONTROLS — the promotion is confined to this accessor's receiver
  // ARGUMENT. An array receiver and the two `Object.getPrototypeOf` folds must
  // keep the answers they already had.
  it("non-literal receivers are unchanged", async () => {
    expect(
      await runTest262Shaped(`
var d = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__');
var b = 0;
if (d.get.call([]) === Array.prototype) b |= 1;
if (Object.getPrototypeOf({}) === Object.prototype) b |= 2;
if (Object.getPrototypeOf(Object.create(null)) === null) b |= 4;
__r = b;
`),
    ).toBe(7);
  });

  // NEGATIVE CONTROL for the SET half, which this slice does not touch. Probed
  // on BOTH trees and byte-identical (58 both ways), which is the point: the
  // promotion block runs for `get` and `set` alike, so the set half needed a
  // measurement, not an argument. Note bit 4: after `d.set.call(target, proto)`
  // the INHERITED READ works (`target.tag === 1`) while
  // `Object.getPrototypeOf(target)` still answers `%Object.prototype%` — a
  // pre-existing liveness/identity split, not a regression from here.
  it("the setter half is byte-identical to base", async () => {
    expect(
      await runTest262Shaped(`
var d = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__');
var b = 0;
var proto = { tag: 1 };
var target = {};
d.set.call(target, proto);
if (target.tag === 1) b |= 1;
if (Object.getPrototypeOf(target) === proto) b |= 2;
if (Object.getPrototypeOf(target) === Object.prototype) b |= 4;
var t2 = {};
Object.setPrototypeOf(t2, proto);
if (Object.getPrototypeOf(t2) === proto) b |= 8;
if (t2.tag === 1) b |= 16;
__r = b;
`),
    ).toBe(29);
  });
});

describe("#6651 SN1 cause 3 — Symbol.keyFor rejects a provably-Object argument", () => {
  // THE FIX. Measured on reverted sources: the two `Object(...)` arms did not
  // throw (they answered `undefined`).
  it("§20.4.2.6 step 1 — Object(v) is never a Symbol", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
try { Symbol.keyFor(Object(Symbol('s'))); } catch (e) { if (e instanceof TypeError) b |= 1; }
var subject = Object(Symbol('s'));
try { Symbol.keyFor(subject); } catch (e) { if (e instanceof TypeError) b |= 2; }
try { Symbol.keyFor(Object(1)); } catch (e) { if (e instanceof TypeError) b |= 4; }
__r = b;
`),
    ).toBe(7);
  });

  // NEGATIVE CONTROLS — a REGISTERED symbol must still resolve, an unregistered
  // one must still answer `undefined`, and the pre-existing statically-proven
  // non-symbol throws must not have moved.
  it("the registry answers are unchanged", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
var k = Symbol.for('mykey');
if (Symbol.keyFor(k) === 'mykey') b |= 1;
if (Symbol.keyFor(Symbol.for('x')) === 'x') b |= 2;
if (Symbol.keyFor(Symbol('nope')) === undefined) b |= 4;
try { Symbol.keyFor(null); } catch (e) { if (e instanceof TypeError) b |= 8; }
try { Symbol.keyFor({}); } catch (e) { if (e instanceof TypeError) b |= 16; }
try { Symbol.keyFor([]); } catch (e) { if (e instanceof TypeError) b |= 32; }
__r = b;
`),
    ).toBe(63);
  });
});

describe("#6651 SN1 residual pins — TODAY'S answers, several of them spec-WRONG", () => {
  // Each expectation below is deliberately pinned to what the compiler answers
  // NOW, so a later lane that moves one of these boundaries trips an assertion
  // instead of moving it silently. Every one was probed on the committed tree.
  //
  // ALL of these are genuinely wrong per spec. They are NOT acceptance criteria;
  // they are tripwires with a named owner in the receipt.
  it("§B.2.2.1.1 — a ONE-HOP IDENTIFIER receiver still answers null", async () => {
    // Deliberately not fixed: the binding's declaration is already compiled by
    // the time the accessor arm runs, and `variables.ts`/`index.ts` pick the
    // slot type from the same `dynamicProtoLiteralNodes` set at declaration
    // time — so a mark added at the call site would make `literals.ts` build a
    // `$Object` against a closed-struct slot, i.e. invalid Wasm. That case
    // belongs to the `scanForDynamicProto` PRE-scan. Spec answer:
    // `Object.prototype`.
    expect(
      await runTest262Shaped(`
var get = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').get;
var p = { z: 1 };
__r = get.call(p) === null ? 1 : 0;
`),
    ).toBe(1);
  });

  it("§22.1.3 — String.prototype.indexOf OrdinaryToPrimitive residuals do not throw", async () => {
    // §7.1.1 OrdinaryToPrimitive must SKIP a non-callable `valueOf`/`toString`
    // and throw TypeError when neither is callable, and ToInteger of a Symbol
    // result is a TypeError. Neither happens. Worth 3 ES2015 rows
    // (built-ins/String/prototype/indexOf/{position-tointeger-errors,
    // position-tointeger-toprimitive,searchstring-tostring-toprimitive}.js) and
    // it is NOT a singleton fix: it is the shared numeric-coercion path, which
    // is also the `check-coercion-sites` gate's subject.
    expect(
      await runTest262Shaped(`
var b = 0;
try { "".indexOf("", { valueOf: function () { return Symbol('1'); } }); b |= 1; } catch (e) { b |= 2; }
try { "".indexOf({ valueOf: null, toString: null }); b |= 4; } catch (e) { b |= 8; }
__r = b;
`),
    ).toBe(5);
  });

  it("§7.3 — a builtin symbol-keyed getter read through a PARAMETER answers name 'get'", async () => {
    // `builtin-fn-meta.ts` already names the canonical species getter
    // `"get [Symbol.species]"`, and reading it off a STATIC receiver answers
    // that. Through a function PARAMETER the descriptor is synthesised at
    // runtime with an anonymous getter installed under the key `get`, so §17
    // NamedEvaluation names it `"get"`. Worth 1 ES2015 row
    // (built-ins/Symbol/species/builtin-getter-name.js) and it needs the runtime
    // gOPD to hand back the real singleton, not a fresh function.
    expect(
      await runTest262Shaped(`
function gn(obj) {
  var d = Object.getOwnPropertyDescriptor(obj, Symbol.species);
  return d && d.get && d.get.name;
}
var b = 0;
if (gn(Array) === 'get') b |= 1;
var d2 = Object.getOwnPropertyDescriptor(Array, Symbol.species);
var g2 = d2.get;
if (g2.name === 'get [Symbol.species]') b |= 2;
__r = b;
`),
    ).toBe(3);
  });

  it("§7.1.18 — a patched primitive-wrapper prototype method is not observed", async () => {
    // `Boolean.prototype.toString = fn` is invisible to `true.toString()` and to
    // §19.1.3.5 `Object.prototype.toLocaleString`'s `Invoke(O, "toString")`.
    // Worth 4 ES2015 rows (built-ins/{Object,Array}/prototype/toLocaleString/
    // primitive_this_value{,_getter}.js) and it is the KNOWN-HARD #2175
    // primitive-wrapper `[[Prototype]]` substrate, not a singleton — which is
    // exactly why this lane dropped it after measuring.
    expect(
      await runTest262Shaped(`
Boolean.prototype.toString = function () { return typeof this; };
var b = 0;
if (true.toString() === 'true') b |= 1;
if (true.toLocaleString() === 'true') b |= 2;
__r = b;
`),
    ).toBe(3);
  });
});
