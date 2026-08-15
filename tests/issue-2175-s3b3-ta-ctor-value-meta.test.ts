// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 S3b-3 defects B + C — a reified TypedArray view CONSTRUCTOR value
 * answers `typeof` and `.length` correctly.
 *
 * These two are silent wrong answers, measured on `origin/main` @ `9e17d34f3`,
 * standalone, read through an `any` binding so the constant fold is not what is
 * probed ([[reference_constant_folded_probe_tests_the_static_path]]):
 *
 * | read                    | was        | spec                        |
 * | ----------------------- | ---------- | --------------------------- |
 * | `typeof Int8Array`      | `"object"` | `"function"`  (§23.2.5)     |
 * | `Int8Array.length`      | `0`        | `3`           (§23.2.5.1)   |
 * | `Int8Array["length"]`   | `3` ✓      | `3`  (already correct)      |
 * | `gOPD(Int8Array,"length").value` | `3` ✓ | `3` (already correct)   |
 *
 * The last two rows are what make these worth pinning: the value was ALREADY
 * available through the element-access and descriptor paths, so the property-
 * access lowering was diverging from its own module's other answers. Root causes
 * were different for each: `typeof` because #4120's `OBJ_FLAG_CALLABLE` brand
 * rides `$Object.flags` and a view ctor is its own `$__ta_ctor` struct that
 * cannot carry it; `.length` because `emitStandaloneAnyLength` gated its
 * `__builtinfn_get_meta` consult on the receiver being a closure subtype, which
 * a `$__ta_ctor` is not.
 *
 * HONEST SCOPE — read this before assuming a conformance win. These fixes flip
 * **zero** test262 files in the #4444 row-3 reflection bucket today. The 20
 * `built-ins/TypedArrayConstructors/<View>/{length,name}.js` files are blocked
 * by a THIRD, independent defect: `verifyProperty` proves configurability by
 * DELETING the property, and `delete`/`gOPD` disagree on these carriers
 * (`delete C.length` → true and `"length" in C` → false, but `gOPD` still
 * returns a descriptor). That needs the ctor value backed by a real
 * own-property `$Object` (v2 D7) and is tracked separately. B and C are
 * PREREQUISITES for those files, not the fix — once the delete-coherence work
 * lands, `length.js` still needs the correct value that B supplies.
 *
 * Every case is `--target standalone` with zero `env` imports.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const env = r.imports.filter((i) => i.module === "env");
  expect(env, `unexpected host imports: ${env.map((i) => i.name).join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2175 S3b-3 — reified TypedArray ctor values report typeof/length correctly", () => {
  it("C: typeof Int8Array === 'function' through an any binding", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Int8Array;
          return (typeof C === "function") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("C: ANTI-VACUITY — a non-callable value on the same binary is still 'object'", async () => {
    // Without this, an arm that answered "function" for every struct would pass
    // the test above. `Math` is deliberately NOT branded callable (#4120).
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Int8Array;
          const M: any = Math;
          const o: any = { a: 1 };
          const ctorIsFn: number = (typeof C === "function") ? 1 : 0;
          const mathIsObj: number = (typeof M === "object") ? 1 : 0;
          const objIsObj: number = (typeof o === "object") ? 1 : 0;
          return (ctorIsFn === 1 && mathIsObj === 1 && objIsObj === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("B: Int8Array.length === 3, and agrees with the element-access + descriptor paths", async () => {
    // The agreement is the point — the property-access form was the outlier.
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Int8Array;
          const viaProp: number = (C.length === 3) ? 1 : 0;
          const viaElem: number = (C["length"] === 3) ? 1 : 0;
          const d: any = Object.getOwnPropertyDescriptor(C, "length");
          const viaDesc: number = (d !== undefined && d.value === 3) ? 1 : 0;
          return (viaProp === 1 && viaElem === 1 && viaDesc === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("B: works with no closure in the module (the consult is not closure-gated)", async () => {
    // Regression guard for the exact miss found mid-slice: the first cut of the
    // fix only fired when a closure root existed, so this same read still
    // answered 0 in a closure-free module.
    expect(
      await runStandalone(`
        export function test(): number {
          const C: any = Uint16Array;
          return (C.length === 3) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("B: ANTI-VACUITY — other receivers keep their own length semantics", async () => {
    // `RegExp`/`Map` were already correct and must stay so; an array's `.length`
    // must remain its element count, not a ctor arity.
    expect(
      await runStandalone(`
        export function test(): number {
          const arr: any = [1, 2, 3];
          const R: any = RegExp;
          const M: any = Map;
          const arrOk: number = (arr.length === 3) ? 1 : 0;
          const reOk: number = (R.length === 2) ? 1 : 0;
          const mapOk: number = (M.length === 0) ? 1 : 0;
          return (arrOk === 1 && reOk === 1 && mapOk === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("B: a plain user closure's .length is unchanged by this slice", async () => {
    // Guards the miss path. The value is 1 — `((x) => x*2).length` IS 1 per
    // §20.2.4.1 — and it reads 1 on unmodified `origin/main` @ `9e17d34f3` too,
    // so this slice did not move it.
    //
    // I first wrote this expecting 0, on the strength of the "flat 0" wording in
    // `emitStandaloneAnyLength`'s #2580 comment. That comment describes the
    // FALLBACK emitted when no metadata is available, not what a real arrow
    // function reads, and the assertion failed. Measured before asserting: base
    // and branch both give 1.
    expect(
      await runStandalone(`
        export function test(): number {
          const f = (x: number): number => x * 2;
          const g: any = f;
          return (g.length === 1 && f(2) === 4) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
