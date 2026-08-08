// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Array exotic `[[DefineOwnProperty]]` rejections in `--target standalone`.
//
// Three rules of ES §10.4.2.2 / §10.1.6.3 were unenforced for a WasmGC `__vec_*`
// receiver, each producing a SILENT wrong answer rather than the required
// TypeError:
//
//   1. §10.4.2.2 step 3 — once `length` is non-writable, defining an index AT or
//      BEYOND it must throw. The overlay carried the length's writable bit but
//      the index path never read it, so the array simply grew.
//   2. §10.1.6.3 step 2 — a non-extensible array takes no NEW index. The bit was
//      recorded (`Object.isExtensible` read it correctly) but the index define
//      validated against the companion `$Object`, which has no such bit.
//   3. `Object.defineProperties(arr, {length: …})` bypassed the native
//      ArraySetLength entirely: the plural form routed to the compile-time
//      inline expansion, which has no view of the overlay companion, so a shrink
//      walked straight past non-configurable indices and a frozen length was
//      ignored. The SINGULAR form was already standalone-gated off for exactly
//      this reason (#3251 S3); the plural one was not.
//
// Every expectation is the value **Node** produces for the same source, and the
// host lane is asserted alongside standalone so neither can regress. The
// non-throwing rows are the other half of the contract: growth, shrink and
// in-bounds redefines must still work.
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

/** `1` when the body threw, `0` when it completed — the shape every rejection row uses. */
const threw = (body: string): string => `try {\n${body}\nreturn 0;\n} catch (e) {\nreturn 1;\n}`;

// name -> [body, expected]. `expected` is Node's answer for the identical source.
const CASES: Array<[string, string, number]> = [
  // ── 1. non-writable length blocks an index at/beyond it ───────────────────
  [
    "t_frozen_len_index_at",
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "length", { writable: false });
     ${threw(`Object.defineProperty(a, "3", { value: 9 });`)}`,
    1,
  ],
  [
    "t_frozen_len_index_beyond",
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "length", { writable: false });
     ${threw(`Object.defineProperty(a, "7", { value: 9 });`)}`,
    1,
  ],
  [
    "t_frozen_len_length_unchanged",
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "length", { writable: false });
     try { Object.defineProperty(a, "3", { value: 9 }); } catch (e) { /* expected */ }
     return a.length;`,
    3,
  ],
  // An IN-BOUNDS index is an existing element, not a new property: still legal.
  [
    "t_frozen_len_index_inbounds",
    `const a: any = [1, 2, 3];
     Object.defineProperty(a, "length", { writable: false });
     Object.defineProperty(a, "1", { value: 42 });
     return a[1];`,
    42,
  ],

  // ── 2. non-extensible array takes no new index ────────────────────────────
  [
    "t_nonext_new_index",
    `const a: any = [];
     Object.preventExtensions(a);
     ${threw(`Object.defineProperty(a, "0", { value: 1 });`)}`,
    1,
  ],
  [
    "t_nonext_new_index_absent",
    `const a: any = [];
     Object.preventExtensions(a);
     try { Object.defineProperty(a, "0", { value: 1 }); } catch (e) { /* expected */ }
     return a.hasOwnProperty("0") ? 1 : 0;`,
    0,
  ],
  // Redefining an EXISTING configurable index on a non-extensible array is legal.
  [
    "t_nonext_existing_index",
    `const a: any = [5];
     Object.preventExtensions(a);
     Object.defineProperty(a, "0", { value: 9 });
     return a[0];`,
    9,
  ],

  // ── 3. Object.defineProperties must run the real ArraySetLength ───────────
  [
    "t_defprops_shrink_stops_at_nonconfigurable",
    `const a: any = [0, 1];
     Object.defineProperty(a, "1", { configurable: false });
     ${threw(`Object.defineProperties(a, { length: { value: 1 } });`)}`,
    1,
  ],
  [
    "t_defprops_shrink_stop_keeps_length",
    `const a: any = [0, 1];
     Object.defineProperty(a, "1", { configurable: false });
     try { Object.defineProperties(a, { length: { value: 1 } }); } catch (e) { /* expected */ }
     return a.length;`,
    2,
  ],
  [
    "t_defprops_frozen_length",
    `const a: any = [];
     Object.defineProperty(a, "length", { writable: false });
     ${threw(`Object.defineProperties(a, { length: { value: 12 } });`)}`,
    1,
  ],
  // The non-throwing half: plural length shrink / grow must still take effect.
  [
    "t_defprops_shrink_ok",
    `const a: any = [0, 1, 2];
     Object.defineProperties(a, { length: { value: 1 } });
     return a.length;`,
    1,
  ],
  [
    "t_defprops_grow_ok",
    `const a: any = [];
     Object.defineProperties(a, { length: { value: 3 } });
     return a.length;`,
    3,
  ],
  // A `length` define must not materialise the array's HOLES as own properties.
  // The plural loop's own inline expansion does exactly that for ANY key (it is
  // reproducible with `{foo: {value: 1}}` and is not this change's to fix), so
  // the standalone `length` key is handed to the singular compiler instead —
  // these two rows are what pins that routing. They deliberately use a TYPED
  // array literal rather than the `any` receiver the rows above use: an `any`
  // receiver takes a different read/write lowering that materialises holes on
  // its own, independently of any define, which would make these rows report a
  // defect they are not measuring.
  [
    "t_defprops_length_keeps_hole",
    `const a = [0, , 2];
     Object.defineProperties(a, { length: { value: 3 } });
     return a.hasOwnProperty("1") ? 1 : 0;`,
    0,
  ],
  [
    "t_defprops_shrink_then_regrow_keeps_hole",
    `const a = [0, 1];
     Object.defineProperties(a, { length: { value: 1 } });
     a.length = 10;
     return a.hasOwnProperty("1") ? 1 : 0;`,
    0,
  ],
  // A plain index define on an untouched array still grows the length.
  [
    "t_index_define_grows",
    `const a: any = [];
     Object.defineProperty(a, "2", { value: 7 });
     return a.length;`,
    3,
  ],

  // ── 4. Object.getOwnPropertyNames(ToObject) rejects only nullish ──────────
  ["t_gopn_undefined", threw(`Object.getOwnPropertyNames(undefined);`), 1],
  ["t_gopn_null", threw(`Object.getOwnPropertyNames(null);`), 1],
  // ES2015+ ToObject WRAPS a primitive — it must NOT throw for a string.
  ["t_gopn_string", threw(`Object.getOwnPropertyNames("ab");`), 0],
];

const SOURCE = CASES.map(([name, body]) => `export function ${name}(): number {\n${body}\n}`).join("\n");

/**
 * The rows the HOST lane already answers correctly, and therefore the rows a
 * host regression must still be caught on.
 *
 * Host mode is NOT held to the full table, and that is a measured statement, not
 * an assumption: with an `any`-typed array receiver the host lane gets nine of
 * these thirteen wrong today (an index define reads back the OLD element, the
 * length comes back `NaN`, none of the three rejections fire). That is a
 * SEPARATE pre-existing gap in the host descriptor path — the fix under test is
 * standalone-only (the #3251 overlay + the plural ArraySetLength routing), so
 * pinning host's wrong answers here would only freeze a bug in place. Listing
 * the passing subset keeps the lane honestly covered without doing that.
 */
const HOST_COVERED = new Set([
  "t_defprops_frozen_length",
  "t_defprops_shrink_ok",
  "t_defprops_grow_ok",
  "t_defprops_length_keeps_hole",
  "t_defprops_shrink_then_regrow_keeps_hole",
  "t_gopn_undefined",
  "t_gopn_null",
  "t_gopn_string",
]);

describe("ES5 standalone — array exotic [[DefineOwnProperty]] rejections", () => {
  it("standalone: matches Node on every array define rule", async () => {
    const got = await run(SOURCE, "standalone");
    const expected: Record<string, number> = {};
    for (const [name, , want] of CASES) expected[name] = want;
    expect(got).toEqual(expected);
  }, 180_000);

  it("host: unchanged on the rules it already implements", async () => {
    const got = await run(SOURCE, "host");
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};
    for (const [name, , want] of CASES) {
      if (!HOST_COVERED.has(name)) continue;
      expected[name] = want;
      actual[name] = got[name]!;
    }
    expect(actual).toEqual(expected);
  }, 180_000);
});
