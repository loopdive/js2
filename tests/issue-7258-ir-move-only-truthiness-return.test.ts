// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7258 — the move-only scan admits `return x` of a `var x;` dynamic-carrier
// local into an inferred boolean result, read through `dyn.truthy`. A
// non-boolean result and an annotated boolean result stay refused, and so does a
// body with a dynamic method call (#7261: `dyn.f()` traps in an IR body).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
function eqWrite(obj, v) { var ws; ws = obj.a === v; return ws; }
function negThenEq(obj) { var ws; ws = !obj.a; if (ws) { ws = obj.c === 1; } return ws; }
function numberWrite(obj) { var ws; ws = 3; return ws; }
/** @returns {boolean} */
function annotated(obj, v) { var ws; ws = obj.a === v; return ws; }
export function t1(n) { var o = { a: n }; return eqWrite(o, 1) ? 1 : 0; }
export function t2(n) { var o = { a: n }; return eqWrite(o, 1) === true ? 1 : 0; }
export function t3(n) { var o = { a: n, c: 1 }; return negThenEq(o) ? 1 : 0; }
export function t4(n) { var o = { a: n, c: 2 }; return negThenEq(o) ? 1 : 0; }
function viaMethod(o) { var ws; ws = !!o.f(); return ws; }
function viaChainedMethod(o) { var ws; ws = !!o.a.f(); return ws; }
function viaElementMethod(o) { var ws; ws = !!o["f"](); return ws; }
function viaMethodArgs(o) { var ws; ws = !!o.h(o.k, 2); return ws; }
function viaReturnedMethod(o) { var ws; ws = !!mk(o.k).f(); return ws; }
function viaDroppedMethod(o) { var ws; ws = o.k === 1; o.f(); return ws; }
function noMethod(o) { var ws; ws = o.k === 2; return ws; }
function mk(k) { return { k: k, a: { f: function () { return k; } }, f: function () { return k; }, h: function (x) { return x; } }; }
export function m1(k) { return viaMethod(mk(k)) ? 1 : 0; }
export function m2(k) { return viaChainedMethod(mk(k)) ? 1 : 0; }
export function m3(k) { return viaMethodArgs(mk(k)) ? 1 : 0; }
export function m4(k) { return viaReturnedMethod(mk(k)) ? 1 : 0; }
export function m5(k) { return viaDroppedMethod(mk(k)) ? 1 : 0; }
export function m6(k) { return noMethod(mk(k)) ? 1 : 0; }
export function m7(k) { return viaElementMethod(mk(k)) ? 1 : 0; }
export function t5(n) { var o = { a: n }; return numberWrite(o) + annotated(o, 1) ? 1 : 0; }
`;

async function build() {
  const result = await compile(SOURCE, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-7258.mjs",
    target: "standalone",
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#7258 dynamic-carrier local returned into a boolean result", () => {
  it("IR-emits the inferred-boolean returns and keeps the other results refused", async () => {
    const outcomes = (await build()).irOutcomes ?? [];
    const outcome = (name: string) => outcomes.find((o) => o.displayName === name);
    for (const name of ["eqWrite", "negThenEq"]) {
      expect(outcome(name), JSON.stringify(outcomes, null, 2)).toMatchObject({
        kind: "emitted",
        irBodyEmitted: true,
      });
    }
    expect(outcome("noMethod")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    for (const name of [
      "numberWrite",
      "annotated",
      "viaMethod",
      "viaChainedMethod",
      "viaElementMethod",
      "viaMethodArgs",
      "viaReturnedMethod",
      "viaDroppedMethod",
    ]) {
      expect(outcome(name)?.irBodyEmitted, name).not.toBe(true);
    }
  });

  it("returns legacy's booleans at runtime", async () => {
    const { instance } = await WebAssembly.instantiate((await build()).binary, {});
    const exports = instance.exports as Record<string, (n: number) => number>;
    (instance.exports.__module_init as (() => void) | undefined)?.();
    expect([0, 1, 2].map((n) => exports.t1!(n))).toEqual([0, 1, 0]);
    expect([0, 1, 2].map((n) => exports.t2!(n))).toEqual([0, 1, 0]);
    expect([0, 1].map((n) => exports.t3!(n))).toEqual([1, 0]);
    expect([0, 1].map((n) => exports.t4!(n))).toEqual([0, 0]);
    expect([0, 1].map((n) => exports.t5!(n))).toEqual([1, 1]);
    // Legacy's values for the method-call bodies, which stay on legacy (#7261).
    for (const name of ["m1", "m2", "m3", "m4"])
      expect(
        [0, 1, 2].map((n) => exports[name]!(n)),
        name,
      ).toEqual([0, 1, 1]);
    expect([0, 1, 2].map((n) => exports.m5!(n))).toEqual([0, 1, 0]);
    expect([0, 1, 2].map((n) => exports.m6!(n))).toEqual([0, 0, 1]);
    // `o["f"]()` throws on the legacy path too (#7261 notes); the body stays legacy.
    expect(() => exports.m7!(1)).toThrow();
  });
});
