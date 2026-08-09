// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4266 / #4230 L1) Own-KEY enumeration over a vec receiver in
// `--target standalone`.
//
// Three root causes, one file:
//
//   1. RC1 — the #3251 descriptor OVERLAY was invisible to every key walk. A
//      vec has three own-key stores ($data elements, the #3537 expando bag, the
//      overlay companion); `Object.keys` / for-in / `getOwnPropertyNames` saw
//      the first two and never the third, so a `defineProperty` expando on an
//      array was readable and describable but not enumerable.
//   2. RC1b — `__extern_has` was the ONE presence surface #4010 S3 did not
//      reach, so `"p" in arr` answered false where `arr.hasOwnProperty("p")`
//      answered true. The standalone for-in loop re-checks each key through
//      `__extern_has`, so RC1 alone would have produced a key list the loop
//      silently dropped again.
//   3. RC2 — `__getOwnPropertyNames` had no `$__vec_base` arm at all:
//      `Object.getOwnPropertyNames([1,2,3])` answered `[]`.
//
// EVERY expectation below is the value **Node** produces for the identical
// source (`.tmp/node-oracle.mjs` computed them). The rows that matter most are
// the NEGATIVE ones, because the union has a dedup hazard #4230 named
// explicitly: the overlay SEEDS real array elements as enumerable companion
// entries, so a naive union double-reports index keys. Three families pin that
// down and a naive or always-true implementation fails them:
//
//   - `*_no_dup_*`  — a redefined index / `length` must appear EXACTLY once.
//   - `*_noncanonical_*` — `"00"` / `"1.5"` parse as numbers but are ordinary
//     named properties; a "drop anything numeric-looking" filter loses them.
//   - `*_nonenum_*`, `*_absent_*`, `in_miss` — enumerability, deletion and a
//     missing key must still answer NO.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<Record<string, number>> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports)) {
    if (typeof exports[name] === "function" && name.startsWith("t_")) out[name] = exports[name]!();
  }
  return out;
}

/** name -> [body, expected]. `expected` is Node's answer for the identical source. */
const CASES: Array<[string, string, number]> = [
  // ── RC1: the overlay companion is a key source ────────────────────────────
  [
    "t_keys_overlay_expando",
    `const a: any = [];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return Object.keys(a).length;`,
    1,
  ],
  [
    "t_forin_overlay_expando",
    `const a: any = [];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     let n = 0;
     for (const k in a) n++;
     return n;`,
    1,
  ],
  [
    // The overlay key must survive the for-in loop's own per-key
    // `__extern_has` re-check, which is RC1b. Routing the receiver through a
    // parameter is what forces the DYNAMIC for-in path — the same shape
    // test262's `propertyHelper.js` `isEnumerable(obj, name)` has.
    "t_forin_via_param",
    `function isEnumerable(obj: any, name: any): number {
       let found = 0;
       for (const x in obj) { if (x === name) found = 1; }
       return found;
     }
     const a: any = [];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return isEnumerable(a, "p");`,
    1,
  ],
  [
    // RC1b directly. The second digit is the counter-case: an ABSENT key must
    // still answer false, so an "always true" `in` arm fails this row.
    "t_in_hit_and_miss",
    `const a: any = [];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return (("p" in a) ? 1 : 0) * 10 + (("zz" in a) ? 1 : 0);`,
    10,
  ],
  [
    // Both stores at once — the #3537 bag AND the #3251 overlay — with no
    // double-count between them.
    "t_keys_bag_and_overlay",
    `const a: any = [];
     a.q = 5;
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return Object.keys(a).length;`,
    2,
  ],

  // ── RC2: getOwnPropertyNames' missing vec arm ─────────────────────────────
  ["t_gopn_dense", `const a: any = [1, 2, 3]; return Object.getOwnPropertyNames(a).length;`, 4],
  [
    "t_gopn_overlay_expando",
    `const a: any = [];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return Object.getOwnPropertyNames(a).length;`,
    2,
  ],
  [
    "t_gopn_dense_plus_expando",
    `const a: any = [1, 2];
     Object.defineProperty(a, "p", { value: 12, enumerable: true, writable: true, configurable: true });
     return Object.getOwnPropertyNames(a).length;`,
    4,
  ],

  // ── NEGATIVE: the dedup hazard #4230 named ────────────────────────────────
  [
    // Redefining an EXISTING index seeds a companion entry keyed "0" with
    // SEED_FLAGS (enumerable). A naive union reports "0" twice → 3 / 5.
    "t_keys_no_dup_redefined_index",
    `const a: any = [1, 2];
     Object.defineProperty(a, "0", { value: 9 });
     return Object.keys(a).length;`,
    2,
  ],
  [
    "t_gopn_no_dup_redefined_index",
    `const a: any = [1, 2];
     Object.defineProperty(a, "0", { value: 9 });
     return Object.getOwnPropertyNames(a).length;`,
    3,
  ],
  [
    // `length` is seeded into the companion too, and the vec arm emits it
    // itself — exactly once, or gOPN reports 4.
    "t_gopn_no_dup_length",
    `const a: any = [1, 2];
     Object.defineProperty(a, "length", { value: 2 });
     return Object.getOwnPropertyNames(a).length;`,
    3,
  ],
  [
    // Counter-case for the dedup filter: `"00"` parses to 0 but is NOT a
    // canonical index string, so it is a real named property. A filter that
    // drops "anything that parses as an in-range number" loses it → 2.
    "t_keys_noncanonical_00",
    `const a: any = [1, 2];
     Object.defineProperty(a, "00", { value: 7, enumerable: true, writable: true, configurable: true });
     return Object.keys(a).length;`,
    3,
  ],
  [
    "t_keys_noncanonical_fraction",
    `const a: any = [1, 2];
     Object.defineProperty(a, "1.5", { value: 7, enumerable: true, writable: true, configurable: true });
     return Object.keys(a).length;`,
    3,
  ],

  // ── NEGATIVE: enumerability and absence still answer NO ───────────────────
  [
    // `Object.keys` is enumerable-only; `getOwnPropertyNames` is not. Same
    // receiver, two answers — an implementation that ignores `includeNonEnum`
    // gets one of the two wrong.
    "t_nonenum_keys_vs_gopn",
    `const a: any = [];
     Object.defineProperty(a, "h", { value: 1, enumerable: false, writable: true, configurable: true });
     return Object.keys(a).length * 10 + Object.getOwnPropertyNames(a).length;`,
    2, // keys 0, gOPN 2 (["length","h"])
  ],
  [
    // #4222's `FLAG_DELETED_INDEX` gravestone lives in the same companion the
    // union now drains. It must stay invisible — as a key AND as a hole in the
    // index walk.
    "t_deleted_index_absent",
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "p", { value: 1, enumerable: true, writable: true, configurable: true });
     delete a[1];
     return Object.keys(a).length * 10 + Object.getOwnPropertyNames(a).length;`,
    34, // keys ["0","2","p"], gOPN ["0","2","length","p"]
  ],

  // ── Controls: non-vec receivers are untouched ─────────────────────────────
  [
    "t_ctl_keys_plain_object",
    `const o: any = { x: 1 };
     Object.defineProperty(o, "y", { value: 2, enumerable: true, writable: true, configurable: true });
     return Object.keys(o).length;`,
    2,
  ],
  [
    "t_ctl_gopn_plain_object",
    `const o: any = { x: 1 };
     Object.defineProperty(o, "y", { value: 2, enumerable: false, writable: true, configurable: true });
     return Object.getOwnPropertyNames(o).length;`,
    2,
  ],
  [
    "t_ctl_keys_dense_unchanged",
    `const a: any = [10, 20, 30];
     return Object.keys(a).length;`,
    3,
  ],
];

describe("#4266 — standalone vec own-key enumeration (overlay union + gOPN vec arm)", () => {
  it("matches Node for every key-walk surface over a vec receiver", async () => {
    const src = CASES.map(([name, body]) => `export function ${name}(): number {\n${body}\n}`).join("\n");
    const got = await run(src);
    const expected = Object.fromEntries(CASES.map(([name, , want]) => [name, want]));
    expect(got).toEqual(expected);
  });

  it("adds NOTHING to a module that never mentions a descriptor or own-key builtin (demand gate)", async () => {
    // The whole feature hangs off `ctx.vecOwnKeysDirty`. A module with no
    // `Object`/`Reflect` define / own-name mention must be byte-identical to
    // one compiled before this change — proved here as "the native is not even
    // emitted", which is the strongest form of it we can assert in-process.
    const inert = `export function t_x(): number {
      const a: any = [1, 2, 3];
      let n = 0;
      for (const k in a) n++;
      return n + Object.keys(a).length;
    }`;
    const r = await compile(inert, { target: "standalone" });
    expect(r.success).toBe(true);
    expect(r.wat.includes("__vec_overlay_push_keys")).toBe(false);
    // …and the inert module still answers exactly what it answered before.
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
    expect((instance.exports as Record<string, () => number>).t_x!()).toBe(6);

    // The gate OPENS on a `defineProperty` mention — otherwise the assertion
    // above would pass for a feature that never ships at all.
    const armed = `export function t_x(): number {
      const a: any = [1, 2, 3];
      Object.defineProperty(a, "p", { value: 1, enumerable: true, writable: true, configurable: true });
      return Object.keys(a).length;
    }`;
    const r2 = await compile(armed, { target: "standalone" });
    expect(r2.success).toBe(true);
    expect(r2.wat.includes("__vec_overlay_push_keys")).toBe(true);
  });
});
