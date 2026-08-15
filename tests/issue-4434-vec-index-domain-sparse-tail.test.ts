// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4434) Two array invariants the standalone vec overlay did not hold.
//
//   1. SPARSE TAIL — `a.length = N` bumps the vec's logical length without
//      growing the physical backing, and every dynamic metaobject chokepoint
//      then indexed `data[i]` on the strength of the logical bound alone. The
//      result was an UNCATCHABLE Wasm trap ("array element access out of
//      bounds") on the ordinary ES5 presize idiom — `a.length = 3; a[1]` —
//      and on `hasOwnProperty` / `getOwnPropertyDescriptor` /
//      `defineProperty` / `join` over the same array.
//
//   2. INDEX DOMAIN — `__obj_index_of_key` detected out-of-range keys by
//      testing its i32 accumulator for a NEGATIVE value after the fact, which
//      misses every key that wraps to a non-negative residue. `"4294967296"`
//      accumulated to exactly 0, so a define at that key silently invented a
//      property at index 0 and grew `length` to 1.
//
// Every expectation below is Node's answer for the same source. The host lane
// is asserted alongside standalone wherever the value is representable, so a
// standalone-only fix cannot drift the two apart.
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

// ── 1. sparse tail ─────────────────────────────────────────────────────────
//
// Each case is its own module on purpose. A module that ALSO performs a normal
// indexed define arms the overlay's module-global numeric-companion flag, and
// then every later read works for the wrong reason — that confound hid the
// second half of this bug through two rounds of probing.
const SPARSE: Array<[string, string, number]> = [
  // the read that trapped: an index inside the tail is a hole, so `undefined`
  ["t_tail_read", `const a: any = []; a.length = 3; return a[1] === undefined ? 1 : 0;`, 1],
  // presence: a hole is not an own property
  ["t_tail_hasown", `const a: any = []; a.length = 3; return a.hasOwnProperty("1") ? 1 : 0;`, 0],
  // reflection: a hole has no own descriptor
  [
    "t_tail_gopd",
    `const a: any = []; a.length = 3; return Object.getOwnPropertyDescriptor(a, "1") === undefined ? 1 : 0;`,
    1,
  ],
  // write into the tail materialises a real element
  ["t_tail_write", `const a: any = []; a.length = 3; a[1] = 9; return a[1] as number;`, 9],
  // 15.2.3.6-4-274 / 15.2.3.7-6-a-263: defineProperty on an index in the tail.
  // The define is a FIRST definition (the hole has no implicit descriptor to
  // redefine), and it must not disturb the logical length.
  [
    "t_tail_define_val",
    `const a: any = []; a.length = 3; Object.defineProperty(a, "1", { value: 14 }); return a[1] as number;`,
    14,
  ],
  [
    "t_tail_define_len",
    `const a: any = []; a.length = 3; Object.defineProperty(a, "1", { value: 14 }); return a.length as number;`,
    3,
  ],
  [
    "t_tail_define_plural",
    `const a: any = []; a.length = 3; Object.defineProperties(a, { "1": { value: 26 } }); return a[1] as number;`,
    26,
  ],
  // a tail that starts past REAL elements
  ["t_tail_after_elems", `const a: any = [1, 2]; a.length = 5; return a[4] === undefined ? 1 : 0;`, 1],
  // control: shrink is unaffected
  ["t_shrink", `const a: any = [1, 2, 3]; a.length = 1; return a[2] === undefined ? 1 : 0;`, 1],
  // control: a dense define still writes through to the element
  [
    "t_dense_define",
    `const a: any = [1, 2, 3]; Object.defineProperty(a, "1", { value: 42 }); return a[1] as number;`,
    42,
  ],
];

describe("#4434 sparse tail — a logical length beyond the backing is holes, not a trap", () => {
  for (const [name, body, expected] of SPARSE) {
    it(`${name} (standalone)`, async () => {
      const out = await run(`export function ${name}(): number {\n${body}\n}`, "standalone");
      expect(out[name]).toBe(expected);
    });
  }

  // The host lane trapped on the SAME idiom, through its own bridge
  // (`__vec_get`, `vec-oob-read.ts`) rather than through `__extern_get_idx`, so
  // the capacity conjunct was applied there too and is deliberately NOT
  // standalone-gated. Converting a terminal trap into a value cannot regress a
  // passing program.
  //
  // What the host lane still does NOT match is how it REPRESENTS the resulting
  // hole: `a[1] === undefined` answers false there (it yields the carrier's
  // sentinel, not the `undefined` singleton). That is the pre-existing
  // array-hole representation gap owned by #2001 / #4222, not this fix — so the
  // rows below are the ones whose answer does not depend on it, and the
  // `=== undefined` rows are asserted for standalone only, above.
  //
  // Every row whose answer is a VALUE written into an array index is excluded
  // for a SECOND, independent reason, stated here rather than silently dropped:
  // on the host lane `Object.defineProperty(a, "1", {value: 42})` does not write
  // through to the element AT ALL — `a[1]` still answers 2 on a fully DENSE
  // `[1,2,3]`. Verified identical on `origin/main`, so it is pre-existing and
  // unrelated to the capacity conjunct; the same goes for a plain `a[1] = 9`
  // into the unbacked tail. Both are recorded in #4434's residuals.
  //
  // What remains assertable on host is the part this change is responsible for:
  // the read does not trap, and the LENGTH is undisturbed.
  const HOST_ROWS = new Set(["t_tail_define_len"]);

  it("host lane: the length rows agree", async () => {
    const rows = SPARSE.filter(([n]) => HOST_ROWS.has(n));
    const src = rows.map(([n, b]) => `export function ${n}(): number {\n${b}\n}`).join("\n");
    const out = await run(src, "host");
    for (const [name, , expected] of rows) expect(out[name], name).toBe(expected);
  });

  it("host lane: reading the unbacked tail no longer traps", async () => {
    // Asserts only the absence of the trap — see the note above on why the
    // host lane's hole VALUE is out of scope here.
    await expect(
      run(`export function t_x(): number { const a: any = []; a.length = 3; const v = a[1]; return 1; }`, "host"),
    ).resolves.toBeDefined();
  });
});

// ── 2. canonical index domain ──────────────────────────────────────────────
describe("#4434 index domain — a key that is not an array index is not index 0", () => {
  // 2^32 wrapped the i32 accumulator to exactly 0. `length` must stay 0 and no
  // element may appear at index 0. (15.2.3.7-6-a-181 / -182.)
  it("2^32 is a named key, not index 0 (standalone)", async () => {
    const out = await run(
      `const a: any = [];
       Object.defineProperty(a, "4294967296", { value: 100 });
       export function t_len(): number { return a.length as number; }
       export function t_at0(): number { return a[0] === undefined ? 1 : 0; }`,
      "standalone",
    );
    expect(out["t_len"]).toBe(0);
    expect(out["t_at0"]).toBe(1);
  });

  // Read-back through the INDEXED lane. `arr[4294967295]` reaches
  // `__extern_get_idx` as an f64 whose `number_toString` is the stored key, so
  // the companion — not the vec — is authoritative for it.
  it("a non-index numeric key reads back through the indexed lane (standalone)", async () => {
    const out = await run(
      `const a: any = [];
       Object.defineProperty(a, 4294967295, { value: 100 });
       export function t_val(): number { return a[4294967295] as number; }`,
      "standalone",
    );
    expect(out["t_val"]).toBe(100);
  });

  it("2^32 reads back through the indexed lane (standalone)", async () => {
    const out = await run(
      `const a: any = [];
       Object.defineProperty(a, "4294967296", { value: 100 });
       export function t_val(): number { return a[4294967296] as number; }`,
      "standalone",
    );
    expect(out["t_val"]).toBe(100);
  });

  // The narrow-fast-path property that pays for the above: an ordinary named
  // expando is not numeric, so it must NOT arm the indexed-read consult.
  it("an ordinary expando still reads back (standalone)", async () => {
    const out = await run(
      `const a: any = [];
       Object.defineProperty(a, "foo", { value: 7 });
       export function t_val(): number { return a["foo"] as number; }`,
      "standalone",
    );
    expect(out["t_val"]).toBe(7);
  });

  // Controls: real indices are unaffected in both directions.
  it("real indices are unaffected (standalone)", async () => {
    const out = await run(
      `const a: any = [];
       Object.defineProperty(a, "5", { value: 55 });
       export function t_len(): number { return a.length as number; }
       export function t_val(): number { return a[5] as number; }
       export function t_has(): number { return a.hasOwnProperty("5") ? 1 : 0; }`,
      "standalone",
    );
    expect(out["t_len"]).toBe(6);
    expect(out["t_val"]).toBe(55);
    expect(out["t_has"]).toBe(1);
  });
});
