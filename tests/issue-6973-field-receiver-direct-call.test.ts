// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) Two standalone dispatch shortcuts deltablue needed:
//
// 1. `this.<field>.m(…)` inside a typed prototype-method twin, where the field's
//    slot is typed `(ref null $__fnctor_X)`, takes the same guarded direct-call
//    trampoline as a receiver-flow-proven identifier. Deltablue's
//    `Plan.prototype.size` (`return this.v.size()`) and `constraintAt` went
//    through `__extern_method_call` with a fresh argument vector on every call.
//    The guarded trampoline now also declines a receiver that has an own expando
//    bag, so `h.v.size = function…` still shadows the prototype method.
// 2. `vec[key]` with an untyped key reads a non-negative integer Number through
//    `__extern_get_idx` instead of stringifying it for `__extern_get` (which
//    parsed it straight back) — `OrderedCollection.prototype.at`.
//
// Expected values are Node's for the identical source (sloppy script).
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
function Coll() { this.elms = new Array(); }
Coll.prototype.add = function (e) { this.elms.push(e); };
Coll.prototype.size = function () { return this.elms.length; };
Coll.prototype.at = function (index) { return this.elms[index]; };
function Holder() { this.v = new Coll(); }
Holder.prototype.add = function (e) { this.v.add(e); };
Holder.prototype.size = function () { return this.v.size(); };
Holder.prototype.at = function (i) { return this.v.at(i); };
Holder.prototype.drop = function () { this.v = null; };
function Twice() { this.n = 1; }
Twice.prototype.val = function () { return 1; };
Twice.prototype.val = function () { return 2; };
function TwiceHolder() { this.t = new Twice(); }
TwiceHolder.prototype.get = function () { return this.t.val(); };
export function t_holder() {
  var h = new Holder();
  h.add(10); h.add(20); h.add(30);
  var r = h.size() * 1000 + h.at(1);
  h.v.size = function () { return 7; };
  return r + h.size() * 10000;
}
export function t_null_field() {
  var h = new Holder();
  h.drop();
  try { h.size(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
}
export function t_rewritten_proto() { return new TwiceHolder().get(); }
export function t_keys() {
  var c = new Coll(); c.add(1); c.add(2); c.add(3);
  c.elms.foo = 9;
  var out = [c.at(0), c.at("1"), c.at(2), c.at(-1), c.at("foo"), c.at({ toString: function () { return "2"; } }), c.at("length"), c.at(-0), c.at(7)];
  var n = 0;
  for (var i = 0; i < out.length; i++) n = n * 10 + (out[i] === undefined ? 0 : out[i]);
  return n;
}
export function t_loop() {
  var h = new Holder();
  for (var i = 0; i < 50; i++) h.add(i);
  var s = 0;
  for (var k = 0; k < h.size(); k++) s += h.at(k);
  return s;
}
`;

const EXPECTED: Record<string, number> = {
  t_holder: 73020,
  t_null_field: 1,
  t_rewritten_proto: 2,
  t_keys: 123093310,
  t_loop: 1225,
};

async function run(): Promise<Record<string, number>> {
  const result = await compile(SRC, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (typeof value === "function" && name.startsWith("t_")) out[name] = (value as () => number)();
    if (name.startsWith("__exec_count_")) out[name] = (value as WebAssembly.Global).value as number;
  }
  return out;
}

describe("#6973 stage 2 — field-typed receivers and untyped vec keys", () => {
  const saved = process.env.JS2WASM_EXEC_CENSUS;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
    else process.env.JS2WASM_EXEC_CENSUS = saved;
  });

  it("answers what Node answers", async () => {
    const out = await run();
    for (const [name, expected] of Object.entries(EXPECTED)) expect(out[name], name).toBe(expected);
  });

  it("devirtualizes `this.v.size()` and reads `elms[index]` without stringifying the index", async () => {
    process.env.JS2WASM_EXEC_CENSUS = "__dc_Coll_,__extern_method_call,number_toString";
    const out = await run();
    expect(out.t_loop).toBe(1225);
    const count = (prefix: string): number =>
      Object.entries(out)
        .filter(([k]) => k.startsWith(`__exec_count_${prefix}`))
        .reduce((sum, [, v]) => sum + v, 0);
    // Every export ran once above; the direct-call trampolines carried the
    // Holder → Coll calls, and of the ~60 numeric `at` keys only `c.at(-1)`
    // (not an array index) still went through ToString.
    expect(count("__dc_Coll_")).toBeGreaterThan(100);
    expect(count("number_toString")).toBeLessThan(5);
  });
});
