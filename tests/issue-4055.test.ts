/**
 * #4055 — standalone ToPropertyDescriptor never saw the #3468 closure
 * own-property bag.
 *
 * `__obj_define_from_desc` gates EVERY descriptor field on HasProperty before
 * reading it, and that HasProperty was blind to the side table where a function
 * value keeps its own properties. So a **function used as a descriptor** — the
 * dominant test262 spelling — produced an EMPTY descriptor and
 * CompletePropertyDescriptor filled in `undefined` plus all-false attributes.
 * Silently, even though `descObj.enumerable` *reads* `true` via `__extern_get`.
 *
 * The fix is a descriptor-scoped native `__desc_has_own` = `__hasOwnProperty`
 * first, then the bag as a fallback. Kill-switch: make `registerDescriptorHasOwn`
 * return `undefined` and the positive cases below fail.
 *
 * ## The negative cases are the more important half (#4017)
 * The first version of this fix widened `Object.prototype.hasOwnProperty`
 * itself. It kept every flip and was auto-parked out of the merge queue for
 * costing **684 host-free passes**: `propertyHelper.js` reaches
 * `hasOwnProperty` on every `built-ins/**\/{name,length}.js` test — ~700 files,
 * 696 of which failed with "descriptor should be configurable".
 *
 * So the tests pinning `hasOwnProperty` as UNCHANGED are not padding — they are
 * the guard against re-widening the general helper to fix one specific caller.
 * If someone "simplifies" this by folding `__desc_has_own` back into
 * `__hasOwnProperty`, these fail here instead of in the merge queue.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

/** Instantiating with NO import object also asserts host-import freedom. */
async function runStandalone(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#4055 ToPropertyDescriptor over a function descriptor carrier", () => {
  it("reads value + enumerable off a FUNCTION descriptor (15.2.3.6-3-33 shape)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const desc: any = function () {};
          desc.enumerable = true;
          desc.value = 42;
          Object.defineProperty(obj, "property", desc);
          let seen: number = 0;
          for (const k in obj) { if (k === "property") seen = 1; }
          return seen === 1 && obj.property === 42 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("Object.create's Properties entry may be a function carrier (15.2.3.5-4-59 shape)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const desc: any = function () {};
          desc.enumerable = true;
          const o: any = Object.create({}, { prop: desc });
          let seen: number = 0;
          for (const k in o) { if (k === "prop") seen = 1; }
          return seen;
        }
      `),
    ).toBe(1);
  });

  it("a function carrier's SETTER actually fires (15.2.3.6-3-248 shape — not vacuous)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          let data: string = "data";
          const funObj: any = function () {};
          funObj.set = function (v: string): void { data = v; };
          Object.defineProperty(obj, "property", funObj);
          obj.property = "overrideData";
          return data === "overrideData" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a descriptor field ABSENT from the carrier stays absent", async () => {
    // No `enumerable` on the carrier ⇒ CompletePropertyDescriptor default false
    // ⇒ for-in must NOT see it. Guards against the bag answering `true` blindly.
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const desc: any = function () {};
          desc.value = 7;
          Object.defineProperty(obj, "p", desc);
          let seen: number = 0;
          for (const k in obj) { if (k === "p") seen = 1; }
          return seen === 0 && obj.p === 7 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // ── #4017 guards, UPDATED for #4010 S3 (stale-pin fix, landed in #4161's PR) ─
  //
  // These two pinned the #4055-era answer `false`. #4010 S3 then widened
  // `__hasOwnProperty`/`__object_hasOwn` over the carrier bags DELIBERATELY —
  // after S2 made delete real and `buildBuiltinFnSetRefusalArm` removed the
  // −684 pollution mechanism at its source — so the correct current answer is
  // `true`, and these pins had been failing on main since S3 landed (they only
  // run at PR time when their file is touched, #3008). What must still hold is
  // the read/hasOwn AGREEMENT, which the updated assertions pin.

  it("Object.prototype.hasOwnProperty on a function agrees with the read (#4010 S3)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          f.p = 1;
          const has: number = f.hasOwnProperty("p") ? 1 : 0;
          const read: number = f.p === 1 ? 2 : 0;
          return has + read;
        }
      `),
    ).toBe(3);
  });

  it("Object.hasOwn on a function agrees with the read (#4010 S3, second name)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          f.p = 1;
          return Object.hasOwn(f, "p") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("builtin function name/length reflection is UNCHANGED (the parked population)", async () => {
    // propertyHelper.js's verifyProperty rides on exactly this.
    expect(
      await runStandalone(`
        export function test(): number {
          const fn: any = Math.ceil;
          let r: number = 0;
          if (Object.prototype.hasOwnProperty.call(fn, "length")) r = r + 1;
          const d: any = Object.getOwnPropertyDescriptor(fn, "length");
          if (d !== undefined && d.configurable === true) r = r + 2;
          const d2: any = Object.getOwnPropertyDescriptor(fn, "name");
          if (d2 !== undefined && d2.configurable === true) r = r + 4;
          return r;
        }
      `),
    ).toBe(7);
  });

  it("a plain $Object receiver is unchanged", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = {};
          o.k = 1;
          const yes: number = o.hasOwnProperty("k") ? 1 : 0;
          const no: number = o.hasOwnProperty("z") ? 10 : 0;
          return yes + no;
        }
      `),
    ).toBe(1);
  });

  it("a primitive receiver answers false without trapping", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = "str";
          return Object.prototype.hasOwnProperty.call(s, "nope") ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  // ── the boundary this slice does NOT cross (#4010) ────────────────────────

  it("ARRAY expandos are visible to hasOwnProperty (#4010 S3 flipped the pinned boundary)", async () => {
    // The old pin recorded read=5 / hasOwn=false as "measured behaviour, not
    // endorsed: flipping this belongs to #4010" — and #4010 S3 flipped it
    // (`bagHasElseAbsent` in the vec arm). Updated to the endorsed answer:
    // read, named-expando hasOwn, and index hasOwn all agree.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = [1, 2, 3];
          a.q = 5;
          const read: number = a.q === 5 ? 1 : 0;
          const has: number = a.hasOwnProperty("q") ? 2 : 0;
          const idx: number = a.hasOwnProperty("0") ? 4 : 0;
          return read + has + idx;
        }
      `),
    ).toBe(7);
  });
});
