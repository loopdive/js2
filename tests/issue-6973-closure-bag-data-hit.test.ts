// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) `__closure_prop_get` answers a live DATA entry of a callable
// carrier's own-property bag straight from the entry. It used to run the
// generic `__hasOwnProperty` predicate on the bag (a ~1.9 k-instruction
// dispatcher) and then a receiver-bound `__extern_get` over it — for every
// `Strength.weaker(…)` / `Strength.REQUIRED` read in Octane deltablue.
// Accessors, tombstones and inherited reads keep the old path. Expected
// values are Node's for the identical source.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
function S(v) { this.v = v; }
S.weaker = function (a, b) { return a.v > b.v; };
S.weakestOf = function (a, b) { return this.weaker(a, b) ? a : b; };
S.K = 7;
S.U = undefined;
Object.defineProperty(S, "G", { get: function () { return this === S ? 11 : 12; }, configurable: true });
Function.prototype.inh = 5;
export function t_static() {
  var a = new S(1), b = new S(2);
  return S.weakestOf(a, b).v * 100 + S.K + (S.U === undefined ? 1000 : 0) + ("U" in S ? 10000 : 0);
}
export function t_accessor() { return S.G; }
export function t_inherited() {
  var f = function () {};
  f.inh = 9;
  var r = f.inh;
  delete f.inh;
  return r * 10 + f.inh;
}
export function t_meta() {
  function named(a, b) {}
  named.extra = 1;
  return named.length * 100 + named.name.length * 10 + named.extra;
}
export function t_bound() {
  function g() { return this.x; }
  var b = g.bind({ x: 4 });
  b.tag = 6;
  return b() * 10 + b.tag;
}
export function t_loop() {
  var s = 0;
  for (var i = 0; i < 200; i++) s += S.K;
  return s;
}
`;

const EXPECTED: Record<string, number> = {
  t_static: 11207,
  t_accessor: 11,
  t_inherited: 95,
  t_meta: 251,
  t_bound: 46,
  t_loop: 1400,
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
  const census = instance.exports.__exec_count___hasOwnProperty as WebAssembly.Global | undefined;
  const out: Record<string, number> = {};
  for (const name of Object.keys(EXPECTED)) {
    const before = (census?.value as number | undefined) ?? 0;
    out[name] = (instance.exports[name] as () => number)();
    out[`calls:${name}`] = ((census?.value as number | undefined) ?? 0) - before;
  }
  return out;
}

describe("#6973 stage 2 — callable carrier bag DATA hit", () => {
  const saved = process.env.JS2WASM_EXEC_CENSUS;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
    else process.env.JS2WASM_EXEC_CENSUS = saved;
  });

  it("answers what Node answers", async () => {
    const out = await run();
    for (const [name, expected] of Object.entries(EXPECTED)) expect(out[name], name).toBe(expected);
  });

  it("reads a static data property without the generic own-property predicate", async () => {
    process.env.JS2WASM_EXEC_CENSUS = "__hasOwnProperty";
    const out = await run();
    expect(out.t_loop).toBe(1400);
    // 200 reads of `S.K`; each one used to ask `__hasOwnProperty` on the bag.
    expect(out["calls:t_loop"]).toBeLessThan(20);
  });
});
