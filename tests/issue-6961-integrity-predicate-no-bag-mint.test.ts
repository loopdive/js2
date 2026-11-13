// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6961 — the object-integrity PREDICATES minted a carrier bag per query.
//
// `Object.isExtensible/isFrozen/isSealed` on a non-`$Object` carrier resolved
// the receiver through `__integrity_bag`, which ENSURES the bag. For an Array
// that is `__vec_bag_ensure`: a walk of a global identity-keyed list plus a
// prepend on a miss. Every RegExp exec result defines `index`/`input`/`groups`
// on a brand-new array, and each define asks `isExtensible` first — so n exec
// calls cost Θ(n²) list hops and retained every match array (Octane regexp:
// 34–49 s/rep vs node 76 ms).
//
// The predicates now read through `__integrity_bag_lookup` and answer a
// bag-less carrier as pristine; only the mutators ensure.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function instantiate(source: string) {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => unknown>;
}

// Untyped helpers force the GENERAL (non-`_obj`) predicates; the direct calls
// on typed locals select the `_obj` variants. Expected values are Node's.
const SEMANTICS = `
function ext(x: any): number { return Object.isExtensible(x) ? 1 : 0; }
function frz(x: any): number { return Object.isFrozen(x) ? 1 : 0; }
function sld(x: any): number { return Object.isSealed(x) ? 1 : 0; }
function trio(x: any): number { return ext(x) * 100 + frz(x) * 10 + sld(x); }
class K { v = 1; }
export function t_arr_pristine(): number { return trio([1, 2]); }
export function t_arr_empty(): number { return trio([]); }
export function t_arr_prevext(): number { const a = [1]; Object.preventExtensions(a); return trio(a); }
export function t_arr_seal(): number { const a = [1]; Object.seal(a); return trio(a); }
export function t_arr_freeze(): number { const a = [1]; Object.freeze(a); return trio(a); }
export function t_arr_expando_then_query(): number { const a: any = [1]; a.foo = 2; return trio(a); }
export function t_arr_query_then_prevext(): number {
  const a = [1];
  const before = trio(a);
  Object.preventExtensions(a);
  return before * 1000 + trio(a);
}
export function t_arr_obj_variant(): number {
  const a = [1, 2];
  return (Object.isExtensible(a) ? 100 : 0) + (Object.isFrozen(a) ? 10 : 0) + (Object.isSealed(a) ? 1 : 0);
}
export function t_fn_pristine(): number { return trio(function () {}); }
export function t_inst_pristine(): number { return trio(new K()); }
export function t_inst_seal(): number { const k = new K(); Object.seal(k); return trio(k); }
export function t_err_pristine(): number { return trio(new Error("x")); }
export function t_err_prevext(): number { const e = new Error("x"); Object.preventExtensions(e); return trio(e); }
export function t_match_pristine(): number { return trio(/(\\d)/.exec("a1b")); }
export function t_number(): number { return trio(5); }
export function t_string(): number { return trio("s"); }
`;

const EXPECTED: Record<string, number> = {
  t_arr_pristine: 100,
  t_arr_empty: 100,
  t_arr_prevext: 0,
  t_arr_seal: 1,
  t_arr_freeze: 11,
  t_arr_expando_then_query: 100,
  t_arr_query_then_prevext: 100000,
  t_arr_obj_variant: 100,
  t_fn_pristine: 100,
  t_inst_pristine: 100,
  t_inst_seal: 1,
  t_err_pristine: 100,
  t_err_prevext: 0,
  t_match_pristine: 100,
  t_number: 11,
  t_string: 11,
};

describe("#6961 integrity predicates read the carrier bag without minting it", () => {
  it("answers match node for pristine and mutated carriers (standalone)", async () => {
    const exports = await instantiate(SEMANTICS);
    const got: Record<string, number> = {};
    for (const name of Object.keys(EXPECTED)) got[name] = exports[name]!() as number;
    expect(got).toEqual(EXPECTED);
  });

  it("many RegExp exec results on an untyped receiver stay linear", async () => {
    // 50k fresh match arrays: Θ(n²) ≈ 1.25e9 list hops before the fix (~15 s),
    // well under a second after.
    const exports = await instantiate(`
      function ex(r: any, s: any): any { return r.exec(s); }
      export function run(n: number): number {
        const re = /a/g;
        let s = "";
        for (let i = 0; i < n; i++) s += "a";
        let count = 0;
        let m: any;
        while ((m = ex(re, s))) count += m.index >= 0 ? 1 : 0;
        return count;
      }
    `);
    const t0 = performance.now();
    expect(exports.run!(50000)).toBe(50000);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
