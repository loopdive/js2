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

  it("V2-S3b (landed): gOPD(...).value === RegExp.prototype.exec is now 1 (raw-anyref carrier)", async () => {
    // FLIPPED by V2-S3b (path 2, the D4 raw-anyref carrier). WAT-resolved root
    // cause: this guard is a SAME-tag-5 × same-tag-5 comparison — the descriptor
    // `.value` read AND the sibling `RegExp.prototype.exec` both marshal to
    // externref and box via `__any_box_string` (tag-5, the #1888 lie), landing in
    // the same-tag-5 content-eq arm (`ref.test $AnyString`-guarded, NEVER
    // `ref.eq`), so two identical FUNCTION externrefs answered 0. V2-S3b boxes
    // STRICT-eq operands through `__any_box_eq_operand` (any-helpers.ts): a genuine
    // GC reference object becomes tag-6 (`refval` identity) while primitives keep
    // their exact tag-5 box. Both operands now land in the EXISTING tag-6 `ref.eq`
    // arm of `__any_strict_eq` — the guard flips with NO equality-arm change,
    // exactly how `exec === exec` already resolves. The same carrier fixes the
    // broad `const o:any={z:1}; [o,o]` array-identity + `const b=a; a===b` #3027
    // class. Paired with the swap-guard below (distinct members stay `!==`), so
    // `1` is genuine identity, not always-true.
    expect(
      await runStandalone(`
        export function test(): number {
          const v: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec") as any).value;
          const m: any = RegExp.prototype.exec;
          return (v === m) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("V2-S3b swap-guard: gOPD(...).value === a DIFFERENT member stays 0 (carrier discriminates)", async () => {
    // Proves the raw-anyref carrier short-circuits on GENUINE identity only —
    // the descriptor's `exec` value must NOT compare `===` to the `test`
    // singleton. Guards the flip above against a vacuous always-1 carrier.
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

  it("V2-S3b array-identity: const o:any={z:1}; [o,o]; a[0]===a[1] is now 1 (#3027 class)", async () => {
    // The broad round-trip-identity gap the carrier closes: two reads of the
    // same object through the reader (array element get → externref-wrapped)
    // now compare `===` → 1. Distinct objects still 0 (asserted inline).
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = { z: 1 };
          const a: any[] = [o, o];
          const same: number = (a[0] === a[1]) ? 1 : 0;
          const b: any = { z: 1 };
          const diff: number = (a[0] === b) ? 1 : 0;
          return (same === 1 && diff === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
