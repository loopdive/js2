// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2162b — standalone array-spread of a pair-producing array iterator:
 * `[...arr.entries()]`.
 *
 * On standalone (`--target wasi`), `arr.entries()` materializes a canonical
 * externref `$Vec` whose elements are `$ObjVec` `[index, value]` pairs (built by
 * `__objvec_new`/`__objvec_push`, mirroring `Object.entries`). Spreading it into
 * an array literal coerces through `buildVecFromExternref` (type-coercion.ts),
 * which builds a vec of `[number, number]` tuple structs. Two defects made every
 * materialized pair field read back as `0`:
 *
 *   A. The tuple-struct inner field read used `__extern_get(pair, box(fi))` —
 *      the STRING-keyed reader, which casts its key to `$AnyString` and returns
 *      undefined on a native `$ObjVec`. The outer loop already chose the
 *      positional `__extern_get_idx`; the inner read now mirrors it.
 *
 *   B. `__extern_get_idx` had NO indexing arm for the canonical externref `$Vec`
 *      container (`boxVecElementToExternref` skipped externref elements wholesale
 *      to avoid the #2190 `ref`/`ref_null`-carrier hazard). So the OUTER
 *      `__extern_get_idx(canonVec, i)` returned null → the pair was lost → every
 *      tuple field defaulted to 0. The arm is now emitted for carriers whose
 *      `arrDef.element` is EXACTLY `externref` (the safe discriminator; the
 *      dangerous `ref`/`ref_null` carriers stay skipped), returning the already-
 *      externref element with no boxing.
 *
 * Structurally identical `Object.entries` pairs already read back correctly;
 * this aligns the array-iterator path with it. Bare `[...map]` / `[...m.entries()]`
 * (the Map iterator) is a separate Map-iterator slice (#2162 / TaskList #8) and
 * is out of scope here.
 *
 * Every case must compile standalone with ZERO host imports and run correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2162b array.entries() array-spread materialization (standalone)", () => {
  it("spread length is correct", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=[...a.entries()]; return e.length; }`,
      ),
    ).toBe(2);
  });

  it("reads back the index slot (pair[0])", async () => {
    // a.entries() -> [0,10],[1,20]; e[0][0]=0, e[1][0]=1 -> 0*10+1 = 1
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=[...a.entries()]; return e[0][0]*10 + e[1][0]; }`,
      ),
    ).toBe(1);
  });

  it("reads back the value slot (pair[1])", async () => {
    // e[0][1]=10, e[1][1]=20 -> 10+20 = 30
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=[...a.entries()]; return e[0][1] + e[1][1]; }`,
      ),
    ).toBe(30);
  });

  it("for-of over the spread result yields the pairs", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=[...a.entries()]; let s=0; for(const [k,v] of e){ s += k*100 + v; } return s; }`,
      ),
    ).toBe(130);
  });

  it("does not regress a plain numeric spread (scalar path unchanged)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=[...a]; return e.length*100 + e[1]; }`,
      ),
    ).toBe(220);
  });

  it("does not regress a plain numeric tuple destructure", async () => {
    expect(await runStandalone(`export function test(): number { const [a,b]=[1,2]; return a+b; }`)).toBe(3);
  });
});
