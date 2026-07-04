// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 V2-S2 — builtin-prototype method/getter values are ONE identity-stable
 * object per (brand, member), everywhere.
 *
 * Before V2-S2, three standalone surfaces each reified a builtin-proto member
 * with a FRESH `struct.new` per read (`pushBuiltinFnClosureValueInstrs`), so
 * `RegExp.prototype.exec !== RegExp.prototype.exec` — violating the ES invariant
 * that a builtin method is ONE function object. V2-S2 routes all three surfaces
 * through the #2963 module-level singleton (`pushBuiltinFnSingletonValueInstrs`):
 *   1. the syntactic value read       (property-access.ts method arm)
 *   2. the getter self-struct         (property-access.ts getter arm)
 *   3. the #2885 gOPD descriptor       (calls.ts Site-2: `.value` / `.get`)
 *
 * The singleton keys on the value struct's typeIdx, which is the UNIQUE
 * per-(brand,member) meta subtype (`ensureBuiltinFnMetaType` cache key
 * `proto:<brand>:<kind>:<member>`), so distinct members keep distinct globals
 * — `exec !== test` — while the same member converges to one object.
 *
 * ANTI-VACUITY DISCIPLINE (builtin-proto territory hides coincidental passes,
 * memory `project_hostfree_pass_can_be_coincidentally_wrong`): the identity
 * assertion is paired with (a) a SWAP-GUARD — a *different* member must compare
 * `!==`, proving `===` actually discriminates and isn't always-true — and (b) a
 * `typeof === "function"` guard, proving the operands are the real function value
 * and not two nulls (`null === null` is a false positive). The surface-1 gain was
 * verified by inject/contrast against baseline: fresh-struct.new gives
 * `exec === exec` → 0; the singleton gives 1 (swap-guard `exec === test` stays 0
 * on both). All cases run `--target standalone`, host-free (0 `env` imports).
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

describe("#2175 V2-S2 — builtin-proto member values are identity-stable singletons", () => {
  it("surface 1: RegExp.prototype.exec === RegExp.prototype.exec (self-identity)", async () => {
    // Baseline (fresh struct.new) returned 0; the singleton returns 1. The typeof
    // guard proves the operands are the real function, so `1` is genuine identity,
    // not `null === null`.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = RegExp.prototype.exec;
          const b: any = RegExp.prototype.exec;
          const isFn: number = (typeof a === "function") ? 1 : 0;
          const same: number = (a === b) ? 1 : 0;
          return (isFn === 1 && same === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("surface 1: a second member (test) is also self-identical", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = RegExp.prototype.test;
          const b: any = RegExp.prototype.test;
          return (a === b) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("swap-guard: RegExp.prototype.exec !== RegExp.prototype.test (distinct members stay distinct)", async () => {
    // Proves the singleton keys on the per-member meta typeIdx, NOT a shared
    // global — otherwise every member would collapse to one object. Also proves
    // `===` on these values is a real discriminator (not always-true), so the
    // self-identity assertions above are meaningful.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = RegExp.prototype.exec;
          const b: any = RegExp.prototype.test;
          return (a === b) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("surface 3 (method): gOPD(RegExp.prototype,'exec').value is the correct singleton method", async () => {
    // The #2885 gOPD synthesis (calls.ts Site-2) now stores the singleton. We
    // observe it materializes the RIGHT method value: it classifies as a function
    // through the V2-S1 closure classifier (consumed here) and carries the spec
    // `name`. (Cross-representation `===` identity is a separate V2-S3 gap — see
    // the boundary characterization below.)
    expect(
      await runStandalone(`
        export function test(): number {
          const v: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec") as any).value;
          const isFn: number = (typeof v === "function") ? 1 : 0;
          const named: number = (v.name === "exec") ? 1 : 0;
          return (isFn === 1 && named === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("surface 3 (getter): gOPD(RegExp.prototype,'flags').get is the correct singleton getter", async () => {
    // The accessor descriptor's `.get` (calls.ts getter arm) now stores the
    // singleton getter. It classifies as a function and carries the §10.2.9
    // accessor name spelling ("get flags").
    expect(
      await runStandalone(`
        export function test(): number {
          const g: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "flags") as any).get;
          const isFn: number = (typeof g === "function") ? 1 : 0;
          const named: number = (g.name === "get flags") ? 1 : 0;
          return (isFn === 1 && named === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("V2-S3b boundary (characterization): gOPD(...).value === RegExp.prototype.exec is NOT YET 1", async () => {
    // CHARACTERIZATION guard, not a desired end-state — flips to `.toBe(1)` in
    // V2-S3b (the $NativeProto reader-arm MOP). The V2-S3a carrier arm
    // (`__any_strict_eq`, different-tag branch only) canNOT flip this: the
    // descriptor `.value` read-back is a DIFFERENT ref at the SAME tag as the
    // syntactic singleton (both box the same way), and the only equality path
    // that could reconcile a same-tag pair is the same-tag object-identity arm
    // — which produced −7228 host-free false positives (an object's two
    // $AnyValue boxes at the same tag are NOT one ref) and was scoped OUT.
    // The correct flip is representational: V2-S3b makes `__extern_get` return
    // the actual GC singleton ref, so the `.value` read and the syntactic read
    // are literally the SAME object (tag-6), and the EXISTING same-box/tag-6
    // `ref.eq` arm answers `===` → 1 for free (exactly how `exec === exec`
    // above already works). See plan/issues/2175-standalone-builtin-prototype-readers.md
    // (V2-S3a log). THIS TEST WILL FAIL LOUDLY when V2-S3b lands → update to
    // `.toBe(1)` then.
    expect(
      await runStandalone(`
        export function test(): number {
          const v: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec") as any).value;
          const m: any = RegExp.prototype.exec;
          return (v === m) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("V2-S3a cross-representation carrier: swap-guard stays 0 (arm discriminates, not always-1)", async () => {
    // The V2-S3a different-tag carrier arm must never over-identify: a
    // descriptor's `exec` value must NOT compare `===` to the `test` singleton.
    // Stays 0 both before and after V2-S3b — a permanent anti-vacuity guard for
    // the eventual flip above (proves `===` on these is a real discriminator).
    expect(
      await runStandalone(`
        export function test(): number {
          const v: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec") as any).value;
          const m: any = RegExp.prototype.test;
          return (v === m) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("V2-S3b boundary (characterization): const o:any={z:1}; [o,o]; a[0]===a[1] is NOT YET 1", async () => {
    // Same-tag object round-trip identity — the broad #3027 class. Both array
    // element reads box at the SAME tag, so the V2-S3a different-tag carrier
    // does not fire (an equality arm cannot safely close this — same-tag
    // object-identity `ref.eq` is the −7228-false-positive minefield). Closes
    // with V2-S3b's reader-arm MOP (raw-GC-ref carrier). Distinct objects stay
    // 0 either way (asserted inline — the invariant V2-S3b must preserve).
    const same = await runStandalone(`
        export function test(): number {
          const o: any = { z: 1 };
          const a: any[] = [o, o];
          return (a[0] === a[1]) ? 1 : 0;
        }
      `);
    const diff = await runStandalone(`
        export function test(): number {
          const o: any = { z: 1 };
          const a: any[] = [o, o];
          const b: any = { z: 1 };
          return (a[0] === b) ? 1 : 0;
        }
      `);
    expect(same).toBe(0); // characterization — flips to 1 in V2-S3b
    expect(diff).toBe(0); // invariant — distinct objects never ===
  });
});
