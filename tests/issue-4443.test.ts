// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4443 — `__extern_get_idx` answered `undefined` for a `$__regexp_match_vec`
 * receiver in any `--target standalone` module that writes a builtin prototype.
 *
 * `fillExternArrayLikeStructArms` (object-runtime.ts) mints closed-struct
 * array-like arms for every struct in `ctx.structFields` carrying a
 * numeric-able `length`, minus a NAME-based skip list (`__vec_*`, `__arr_*`,
 * `__subview_*`, `$*`, `Wrapper*`). `$__regexp_match_vec` is an indexable vec
 * carrier — a `$__vec_base` subtype whose elements live in `data` — but its
 * name matches none of those, so it was admitted as a "closed struct". It
 * declares no canonical integer-named FIELDS, so its `__extern_get_idx` arm
 * degenerated to "`ref.test` the match-vec → answer the prototype-index
 * consult, unconditionally".
 *
 * That arm is only minted when the module HAS a proto-index store, i.e. when
 * something writes a builtin prototype — otherwise `protoGetMiss()` is
 * undefined and the guard skips it. And because these arms splice at body
 * index 3 AFTER `fillExternGetIdxVecArms` put the real element arms there, the
 * bogus arm landed AHEAD of them: control never reached the `vec.data[i]`
 * read.
 *
 * Hence the signature: with ANY builtin-prototype write in the module,
 * `"…".match(re)[0]` was `undefined` while `.length`, `.index` and the
 * STRING-key `m["0"]` were all correct (that key routes through
 * `__extern_get`, a different helper), and a plain array receiver in the same
 * dirty module read fine. Remove the prototype write and the same read is
 * correct — which is what makes the two-module A/B in every case below the
 * actual assertion.
 *
 * Fix: filter STRUCTURALLY on the supertype chain — a `$__vec_base` subtype is
 * never a closed-struct array-like, whatever it is called. Its three helpers
 * are already served by their own arms (`__extern_length`'s #2186 base-vec
 * arm, `__extern_get_idx`'s #2190/#3183 vec arms, `__extern_has_idx`'s vec
 * generalisation), which is exactly what the name-based exclusions relied on.
 *
 * Harness notes (inherited from `issue-4439.test.ts`, same reasons):
 *  - compile as JAVASCRIPT (`allowJs` + a `.js` fileName) — test262's lane;
 *  - compare INSIDE wasm and return an i32. A standalone string is a
 *    `$__nstr` struct; returning it to the host reads as `null` regardless of
 *    correctness, so a host-side `expect(result).toBe("02")` would pass on the
 *    broken compiler too.
 *  - ONE builtin-prototype define per module (#4434's numeric-companion
 *    confound): a second define can move the companion table and mask which
 *    arm answered.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4443.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** The `Number.prototype.match = String.prototype.match` shape of A2_T17/T18. */
const DIRTY = `Number.prototype.foo = 1;\n`;

/**
 * Run `body` twice — once in a module that writes a builtin prototype and once
 * in an otherwise identical clean module — and require the SAME answer. The
 * clean run is the control: it is what the dirty run regressed away from, and
 * it keeps a future "fix" that breaks both lanes equally from passing.
 */
async function bothLanes(body: string): Promise<{ dirty: unknown; clean: unknown }> {
  const wrap = (prefix: string) => `${prefix}export function f() {\n${body}\n}`;
  return {
    dirty: await runStandalone(wrap(DIRTY)),
    clean: await runStandalone(wrap("")),
  };
}

describe("#4443 — indexed read of a match-vec under a dirty builtin prototype", () => {
  // Of the six below, exactly TWO fail on base (measured: revert
  // `object-runtime.ts`, 2 failed / 10 passed) — "through an externref
  // round-trip" and "a borrowed match, the A2_T17 shape". Those are the two
  // that actually reach `__extern_get_idx`. The other four keep the match-vec
  // in its STATIC type, so the element read lowers to a direct `array.get`
  // that never consults the helper's arm ladder. They are non-regression pins,
  // not reproductions, and are listed together deliberately: the defect's
  // whole signature is that the same source reads correctly or not depending
  // on whether the receiver survives as a typed vec, so the passing four are
  // what make the failing two legible.
  it.each([
    [
      "m[0] with a constant index",
      `var m = "10203040506070809000".match(/0./);
       return m[0] === "02" ? 1 : (m[0] === undefined ? -1 : 0);`,
    ],
    [
      "m[i] with a variable index",
      `var m = "10203040506070809000".match(/0./);
       var i = 0;
       return m[i] === "02" ? 1 : (m[i] === undefined ? -1 : 0);`,
    ],
    [
      "through an externref round-trip (the any-typed lane)",
      `var m = "10203040506070809000".match(/0./);
       var box = {}; box.v = m; var w = box.v;
       return w[0] === "02" ? 1 : (w[0] === undefined ? -1 : 0);`,
    ],
    [
      "a capture group at index 1",
      `var m = "abc".match(/a(b)c/);
       return m[1] === "b" ? 1 : (m[1] === undefined ? -1 : 0);`,
    ],
    [
      "exec() result, same carrier",
      `var m = /0./.exec("10203040506070809000");
       return m[0] === "02" ? 1 : (m[0] === undefined ? -1 : 0);`,
    ],
    [
      "a borrowed match, the A2_T17 shape",
      `Number.prototype.match = String.prototype.match;
       var m = (10203040506070809000).match(/0./);
       return m[0] === "02" ? 1 : (m[0] === undefined ? -1 : 0);`,
    ],
  ])("%s reads the element, not the prototype consult", async (_label, body) => {
    const { dirty, clean } = await bothLanes(body);
    expect(clean).toBe(1);
    expect(dirty).toBe(1);
  });

  it.each([
    // These three were already correct on the broken compiler — they are the
    // narrowing that located the defect, so they are pinned as non-regressions.
    ["length", `var m = "10203040506070809000".match(/0./); return m.length;`, 1],
    ["index", `var m = "10203040506070809000".match(/0./); return m.index;`, 1],
    [
      "string-key element read",
      `var m = "10203040506070809000".match(/0./);
       return m["0"] === "02" ? 1 : (m["0"] === undefined ? -1 : 0);`,
      1,
    ],
  ])("keeps %s correct", async (_label, body, want) => {
    const { dirty, clean } = await bothLanes(body);
    expect(clean).toBe(want);
    expect(dirty).toBe(want);
  });

  it("does not let the dirty lane diverge from the clean one on `0 in m`", async () => {
    // The same fill mints an `__extern_has_idx` arm from the same candidate
    // list, so the bogus arm could have made `0 in m` diverge between lanes.
    //
    // It does not, and the honest pin is EQUALITY, not 1: `0 in m` on an
    // externref-held match-vec answers **0 in BOTH lanes, before and after
    // this fix** (measured on base 2026-08-15 — see residual R1 in the issue
    // file). That is a separate pre-existing gap in the `__extern_has_idx` vec
    // coverage for `$__regexp_match_vec`, not something #4443 caused or
    // repairs, and asserting 1 here would be asserting someone else's fix.
    const body = `var m = "10203040506070809000".match(/0./);
       var box = {}; box.v = m; var w = box.v;
       return (0 in w) ? 1 : 0;`;
    const { dirty, clean } = await bothLanes(body);
    expect(dirty).toBe(clean);
  });

  it("leaves a genuine closed-struct array-like on its own arm", async () => {
    // The population `fillExternArrayLikeStructArms` exists for. `{0:…,
    // length:…}` is NOT a vec carrier, so the structural filter must not touch
    // it — including under a dirty prototype, where its arm IS minted.
    const body = `var obj = { 0: 11, 1: 12, length: 2 };
       var s = Array.prototype.reduce.call(obj, function (a, b) { return a + b; }, 0);
       return s * 10 + Array.prototype.indexOf.call(obj, 12);`;
    const { dirty, clean } = await bothLanes(body);
    // reduce → 23, indexOf(12) → 1.
    expect(clean).toBe(231);
    expect(dirty).toBe(231);
  });

  it("leaves a plain array receiver unaffected in a dirty module", async () => {
    const body = `var a = ["a", "b"];
       var box = {}; box.v = a; var w = box.v;
       return w[1] === "b" ? 1 : (w[1] === undefined ? -1 : 0);`;
    const { dirty, clean } = await bothLanes(body);
    expect(clean).toBe(1);
    expect(dirty).toBe(1);
  });
});
