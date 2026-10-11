// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane SY1 — the ES2015 × `Symbol` feature-tag bucket on
// `--target standalone`.
//
// ONE cause landed here, and the test file is deliberately wider than it: the
// negative controls below pin the boundary of what this slice did NOT change,
// because the bucket's other 26 standalone-only rows each turned out to be a
// DIFFERENT one-row cause (see the lane receipt in
// `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`).
//
// The cause: §7.1.18 (ToObject, Table 13) has FIVE primitive wrapper rows, and
// `emitObjectCoercion` (calls-guards.ts) grew its Symbol arm in slice I4 — but
// the `Object.assign` call site in `call-builtin-static.ts` kept a
// four-tag gate (`number | string | boolean | bigint`). §20.1.2.1 step 1 is
// `to = ToObject(target)` and the whole call's RESULT is that wrapper, so a
// statically-`symbol` target skipped ToObject and `__object_assign` (which only
// rejects a NULLISH target) handed the raw symbol straight back. One missing
// tag, not a missing mechanism.
//
// Measured, `--target standalone`, authoritative lane
// (`tests/test262-shared.ts::runTest262Chunk`, `TEST262_PATH_FILTER_FILE`,
// `--isolate`, `TEST262_IT_TIMEOUT_MS=420000`, pool 2, shard-completion
// manifest checked on every sweep):
//   ES2015 × `Symbol` bucket (60 not-pass rows): 0 -> 1 pass, +1 gained, 0 lost
//   control (177 rows: every built-ins/Object/{assign,entries,values} and
//     every built-ins/Symbol): 124 -> 125 pass, +1 gained, 0 lost
//   same control on the HOST lane:               138 -> 138 pass, +0, -0
// The gate is `ctx.standalone`-guarded, so host is untouched by construction —
// and the host control run above is the measurement of that, not an assumption.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a test262-shaped module (loose, untyped, top-level statements) the way
 * the runner does — `skipSemanticDiagnostics` + `deferTopLevelInit` — and answer
 * the accumulated `__r` bitmask.
 *
 * The runner's option shape is load-bearing here, not cosmetic: a hand-written
 * probe that annotates the operands (`const s: any = Symbol("d")`) takes a
 * DIFFERENT lowering from the one the harness generates, and went green on a
 * case the real row fails. Every assertion below therefore keeps the verbatim
 * test262 spelling.
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

describe("#6651 SY1 — Object.assign performs ToObject on a Symbol target", () => {
  // THE FIX. Both bits are RED on reverted sources (measured: 2, i.e. the
  // `toString()` bit alone), GREEN with it (3).
  it("§20.1.2.1 step 1 boxes a Symbol target — built-ins/Object/assign/Target-Symbol.js", async () => {
    expect(
      await runTest262Shaped(`
var target = Symbol('foo');
var result = Object.assign(target, { a: 1 });
var b = 0;
if (typeof result === 'object') b |= 1;
if (result.toString() === 'Symbol(foo)') b |= 2;
__r = b;
`),
    ).toBe(3);
  });

  // The four tags that were ALREADY in the gate. These are the regression
  // guard for widening it: a fifth arm must not perturb the other four.
  it("the other four Table 13 wrapper rows still box [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
if (typeof Object.assign(1, { a: 1 }) === 'object') b |= 1;
if (typeof Object.assign('s', { a: 1 }) === 'object') b |= 2;
if (typeof Object.assign(true, { a: 1 }) === 'object') b |= 4;
var o = { x: 1 };
if (Object.assign(o, { a: 1 }) === o) b |= 8;
__r = b;
`),
    ).toBe(15);
  });

  // ── Negative controls ────────────────────────────────────────────────────
  //
  // These LOCK the residual this slice deliberately left open. They assert the
  // CURRENT (spec-wrong) answer, so that a future lane closing one of them sees
  // a failing assertion here rather than silently moving a boundary nobody
  // recorded. Each is a separate, independently measured one-row cause.

  it("NEGATIVE CONTROL — a primitive wrapper's [[Prototype]] is Object.prototype, for EVERY wrapper", async () => {
    // `built-ins/Symbol/constructor.js` wants
    // `Object.getPrototypeOf(Object(Symbol('66'))).constructor === Symbol`.
    // Deliberately NOT fixed here: the gap is not Symbol-specific — the
    // String and Number wrappers answer `Object.prototype` too, so this is one
    // general wrapper-prototype cause in the #2175 proto-index store (see the
    // H5 receipt's "proto-member dirty" arming note), not Symbol work.
    expect(
      await runTest262Shaped(`
var b = 0;
if (Object.getPrototypeOf(Object(Symbol('d'))) === Object.prototype) b |= 1;
if (Object.getPrototypeOf(Object('s')) === Object.prototype) b |= 2;
if (Object.getPrototypeOf(Object(1)) === Object.prototype) b |= 4;
__r = b;
`),
    ).toBe(7);
  });

  it("NEGATIVE CONTROL — ToPrimitive on a Symbol wrapper does not unbox to its [[SymbolData]]", async () => {
    // `built-ins/String/prototype/indexOf/searchstring-tostring-errors.js`
    // assertion 2 wants `"".indexOf(Object(Symbol('1')))` to throw TypeError
    // (ToPrimitive → symbol → ToString throws). `Symbol.keyFor(Object(sym))`
    // (`built-ins/Symbol/keyFor/arg-non-symbol.js`) is the same slot from the
    // other side: TS types `Object(sym)` as `symbol`, so the static-tag guard in
    // `call-namespace-static.ts` sees a symbol and coerces the wrapper externref
    // into the i32 id lane instead of throwing.
    expect(
      await runTest262Shaped(`
function thr(fn) { try { fn(); } catch (e) { return e instanceof TypeError ? 1 : 2; } return 0; }
var b = 0;
if (thr(function () { ''.indexOf(Object(Symbol('1'))); }) === 0) b |= 1;
if (thr(function () { Symbol.keyFor(Object(Symbol('x'))); }) === 0) b |= 2;
// The PRIMITIVE-symbol spellings of the same two operations DO throw today —
// this half must stay green whatever closes the half above.
if (thr(function () { ''.indexOf(Symbol('1')); }) === 1) b |= 4;
if (thr(function () { Symbol.keyFor(''); }) === 1) b |= 8;
__r = b;
`),
    ).toBe(15);
  });

  it("NEGATIVE CONTROL — Object.entries loses a symbol VALUE's identity once the object is descriptor-backed", async () => {
    // `built-ins/Object/entries/symbols-omitted.js` dies at
    // `assert.sameValue(result[0][1], symValue)`. Isolated to a single trigger:
    // ANY `Object.defineProperty` on the carrier (a symbol KEY is not required —
    // a string-keyed one does it too). Before the defineProperty the identity
    // holds; after it, `Object.entries` answers a symbol whose description is
    // gone (`String(...)` reads `Symbol()`), while the direct read
    // `obj.key`, `Object.values(obj)[0]` and
    // `Object.getOwnPropertyDescriptor(obj, 'key').value` all still compare
    // equal. Left open: the mis-boxing is downstream of `__object_entries`
    // (which pushes `$PropEntry.value` unmodified), and finding it needs more
    // than this slice's budget.
    expect(
      await runTest262Shaped(`
var symValue = Symbol('value');
var obj = { key: symValue };
Object.defineProperty(obj, 'other', { enumerable: false, value: {} });
var r = Object.entries(obj);
var b = 0;
if (r.length === 1) b |= 1;
if (obj.key === symValue) b |= 2;
if (Object.values(obj)[0] === symValue) b |= 4;
if (Object.getOwnPropertyDescriptor(obj, 'key').value === symValue) b |= 8;
if (r[0][1] !== symValue) b |= 16;            // the defect
if (String(r[0][1]) === 'Symbol()') b |= 32;  // description dropped
__r = b;
`),
    ).toBe(63);
  });

  it("NEGATIVE CONTROL — a Symbol primitive is not callable, but `new <symbol wrapper>()` still is", async () => {
    // `built-ins/Symbol/not-callable.js` needs all four to throw. Two of the
    // four already do; `sym()` and `new symObj()` do not. Not fixed here — it
    // is IsCallable/Construct on a `[[PrimitiveValue]]` carrier, a different
    // mechanism from ToObject.
    expect(
      await runTest262Shaped(`
function thr(fn) { try { fn(); } catch (e) { return e instanceof TypeError ? 1 : 2; } return 0; }
var sym = Symbol('desc');
var symObj = Object(Symbol());
var b = 0;
if (thr(function () { sym(); }) !== 1) b |= 1;        // defect
if (thr(function () { new sym(); }) === 1) b |= 2;
if (thr(function () { symObj(); }) === 1) b |= 4;
if (thr(function () { new symObj(); }) !== 1) b |= 8;  // defect
__r = b;
`),
    ).toBe(15);
  });
});
