// for-of ASSIGNMENT destructuring wrote to a STALE module-global index.
//
// Filed against #5243 because that is the commit whose merge_group exposed it
// (d41376f94d, `buildRecordFromExternref`), but the defect is older and lives
// in `src/codegen/statements/for-of-destructuring.ts`, not in the coercion arm.
//
// THE RULE. Those paths resolve the assignment target's module global once —
//
//     const globalIdx = ctx.moduleGlobals.get(targetEl.text);   // snapshot
//     …compile the element read / default / TDZ guard…          // may INTERN
//     fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });
//
// — and then emit `global.set` with that snapshot. Every string constant
// interned in between adds an IMPORTED global, and imported globals sit BEFORE
// module-defined ones in the index space, so `fixupModuleGlobalIndices` shifts
// `ctx.moduleGlobals` and every already-emitted `global.get`/`global.set` — but
// it cannot reach an index a caller copied into a `let`. The stale index then
// names an import, and imports are IMMUTABLE:
//
//     WebAssembly.instantiate(): Compiling function #7:"run" failed:
//     immutable global #2 cannot be assigned
//
// #4447 fixed exactly this for two object-pattern call sites by carrying the
// NAME instead of the index; the array/tuple/vec/rest/externref/iterator twins
// kept the snapshot. This test pins the twins.
//
// MEASURED (2026-09-01, A/B on `for-of-destructuring.ts` alone):
//
//   case          BASE (HEAD before the fix)               AFTER
//   nestedArray   immutable global #2 cannot be assigned → "12"
//   arrayRest     immutable global #2 cannot be assigned → "2"
//
// In test262 this was the 18-file `for-await-of/async-{func,gen}-decl-dstr-*`
// cluster that parked the #5226 chain's merge group (run 33442432133); there
// the shift was 18 imports wide and landed on `string_constants.IsHTMLDDA`.
// The `let` targets are load-bearing: a module-scope `let` gets a TDZ guard
// whose "<name> is not defined" message is interned during the element read,
// i.e. inside the snapshot→writeback window. A `var` target has no guard and
// hits the bug only when something else interns there — which is why the same
// two patterns over `var` are NOT a regression test.

import { describe, expect, it } from "vitest";

import { compileAndRunHost } from "./helpers/compile.js";

describe("#5243 — for-of assignment destructuring re-resolves its module-global index", () => {
  it("nested array pattern over a module-scope let", async () => {
    const e = await compileAndRunHost(`
let x;
export function run(): string {
  let out = "";
  for ([[x]] of [[[1]], [[2]]]) { out += String(x); }
  return out;
}
`);
    expect((e as unknown as { run(): string }).run()).toBe("12");
  });

  it("rest element with an elision over a module-scope let", async () => {
    const e = await compileAndRunHost(`
let z;
export function run(): string {
  let out = "";
  for ([, ...z] of [[1, 2, 3]]) { out += String(z.length); }
  return out;
}
`);
    expect((e as unknown as { run(): string }).run()).toBe("2");
  });

  // Control: these two shapes already routed through the #4447 by-name path and
  // pass on both sides of the fix. They are here so a future change that
  // re-snapshots the index has to break something visible.
  it("object property pattern and array default still round-trip", async () => {
    const objProp = await compileAndRunHost(`
let w;
export function run(): string {
  let out = "";
  for ({ k: w } of [{ k: "a" }, { k: "b" }]) { out += String(w); }
  return out;
}
`);
    expect((objProp as unknown as { run(): string }).run()).toBe("ab");

    const arrayDefault = await compileAndRunHost(`
let y;
export function run(): string {
  let out = "";
  for ([y = "d"] of [[], ["v"]]) { out += String(y); }
  return out;
}
`);
    expect((arrayDefault as unknown as { run(): string }).run()).toBe("dv");
  });
});
