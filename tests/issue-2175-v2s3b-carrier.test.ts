// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 V2-S3b — the D4 raw-anyref carrier (path 2).
 *
 * ROOT CAUSE (WAT-resolved): a GC object read back through the externref boundary
 * — a descriptor `.value`, an array element, `const b = a` — marshals to externref
 * and boxes via `__any_box_string` (tag-5, the #1888 box-the-externref lie). Under
 * `===` BOTH operands become tag-5, landing in `__any_strict_eq`'s same-tag-5 arm,
 * which does string CONTENT-eq (`ref.test $AnyString`-guarded, never `ref.eq`). Two
 * identical FUNCTION/object externrefs are not strings, so it answers 0 — even
 * though both wrap the IDENTICAL reference. (Contrast `exec === exec`, which stays
 * on the raw tag-6 GC-ref path and hits the tag-6 `ref.eq` arm → 1.)
 *
 * FIX (path 2, no equality-arm change): the STRICT-eq operand marshalling
 * (coercion-engine `emitAnyEqOperands`, strict only) boxes a genuine GC reference
 * object through `__any_box_eq_operand` → tag-6 (`refval` identity). Both operands
 * then land in the EXISTING tag-6 `ref.eq` arm — the guard flips for free.
 *
 * SAFETY: the carrier delegates to the byte-identical `__any_box_string` for every
 * PRIMITIVE (string / number / boolean / bigint), null, and already-boxed
 * `$AnyValue`; only genuine reference objects flip to tag-6. So the only behavioural
 * change is same-object-via-two-reads: 0 → 1 (a `===` correctness fix). Scoped to
 * strict `===`/`!==` (loose `==` runs ToPrimitive and is untouched) and to
 * standalone/WASI (host/GC objects are host externrefs whose identity already
 * holds — the helper is absent there, byte-inert).
 *
 * ANTI-VACUITY (builtin-proto territory hides coincidental passes — memory
 * `project_hostfree_pass_can_be_coincidentally_wrong`): every identity `→ 1` below
 * is paired with a swap-wrong-value / distinct-object `→ 0`, proving the carrier
 * DISCRIMINATES and is not an always-true short-circuit. All cases run
 * `--target standalone` and assert ZERO `env` (host) imports.
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

describe("#2175 V2-S3b — raw-anyref carrier: object identity through externref reads", () => {
  it("gOPD(RegExp.prototype,'exec').value === RegExp.prototype.exec → 1 (the guard flip)", async () => {
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

  it("swap-wrong-value: gOPD(...,'exec').value === RegExp.prototype.test → 0 (discriminates)", async () => {
    // Proves the flip is genuine identity, not always-1: the descriptor's `exec`
    // value must NOT equal a DIFFERENT member's singleton.
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

  it("!== negation: gOPD(...,'exec').value !== RegExp.prototype.exec → 0", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const v: any = (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec") as any).value;
          const m: any = RegExp.prototype.exec;
          return (v !== m) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("alias identity: const b = a; a === b → 1, but {x:1} === {x:1} → 0", async () => {
    // The broad #3027 identity class the carrier closes — and its negative.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = { x: 1 };
          const b: any = a;
          const same: number = (a === b) ? 1 : 0;
          const c: any = { x: 1 };
          const d: any = { x: 1 };
          const diff: number = (c === d) ? 1 : 0;
          return (same === 1 && diff === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("array round-trip identity: [o,o]; a[0]===a[1] → 1, a[0]===fresh → 0", async () => {
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

  // ── Primitive-preservation guards (the carrier must NOT touch value/content eq) ──

  it("bigint stays VALUE-compared: 10n === 10n → 1, 10n === 11n → 0", async () => {
    // If the carrier misclassified a $BoxedBigInt as an identity object, distinct
    // 10n structs would `ref.eq` → 0. It must stay value-compared.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = 10n; const b: any = 10n;
          const eq: number = (a === b) ? 1 : 0;
          const c: any = 10n; const d: any = 11n;
          const ne: number = (c === d) ? 1 : 0;
          return (eq === 1 && ne === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("string stays CONTENT-compared: 'a'+'b' === 'ab' → 1, 'ab' === 'ac' → 0", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = "a" + "b"; const b: any = "ab";
          const eq: number = (a === b) ? 1 : 0;
          const c: any = "ab"; const d: any = "ac";
          const ne: number = (c === d) ? 1 : 0;
          return (eq === 1 && ne === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("number numeric-class preserved: 23 === 23.0 → 1, 1 === 2 → 0", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = 23; const b: any = 23.0;
          const eq: number = (a === b) ? 1 : 0;
          const c: any = 1; const d: any = 2;
          const ne: number = (c === d) ? 1 : 0;
          return (eq === 1 && ne === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("mixed object×primitive stays 0: {x:1} === 'x' and {x:1} === 5 → 0", async () => {
    // Different-tag: recovered via the V2-S3a arm; object never equals a primitive.
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = { x: 1 };
          const s: number = (a === ("x" as any)) ? 1 : 0;
          const n: number = (a === (5 as any)) ? 1 : 0;
          return (s === 0 && n === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("null identity preserved: null === null → 1", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = null; const b: any = null;
          return (a === b) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
