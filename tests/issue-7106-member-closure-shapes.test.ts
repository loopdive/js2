// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 (M4) — two member-closure shapes of the test262 harness:
//   - a THROW-ONLY body (sta.js's `Test262Error.thrower = function (message)
//     { throw … }`): the oracle return is `never` (reported unresolvable) and
//     legacy registers it with no result, so it takes the void plan;
//   - a conditional VALUE joining a dynamic parameter with a literal
//     (assert.compareArray's `message = message === undefined ? '' : message`).
// Both initializers are prepared IR bodies and agree with node.
//
// (#7113 review) The refusal rows pin the selector's side of the contract:
// the shapes the producer cannot lower are refused at select, with no
// post-claim withdrawal, on standalone and on gc native-first alike. Since
// round 11 the operator, write, `??`, `null` / `void`, `throw`, store and
// `switch` refusals come from the #7144 closure walk over the shared
// predicates (`operand-coercion-unsupported`); the representation rules that
// carry no operand family stay shape refusals (`body-shape-rejected`).

import { WASI } from "node:wasi";
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm, wrapCompiledExports } from "../src/runtime.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function requirePreparedInit(result: CompileResult): void {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    preparedComponentId: expect.any(String),
  });
}

async function initializeAndRun(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

describe("#7106 Stage 4 — harness member-closure shapes", () => {
  it("plans a throw-only member closure as void", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.thrower = function (message) { throw message; };
export function run() {
  var n = 0;
  try { subject.thrower("x"); } catch (e) { if (e === "x") n += 1; }
  try { subject.thrower(); } catch (e) { if (e === undefined) n += 10; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect(node(source)).toBe(11);
    expect(await initializeAndRun(result)).toBe(11);
  }, 35_000);

  it("joins a dynamic parameter and a literal in a conditional value", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.cmp = function (actual, expected, message) {
  message = message === undefined ? '' : message;
  if (actual === expected) return;
  throw message;
};
subject.pick = function (value, fallback) {
  var chosen = value ? value : 7;
  throw chosen;
};
export function run() {
  var n = 0;
  try { subject.cmp(1, 2); } catch (e) { if (e === "") n += 10; }
  try { subject.cmp(1, 2, "m"); } catch (e) { if (e === "m") n += 100; }
  try { subject.cmp(1, 1, "m"); n += 1000; } catch (e) { n += 5; }
  try { subject.pick(0); } catch (e) { if (e === 7) n += 10000; }
  try { subject.pick("v"); } catch (e) { if (e === "v") n += 100000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    // (`run` itself demotes on a pre-existing `e === "m"` string/dynamic compare.)
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(111110);
    expect(await initializeAndRun(result)).toBe(111110);
  }, 35_000);

  // The sink rule is one predicate for the conditional and for a local read:
  // the conditional is admitted into a dynamic-shaped local (`var r;` is the
  // carrier's undefined, `var r = m` is the parameter's carrier) exactly where
  // a dynamic read into that local is.
  it("admits the conditional into a dynamic-shaped local", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m) { var r; r = m ? m : 1; throw r; };
subject.b = function (m) { var r = m; r = m ? m : 2; throw r; };
export function run() {
  var n = 0;
  try { subject.a(0); } catch (e) { if (e === 1) n += 1; }
  try { subject.a("x"); } catch (e) { if (e === "x") n += 10; }
  try { subject.b(0); } catch (e) { if (e === 2) n += 100; }
  try { subject.b("y"); } catch (e) { if (e === "y") n += 1000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(1111);
    expect(await initializeAndRun(result)).toBe(1111);
  }, 35_000);

  // `+=` is the one compound write that lowers with a dynamic RHS (the dynamic
  // add); it is admitted into a dynamic slot, refused into a concrete one.
  it("admits `+=` into a dynamic slot (dynamic, literal and undefined right-hand sides)", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m) { var r = m ? m : 1; m += r; throw m; };
subject.b = function (m) { var r = m ? m : 1; var s; s += r; throw s; };
subject.c = function (m) { var r = m ? m : 1; r += 1; throw r; };
subject.d = function (m) { var r = m ? m : 1; r += undefined; throw r; };
export function run() {
  var n = 0;
  try { subject.a(3); } catch (e) { if (e === 6) n += 1; }
  try { subject.a(0); } catch (e) { if (e === 1) n += 10; }
  try { subject.a("a"); } catch (e) { if (e === "aa") n += 100; }
  try { subject.b("z"); } catch (e) { if (e === "undefinedz") n += 1000; }
  try { subject.c(2); } catch (e) { if (e === 3) n += 10000; }
  try { subject.c("a"); } catch (e) { if (e === "a1") n += 100000; }
  try { subject.d(1); } catch (e) { if (e !== e) n += 1000000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(1111111);
    expect(await initializeAndRun(result)).toBe(1111111);
  }, 35_000);

  // The value positions from-ast materialises a bare `null` in: a `throw`
  // operand (externref hint, also through a comma's right operand) and the
  // direct operand of an equality it folds (strict against a dynamic value or the
  // catch binding; any against a numeric operand).
  it("admits null as a throw operand and as a folded equality operand", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m) { var r = m ? m : 1; if (r === 1) throw null; throw r; };
subject.b = function (m) { var r = m ? m : 1; if (r === null) throw "n"; if (r !== null) throw r; };
subject.c = function (m) { var r = m ? m : 1; var q = 5; if (q === null) throw "n"; throw r; };
subject.d = function (m) { var r = m ? m : 1; try { throw r; } catch (e) { if (e === null) throw "n"; throw e; } };
subject.e = function (m) { var r = m ? m : 1; if (r === 1) throw (1, null); throw r; };
export function run() {
  var n = 0;
  try { subject.a(0); } catch (e) { if (e === null) n += 1; }
  try { subject.a("x"); } catch (e) { if (e === "x") n += 10; }
  try { subject.b(0); } catch (e) { if (e === 1) n += 100; }
  try { subject.b("y"); } catch (e) { if (e === "y") n += 1000; }
  try { subject.c(0); } catch (e) { if (e === 1) n += 10000; }
  try { subject.d(0); } catch (e) { if (e === 1) n += 100000; }
  try { subject.e(0); } catch (e) { if (e === null) n += 1000000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(1111111);
    expect(await initializeAndRun(result)).toBe(1111111);
  }, 35_000);

  // A discarded `null` — an expression statement, a comma's left operand, a
  // `void` operand, a discarded conditional arm — is lowered by
  // `lowerDiscardedExpression` under an externref hint (no minted local needed).
  it("admits null in a discarded position", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m, k) { null; throw m; };
subject.b = function (m, k) { (1, null); throw m; };
subject.c = function (m, k) { throw (null, m); };
subject.d = function (m, k) { void null; throw m; };
subject.e = function (m, k) { k ? null : 1; throw m; };
export function run() {
  var n = 0;
  try { subject.a(2, 0); } catch (e) { if (e === 2) n += 1; }
  try { subject.b(2, 0); } catch (e) { if (e === 2) n += 10; }
  try { subject.c(2, 0); } catch (e) { if (e === 2) n += 100; }
  try { subject.d(2, 0); } catch (e) { if (e === 2) n += 1000; }
  try { subject.e(2, 1); } catch (e) { if (e === 2) n += 10000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(11111);
    expect(await initializeAndRun(result)).toBe(11111);
  }, 35_000);

  // A value-position `void` discards its operand (from-ast lowers the `null`
  // through `lowerDiscardedExpression`, then yields an f64 NaN), so a `null`
  // under it is never the failing node, wherever the `void` sits.
  it("admits null under a value-position void", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m, k) { if (void null) throw "n"; throw m; };
subject.b = function (m, k) { while (void null) { k = 0; } throw m; };
subject.c = function (m, k) { var t = (void null) ? 1 : 2; if (t === 2) throw m; throw "n"; };
subject.d = function (m, k) { if (!(void null)) throw m; throw "n"; };
subject.e = function (m, k) { if (void null === null) throw "n"; throw m; };
export function run() {
  var n = 0;
  try { subject.a(2, 0); } catch (e) { if (e === 2) n += 1; }
  try { subject.b(2, 0); } catch (e) { if (e === 2) n += 10; }
  try { subject.c(2, 0); } catch (e) { if (e === 2) n += 100; }
  try { subject.d(2, 0); } catch (e) { if (e === 2) n += 1000; }
  try { subject.e(2, 0); } catch (e) { if (e === 2) n += 10000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(11111);
    expect(await initializeAndRun(result)).toBe(11111);
  }, 35_000);

  // A closure that mints the dynamic local is admitted when every value it
  // represents is in the family set: a numeric array and its alias, a string
  // ToNumber'd by unary `-`, literals and reads written into the dynamic slot.
  it("admits a minting closure whose values are all in the lowerable families", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m, k) { var r = m ? m : 1; var a = [1, 2]; var b = a; if (b === null) throw "n"; throw r; };
subject.b = function (m, k) { var r = m ? m : 1; var s = "3"; var t = -s; if (t === -3) throw r; throw "n"; };
subject.c = function (m, k) { var r = m ? m : 1; r = "s"; throw r; };
subject.d = function (m, k) { var r = m ? m : 1; var q = 1; q += 2; if (q === 3) throw r; throw "n"; };
export function run() {
  var n = 0;
  try { subject.a(2, 0); } catch (e) { if (e === 2) n += 1; }
  try { subject.b(0, 0); } catch (e) { if (e === 1) n += 10; }
  try { subject.c(2, 0); } catch (e) { if (e === "s") n += 100; }
  try { subject.d(2, 0); } catch (e) { if (e === 2) n += 1000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(1111);
    expect(await initializeAndRun(result)).toBe(1111);
  }, 35_000);

  // Each row is a planned member closure whose body the producer would
  // withdraw after the claim; the selector refuses it first. `node` is the
  // oracle for the legacy body that then runs.
  const REFUSED: readonly [name: string, body: string, calls: string, reason: string, expected: number][] = [
    [
      "throw of a numeric literal in a throw-only body (void plan)",
      `function (message) { throw 42; }`,
      `try { subject.f(0); } catch (e) { if (e === 42) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "throw of a numeric literal after a conditional throw",
      `function (message) { if (message) { throw message; } throw 1; }`,
      `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("y"); } catch (e) { if (e === "y") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "dynamic-arm conditional flowing into a typed slot",
      `function (m, k) { if (k === 9) return; var n = 5; n = m ? m : 1; throw n; }`,
      `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "dynamic-arm conditional laundered through an untyped local into a typed slot",
      `function (m) { var r = m ? m : 1; var s = "a"; s = r; throw s; }`,
      `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("x"); } catch (e) { if (e === "x") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "dynamic-arm conditional laundered through an untyped local into a string `+=` slot",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s = "a"; s += r; throw s; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === "a1") n += 1; } try { subject.f("x", 0); } catch (e) { if (e === "ax") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "dynamic-arm conditional laundered into a string `+=` slot in a throw-only body",
      `function (m) { var r = m ? m : 1; var s = "a"; s += r; throw s; }`,
      `try { subject.f(0); } catch (e) { if (e === "a1") n += 1; } try { subject.f("x"); } catch (e) { if (e === "ax") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "numeric compound `-=` of a dynamic-shaped local into the dynamic parameter",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; m -= r; throw m; }`,
      `try { subject.f(5, 0); } catch (e) { if (e === 0) n += 1; } try { subject.f(0, 0); } catch (e) { if (e === -1) n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "numeric compound `-=` of a dynamic-shaped local into an uninitialized local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s; s -= r; throw s; }`,
      `try { subject.f(5, 0); } catch (e) { if (e !== e) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "numeric compound `-=` of a literal into the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; r -= 1; throw r; }`,
      `try { subject.f(5, 0); } catch (e) { if (e === 4) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "numeric compound `-=` of a literal into the dynamic parameter beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; m -= 1; throw r; }`,
      `try { subject.f(5, 0); } catch (e) { if (e === 5) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`+=` of a bare null into the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; r += null; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`=` of a bare null into the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; r = null; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === null) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`+=` of a null behind `??` into the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; r += null ?? 1; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 2) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "loose `==` of the minted dynamic local against null",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r == null) throw "n"; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "strict equality of a string local against null beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s = "a"; if (s === null) throw "n"; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`null === undefined` beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (null === undefined) throw "n"; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "a null-initialized local beside the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var nul = null; r += nul; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "strict equality of an object-literal local against null beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o = { a: 1 }; if (o === null) throw "n"; throw r; }`,
      `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "loose `==` of a dynamic member read against null beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (m.x == null) throw "n"; throw r; }`,
      `try { subject.f({ x: 1 }, 0); } catch (e) { if (e !== "n") n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`??` with the minted dynamic local on the left",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var t = r ?? 1; throw t; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "an object-literal local behind an alias compared with null beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o = { a: 1 }; var p = o; if (p === null) throw "n"; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "an object-valued property compared with null beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o = { a: { b: 1 } }; if (o.a === null) throw "n"; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "an array literal of objects beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o = [{ a: 1 }]; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "an object literal written into an uninitialized local beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o; o = { a: 1 }; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "unary `-` of an object local beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var o = { a: 1 }; var t = -o; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "`??` on a member read of the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var t = r.x ?? 1; throw t; }`,
      `try { subject.f({ x: 2 }, 0); } catch (e) { if (e === 2) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "`??` on a string local beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s = "a"; var t = s ?? "b"; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "a dynamic sum written into a string slot beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s = "a"; s = r + 1; throw s; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 3) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "a write into a const local beside the minted local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; const s = m; s = r; throw s; }`,
      `try { subject.f(2, 0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "`+=` of a numeric array into the minted dynamic local",
      `function (m, k) { if (k === 9) return; var r = m ? m : 1; var a = [4]; r += a; throw r; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === "24") n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "throw of `void 0`",
      `function (m, k) { if (k === 9) return; throw void 0; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === undefined) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "throw of `void null`",
      `function (m, k) { if (k === 9) return; throw void null; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === undefined) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "a value `void` as a declaration initializer",
      `function (m, k) { if (k === 9) return; var t = void null; throw m; }`,
      `try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "a chained write of the dynamic parameter into a string slot",
      `function (m) { var s = "a"; var r; s = r = m; throw s; }`,
      `try { subject.f("x"); } catch (e) { if (e === "x") n += 1; }`,
      "operand-coercion-unsupported",
      1,
    ],
    [
      "dynamic parameter joined with undefined",
      `function (m, k) { if (k === 9) return; var r = m ? m : undefined; throw r; }`,
      `try { subject.f(0); } catch (e) { if (e === undefined) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
  ];

  it.each(REFUSED)(
    "refuses at select, without a post-claim withdrawal: %s",
    async (_name, body, calls, reason, expected) => {
      const source = `/** @returns {number} */ function subject() { return 0; }
subject.f = ${body};
export function run() { var n = 0; ${calls} return n; }`;
      expect(node(source)).toBe(expected);
      for (const lane of [{ target: "standalone" }, { target: "gc" }] as const) {
        const result = await compile(source, { ...OPTIONS, ...lane });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
        expect(rows, JSON.stringify(lane)).toHaveLength(1);
        expect(rows[0], JSON.stringify(lane)).toMatchObject({
          irBodyEmitted: false,
          legacyBodyEmitted: true,
          stage: "select",
          code: reason,
        });
        expect(
          (result.irPostClaimErrors ?? []).filter((error) => error.func !== "run"),
          JSON.stringify(lane),
        ).toEqual([]);
        if (lane.target === "standalone") expect(await initializeAndRun(result)).toBe(expected);
      }
    },
    60_000,
  );

  // (#7113 round 11) The rules below are the shared predicates of
  // `src/ir/analysis/operand-admissibility.ts`, read by the selector's closure
  // walk and by from-ast alike.
  it("joins a dynamic parameter and a value `void` on the carrier's real undefined", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m, k) { var r = k ? m : void 0; if (typeof r === "undefined") throw "u"; throw r; };
subject.b = function (m) { var r = m ? void 0 : m; if (r === undefined) throw "v"; throw r; };
subject.c = function (m, k) { throw k ? m : void 0; };
export function run() {
  var n = 0;
  try { subject.a(2, 0); } catch (e) { if (e === "u") n += 1; }
  try { subject.a(2, 1); } catch (e) { if (e === 2) n += 10; }
  try { subject.b(3); } catch (e) { if (e === "v") n += 100; }
  try { subject.b(0); } catch (e) { if (e === 0) n += 1000; }
  try { subject.c(4, 0); } catch (e) { if (e === undefined) n += 10000; }
  return n;
}`;
    expect(node(source)).toBe(11111);
    for (const lane of [{ target: "standalone" }, { target: "gc" }] as const) {
      const result = await compile(source, { ...OPTIONS, ...lane });
      requirePreparedInit(result);
      expect((result.irPostClaimErrors ?? []).filter((error) => error.func !== "run")).toEqual([]);
      if (lane.target === "standalone") expect(await initializeAndRun(result)).toBe(11111);
    }
  }, 35_000);

  it("admits a dynamic or string throw operand in a member closure", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.a = function (m) { throw m; };
subject.b = function (m, k) { throw "s" + k; };
subject.c = function (m) { var r = m ? m : "z"; throw r; };
export function run() {
  var n = 0;
  try { subject.a("x"); } catch (e) { if (e === "x") n += 1; }
  try { subject.b(0, 7); } catch (e) { if (e === "s7") n += 10; }
  try { subject.c(0); } catch (e) { if (e === "z") n += 100; }
  return n;
}`;
    expect(node(source)).toBe(111);
    for (const lane of [{ target: "standalone" }, { target: "gc" }] as const) {
      const result = await compile(source, { ...OPTIONS, ...lane });
      requirePreparedInit(result);
      expect((result.irPostClaimErrors ?? []).filter((error) => error.func !== "run")).toEqual([]);
      if (lane.target === "standalone") expect(await initializeAndRun(result)).toBe(111);
    }
  }, 35_000);

  const CARRIER_REFUSED: readonly [name: string, body: string, calls: string, expected: number][] = [
    [
      "a loose `==` on the minted carrier local",
      `function (m) { var r = m ? m : 1; if (r == 2) throw "e"; throw r; }`,
      `try { subject.f(2); } catch (e) { if (e === "e") n += 1; }`,
      1,
    ],
    [
      "a loose `!=` on the dynamic parameter",
      `function (m) { if (m != "2") throw "e"; throw m; }`,
      `try { subject.f(2); } catch (e) { if (e === 2) n += 1; }`,
      1,
    ],
    [
      "`in` on the dynamic parameter",
      `function (m) { if ("a" in m) throw "i"; throw m; }`,
      `try { subject.f({ a: 1 }); } catch (e) { if (e === "i") n += 1; }`,
      1,
    ],
    [
      "a regex literal",
      `function (m) { var re = /a/; throw m; }`,
      `try { subject.f(2); } catch (e) { if (e === 2) n += 1; }`,
      1,
    ],
    [
      "a property store on the minted carrier local",
      `function (m) { var r = m ? m : 1; r.x = 1; throw r; }`,
      `try { subject.f({}); } catch (e) { if (e.x === 1) n += 1; }`,
      1,
    ],
    [
      "an element store on the dynamic parameter",
      `function (m, k) { k[0] = m; throw m; }`,
      `try { subject.f(2, []); } catch (e) { if (e === 2) n += 1; }`,
      1,
    ],
    [
      "a switch on the minted carrier local",
      `function (m) { var r = m ? m : 1; switch (r) { case 2: throw "two"; } throw r; }`,
      `try { subject.f(2); } catch (e) { if (e === "two") n += 1; }`,
      1,
    ],
  ];

  it.each(CARRIER_REFUSED)(
    "refuses on the carrier at select, without a post-claim withdrawal: %s",
    async (_name, body, calls, expected) => {
      const source = `/** @returns {number} */ function subject() { return 0; }
subject.f = ${body};
export function run() { var n = 0; ${calls} return n; }`;
      expect(node(source)).toBe(expected);
      for (const lane of [{ target: "standalone" }, { target: "gc" }] as const) {
        const result = await compile(source, { ...OPTIONS, ...lane });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
        expect(rows, JSON.stringify(lane)).toHaveLength(1);
        expect(rows[0], JSON.stringify(lane)).toMatchObject({
          irBodyEmitted: false,
          legacyBodyEmitted: true,
          stage: "select",
        });
        // The walk's refusal, or an earlier shape refusal on a lane that has one.
        expect(["operand-coercion-unsupported", "body-shape-rejected"]).toContain(rows[0]?.code);
        expect(
          (result.irPostClaimErrors ?? []).filter((error) => error.func !== "run"),
          JSON.stringify(lane),
        ).toEqual([]);
        if (lane.target === "standalone") expect(await initializeAndRun(result)).toBe(expected);
      }
    },
    60_000,
  );

  // (#7113 round 12) Every lane, executed, with array and string inputs.
  type Lane = "standalone" | "wasi" | "gc";
  const ALL_LANES: readonly Lane[] = ["standalone", "wasi", "gc"];

  async function runOnLane(result: CompileResult, lane: Lane): Promise<number> {
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (lane === "gc") {
      const runtime = buildImports(result.imports ?? [], undefined, result.stringPool);
      const { instance } = await instantiateWasm(
        result.binary,
        runtime.env,
        runtime.string_constants,
        runtime.string_constants16,
      );
      runtime.setInstance?.(instance);
      (instance.exports.__module_init as (() => void) | undefined)?.();
      const exports = wrapCompiledExports(result, instance) as { run: () => number };
      return exports.run();
    }
    const wasi = lane === "wasi" ? new WASI({ version: "preview1", args: [], env: {} }) : undefined;
    const module = await WebAssembly.compile(result.binary);
    const instance = await WebAssembly.instantiate(module, (wasi?.getImportObject() ?? {}) as WebAssembly.Imports);
    if (wasi) {
      try {
        wasi.initialize(instance);
      } catch {
        // A module without `_initialize` needs no WASI start-up.
      }
    }
    (instance.exports.__module_init as (() => void) | undefined)?.();
    return (instance.exports.run as () => number)();
  }

  function initRow(result: CompileResult) {
    const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
    expect(rows).toHaveLength(1);
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func !== "run")).toEqual([]);
    return rows[0]!;
  }

  const ENCODE = `(typeof e === "number" ? e : typeof e === "string" ? 100 + e.length : e === undefined ? -3 : -2)`;
  const program = (body: string, inputs: readonly string[], pre = "") =>
    `${pre}/** @returns {number} */ function subject() { return 0; }
subject.f = function (m, k) { if (k === 9) return; ${body} };
export function run() { var n = 0; ${inputs
      .map((args) => `try { subject.f(${args}); n = n * 31 + 7; } catch (e) { n = n * 31 + ${ENCODE}; }`)
      .join(" ")} return n; }`;

  const ARRAYS = [`[1, 2], 0`, `[7, 8, 9], 0`, `0, 0`];
  const STRINGS = [`"ab", 0`, `"xyz", 0`, `0, 0`];

  it("reads `.length` of the joined carrier on standalone and gc, and falls back to legacy on wasi (#7177)", async () => {
    for (const inputs of [ARRAYS, STRINGS]) {
      const source = program(`var r = m ? m : 1; throw r.length;`, inputs);
      for (const lane of ALL_LANES) {
        const result = await compile(source, { ...OPTIONS, target: lane });
        const row = initRow(result);
        if (lane === "wasi") {
          expect(row).toMatchObject({ irBodyEmitted: false, stage: "select", code: "operand-coercion-unsupported" });
          // Legacy wasi reads a string's `.length` wrong as well (#7177); arrays agree with node.
          if (inputs === ARRAYS) expect(await runOnLane(result, lane)).toBe(node(source));
        } else {
          expect(row).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
          expect(await runOnLane(result, lane)).toBe(node(source));
        }
      }
    }
  }, 90_000);

  it.each([
    ["of the joined carrier", `var r = m ? m : 1; throw r[1];`, [...ARRAYS, ...STRINGS]],
    // `m[k]` on a null receiver must throw; the IR element read answers a value.
    [
      "of the parameter beside a joined carrier",
      `var r = m ? m : 1; var t = m[k]; throw r;`,
      [`null, 0`, `[1, 2], 0`, `"ab", 1`],
    ],
  ])(
    "refuses an element read %s at select on every lane",
    async (_name, body, inputs) => {
      const source = program(body, inputs);
      for (const lane of ALL_LANES) {
        const result = await compile(source, { ...OPTIONS, target: lane });
        expect(initRow(result)).toMatchObject({
          irBodyEmitted: false,
          stage: "select",
          code: "operand-coercion-unsupported",
        });
        if (lane !== "wasi") expect(await runOnLane(result, lane)).toBe(node(source));
      }
    },
    90_000,
  );

  it("keeps carrier method calls and wasi `.length` out of a throw-only closure", async () => {
    // A throw-only body is a shape this PR newly plans (#7177): `m.g()` on null must throw (legacy
    // answers an array wrong too, so that input is left to #7177).
    const call = program(`if (m.g() === null) throw "n"; throw m;`, [
      `null, 0`,
      `{ g: function () { return 1; } }, 0`,
    ]).replace("if (k === 9) return; ", "");
    const length = program(`throw m.length;`, [...ARRAYS, ...STRINGS]).replace("if (k === 9) return; ", "");
    for (const lane of ALL_LANES) {
      const refused = await compile(call, { ...OPTIONS, target: lane });
      expect(initRow(refused)).toMatchObject({ irBodyEmitted: false, stage: "select" });
      if (lane !== "wasi") expect(await runOnLane(refused, lane)).toBe(node(call));
      const read = await compile(length, { ...OPTIONS, target: lane });
      expect(initRow(read).irBodyEmitted).toBe(lane !== "wasi");
      if (lane !== "wasi") expect(await runOnLane(read, lane)).toBe(node(length));
    }
  }, 90_000);

  it("refuses `String(<carrier>)` at select on standalone and gc", async () => {
    const source = program(`var r = m ? m : 1; throw String(r);`, [...ARRAYS, ...STRINGS]);
    for (const lane of ["standalone", "gc"] as const) {
      const result = await compile(source, { ...OPTIONS, target: lane });
      expect(initRow(result)).toMatchObject({
        irBodyEmitted: false,
        stage: "select",
        code: "operand-coercion-unsupported",
      });
      expect(await runOnLane(result, lane)).toBe(node(source));
    }
  }, 60_000);

  it("refuses a direct call to a module function on wasi only", async () => {
    const source = program(`var r = m ? m : 1; subject(); throw r;`, [...ARRAYS, ...STRINGS]);
    for (const lane of ALL_LANES) {
      const result = await compile(source, { ...OPTIONS, target: lane });
      expect(initRow(result).irBodyEmitted).toBe(lane !== "wasi");
      expect(await runOnLane(result, lane)).toBe(node(source));
    }
  }, 60_000);

  it("does not read a module-shadowed `undefined` as the global", async () => {
    const source = program(
      `var r = m ? m : 1; r += undefined; throw r;`,
      ARRAYS,
      `function undefined() { return 1; }\n`,
    );
    for (const lane of ALL_LANES) {
      const result = await compile(source, { ...OPTIONS, target: lane });
      expect(initRow(result)).toMatchObject({ irBodyEmitted: false, stage: "select" });
    }
  }, 60_000);
});
