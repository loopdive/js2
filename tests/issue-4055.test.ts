/**
 * #4055 — standalone `__hasOwnProperty` never got the carrier own-property BAG
 * fallback that `__extern_get` / `__extern_set` / `__extern_method_call` received
 * from #3468 (closures). Its body bailed with `0` on `ref.test $Object`, so a
 * function value answered `false` for a property it had just stored *through the
 * same substrate*.
 *
 * That is not merely a wrong boolean: `__obj_define_from_desc`'s
 * ToPropertyDescriptor (§6.2.5.6) gates EVERY descriptor field on `HasProperty`
 * before reading it, so a Function descriptor carrier — the dominant test262
 * spelling, `var descObj = function(){}; descObj.enumerable = true;` — produced
 * an EMPTY descriptor and CompletePropertyDescriptor filled in `undefined` plus
 * all-false attributes. Silently.
 *
 * Kill-switch: make `buildCarrierBagHasOwnArm` return `[]` and every positive
 * case below fails while every negative case still passes — which is exactly why
 * the negative cases are here.
 *
 * The negative cases are load-bearing in the other direction. This change flips
 * `hasOwnProperty` false→true, so the failure mode to guard is OVER-reporting:
 * a key that was never stored, a receiver with no bag at all, and a primitive
 * receiver must all still answer `false` (and must not trap — the object runtime
 * helpers are throw-free by #3468's S1 discipline).
 *
 * The ARRAY half is deliberately absent and pinned as such by the last test.
 * `fillVecHasOwnHelpers` unshifts a prologue into `__hasOwnProperty` that answers
 * from `__vec_gopd` and returns for every vec receiver, so no arm in the body is
 * reachable for an array. Reconciling the #3251 overlay with the #3537 expando
 * bag is #4010's job; this test records the current, measured behaviour so the
 * boundary is a decision rather than an oversight.
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

describe("#4055 hasOwnProperty over the closure own-property bag", () => {
  it("reports an own property stored on a function value", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          f.p = 7;
          return f.hasOwnProperty("p") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("agrees with the read path it shares a substrate with", async () => {
    // Before the fix these two disagreed: the read said 7, hasOwn said false.
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          f.p = 7;
          const read: number = f.p === 7 ? 1 : 0;
          const has: number = f.hasOwnProperty("p") ? 2 : 0;
          return read + has;
        }
      `),
    ).toBe(3);
  });

  it("Object.hasOwn shares the predicate", async () => {
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

  it("ToPropertyDescriptor now reads a FUNCTION descriptor carrier (the reason this matters)", async () => {
    // 15.2.3.6-3-33 shape: the descriptor is a function object carrying
    // `enumerable`/`value` as own properties.
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

  it("Object.create's Properties entry may be a function descriptor carrier", async () => {
    // 15.2.3.5-4-59 shape.
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

  // ── negative direction: this change must not OVER-report ──────────────────

  it("a key that was never stored is still not own", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          f.p = 1;
          return f.hasOwnProperty("other") ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("a function with no bag at all is still not own", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const f: any = function () {};
          return f.hasOwnProperty("nope") ? 1 : 0;
        }
      `),
    ).toBe(0);
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

  // ── the boundary this slice does NOT cross (#4010) ────────────────────────

  it("ARRAY expandos stay invisible to hasOwnProperty — the #4010 boundary, pinned", async () => {
    // `arr.q` READS 5 (the #3537 bag) while `hasOwnProperty("q")` answers false,
    // because vec-overlay's prologue answers every vec receiver from __vec_gopd
    // (the disjoint #3251 overlay) and returns before any body arm. Recorded as
    // measured behaviour, not endorsed: flipping this belongs to #4010.
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
    ).toBe(5);
  });
});
