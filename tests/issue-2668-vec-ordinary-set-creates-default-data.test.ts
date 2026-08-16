// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2668) An ordinary indexed assignment that CREATES an array element must
// produce `{writable: true, enumerable: true, configurable: true}`.
//
// In `--target standalone` an indexed write on an `any`/externref-typed array
// receiver is routed by the `__extern_set` overlay prologue to the vec define
// native `__vec_dp_value`. That call passed only the `hasValue` flag bit, which
// specifies NONE of writable/enumerable/configurable — so when the index did not
// already exist, CompletePropertyDescriptor (§6.2.6.6) filled the three omitted
// fields with **false**. Every ordinary `a[i] = v` that grew the array therefore
// minted a non-writable, non-enumerable, non-configurable own property:
//
//     var a = []; a[0] = 101;
//     Object.getOwnPropertyDescriptor(a, "0")
//       // was  {value: 101, writable: false, enumerable: false, configurable: false}
//       // now  {value: 101, writable: true,  enumerable: true,  configurable: true}
//
// The knock-on was worse than the descriptor read: a later legal redefine threw.
// `Object.defineProperty(a, "0", {value: 101, writable: true, enumerable: true,
// configurable: true})` — a no-op same-value redefine of a plain element — hit
// "configurable attribute of a non-configurable property" and aborted the
// module (test262 `15.2.3.6-4-212`, `15.2.3.7-6-a-208`).
//
// The defect hid behind its own controls. An element that is already BACKED gets
// seeded with all-true attributes inside `__vec_dp_value` before the merge, so
// `a.length = 1; a[0] = 101`, the `[101]` literal, `push`, and a typed
// `number[]` grow were all already correct — four plausible-looking probes that
// each say "this works". Only the CREATE-through-`__extern_set` shape was wrong,
// which is why the rows below keep those four as CONTROLS rather than deleting
// them: they are what made the defect look impossible.
//
// Control reaches the changed call site only when the key has NO companion
// descriptor entry (every non-null-entry arm above it returns: deleted →
// re-seed, accessor → setter, writable → merge-write, non-writable → silent
// reject), so the index is either an implicit dense element — whose effective
// attributes are all true — or brand new. All-true is correct in both cases,
// which is why the fix is a flag constant and not a new branch.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<Record<string, number>> {
  const result = await compile(source, lane === "standalone" ? { target: "standalone" } : {});
  expect(
    result.success,
    `compile failed (${lane}):\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports)) {
    if (typeof exports[name] === "function" && name.startsWith("t_")) out[name] = exports[name]!();
  }
  return out;
}

/**
 * `wec(setup)` — build index 0 the way `setup` says, then return the three
 * attribute bits of `Object.getOwnPropertyDescriptor(a, "0")` packed as
 * `w*100 + e*10 + c`. `111` is Node's answer for every row.
 */
const wec = (setup: string): string => `${setup}
   const d: any = Object.getOwnPropertyDescriptor(a, "0");
   return (d.writable ? 100 : 0) + (d.enumerable ? 10 : 0) + (d.configurable ? 1 : 0);`;

/** `1` when the body threw, `0` when it completed. */
const threw = (body: string): string => `try {\n${body}\nreturn 0;\n} catch (e) {\nreturn 1;\n}`;

// name -> [body, expected]. `expected` is Node's answer for the identical source.
const CASES: Array<[string, string, number]> = [
  // ── the defect: an ordinary set that CREATES the index ─────────────────────
  ["t_grow_from_empty_literal", wec(`const a: any = []; a[0] = 101;`), 111],
  ["t_grow_from_new_Array", wec(`const a: any = new Array(); a[0] = 101;`), 111],
  // ── the four controls that made it look impossible (index already backed) ──
  ["t_presized_then_write", wec(`const a: any = []; a.length = 1; a[0] = 101;`), 111],
  ["t_array_literal", wec(`const a: any = [101];`), 111],
  ["t_push", wec(`const a: any = []; a.push(101);`), 111],
  ["t_typed_vec_grow", wec(`const a: number[] = []; a[0] = 101;`), 111],
  // ── the value survives, not just the attributes ────────────────────────────
  ["t_grown_value", `const a: any = []; a[0] = 101; return a[0];`, 101],
  // ── the knock-on: a legal redefine of a grown element must not throw ───────
  [
    "t_same_value_redefine_survives",
    `const a: any = [];
     a[0] = 101;
     ${threw(`Object.defineProperty(a, "0", { value: 101, writable: true, enumerable: true, configurable: true });`)}`,
    0,
  ],
  [
    "t_empty_redefine_keeps_defaults",
    // `Object.defineProperty(a, "0", {})` on a grown element preserves all
    // three. Standalone-only — see HOST_SKIP.
    `const a: any = [];
     a[0] = 101;
     Object.defineProperty(a, "0", {});
     const d: any = Object.getOwnPropertyDescriptor(a, "0");
     return (d.writable ? 100 : 0) + (d.enumerable ? 10 : 0) + (d.configurable ? 1 : 0);`,
    111,
  ],
  // ── what must STILL refuse — the change must not widen the write path ──────
  [
    "t_non_writable_element_not_overwritten",
    // A TS module is strict-mode code, so the rejected write THROWS rather than
    // being a silent no-op — `109` is `threw(1)*100 + a[0]`, confirmed against
    // `node --input-type=module`. Both halves matter: the throw proves the
    // rejection still fires, the `9` proves nothing was written first.
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "0", { value: 9, writable: false });
     let t = 0;
     try { a[0] = 77; } catch (e) { t = 1; }
     return t * 100 + a[0];`,
    109,
  ],
  [
    "t_frozen_array_takes_no_new_index",
    `const a: any = [1];
     Object.freeze(a);
     try { a[1] = 5; } catch (e) {}
     return (a.length * 10) + (a.hasOwnProperty("1") ? 1 : 0);`,
    10,
  ],
];

/**
 * Rows the HOST lane does not answer correctly today, for reasons that predate
 * and are independent of this change — the change is inside a `ctx.standalone`
 * branch and cannot reach host codegen. Measured base-vs-head on this exact
 * source: host is **byte-identical on all eleven rows**, five of them wrong in
 * both arms. They are skipped rather than pinned, because pinning them would
 * pin a bug; they are listed rather than dropped, because a skipped row that
 * nobody can name is indistinguishable from a row nobody checked.
 *
 *  - `t_array_literal`, `t_push`, `t_typed_vec_grow`, `t_grown_value` — inside
 *    a FUNCTION body (as opposed to module scope) the host lane loses the
 *    element: `a[0]` reads back `0`/`undefined` and gOPD reports all-false.
 *  - `t_empty_redefine_keeps_defaults` — `_vecDefineOwnProperty`'s deliberate
 *    "in-bounds index with no sidecar is a first definition" workaround, the
 *    host-side half of #2668 (host reports 0, i.e. all three false).
 *  - `t_non_writable_element_not_overwritten` — host answers `101`, i.e. the
 *    rejected write does not throw and `a[0]` is `1`, not `9`.
 */
const HOST_SKIP = new Set([
  "t_array_literal",
  "t_push",
  "t_typed_vec_grow",
  "t_grown_value",
  "t_empty_redefine_keeps_defaults",
  "t_non_writable_element_not_overwritten",
]);

const SOURCE = CASES.map(([name, body]) => `export function ${name}(): number {\n${body}\n}`).join("\n");

describe("#2668 — an ordinary indexed set creates an all-true data property", () => {
  it("standalone: every element-creation shape reports writable/enumerable/configurable", async () => {
    const got = await run(SOURCE, "standalone");
    const expected: Record<string, number> = {};
    for (const [name, , want] of CASES) expected[name] = want;
    expect(got).toEqual(expected);
  }, 240_000);

  it("host: unchanged, and agrees wherever it already implements the rule", async () => {
    const got = await run(SOURCE, "host");
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};
    for (const [name, , want] of CASES) {
      if (HOST_SKIP.has(name)) continue;
      expected[name] = want;
      actual[name] = got[name]!;
    }
    expect(actual).toEqual(expected);
  }, 240_000);
});
