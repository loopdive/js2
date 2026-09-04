// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS1c (getPrototypeOf / reflective-producer family) — RE-PROBED.
//
// The task framed CS1c as "apply the same equality-operand carrier at the
// getPrototypeOf result choke point, flipping CS0 case (d) 0→1". Re-probing the
// getPrototypeOf identity surface against current `upstream/main` (7eb51a2c5)
// shows there is NO bounded, floor-safe, operand-carrier win here — and, more
// importantly, that CS0 case (d) is NOT an object-identity carrier target at
// all. This mirrors CS0 disproving the "reader production site" premise, CS1a
// disproving the "`$AnyValue` carrier" premise, and CS1b(iii) disproving the
// "descriptor producer" premise. The traced measurement (this suite pins it):
//
// 1. **Plain-object / array `[[Prototype]]` is NULL in standalone.**
//    `__getPrototypeOf` (object-runtime.ts) returns `struct.get $Object.$proto`
//    for a `$Object`, else NULL. A plain object literal's `$proto` is unset
//    (Object.prototype is not modeled as a `$Object` standalone), and an array
//    `[1]` is a vec, not a `$Object`, so `ref.test $Object` fails → NULL. Hence
//    `Object.getPrototypeOf([1]) === null` and `Object.getPrototypeOf({z:1})
//    === null` are BOTH `1`. CS0 case (d) (`const a:any=[1]; p1=gpo(a);
//    p2=gpo(a); p1===p2`) is therefore a **null comparison**, not object
//    identity.
//
// 2. **Case (d)'s residual 0 is a stored-in-local NULL-canonicalization
//    symptom, not an identity defect.** A `null` LITERAL stored in two `any`
//    locals compares `===` → **1** (`pure_null_stored`): the literal boxes the
//    null/undefined SINGLETON (tag-0/1), so `ref.eq` answers identity. But
//    getPrototypeOf's `ref.null.extern`, stored in an `any` local, is boxed
//    **tag-5** (externval-null) at the `===` operand seam (the generic
//    `boxToAny` externref arm) → the guarded tag-5 same-tag arm → **0**. The
//    asymmetry is the SAME reader-result-into-`any`-local defect as CS1b(iii)'s
//    residual — the value is externalized into the local and tag-5-boxed
//    downstream, and the operand-scoped carrier (CS1a/b) cannot reach it (the
//    equality operands are LOCALS, not reads). Flipping case (d) means
//    canonicalising a reader/producer result INTO an `any` local independent of
//    downstream use = the UNIVERSAL-reader carrier (CS3 / V2-S3b, the −299
//    minefield), NOT a bounded operand-carrier slice.
//
// 3. **The genuine object-identity getPrototypeOf gaps are ALSO out of the
//    operand-carrier's reach.** A class instance has a real materialized proto
//    struct anchor (`emitLazyProtoGet` singleton):
//      - `getPrototypeOf(f) === getPrototypeOf(f)` DIRECT operands → already 1.
//      - `getPrototypeOf(f)` stored in `any` locals then compared → 0 — the
//        SAME stored-in-local CS3 problem.
//      - `getPrototypeOf(f) === Foo.prototype` → 0, and NOT carrier-flippable:
//        `Foo.prototype` is typed `Foo` (the instance type), not `any`, so the
//        `isAnyEqualityOperand` gate (both operands must be raw-checker `Any`)
//        does not fire — extending the carrier to getPrototypeOf calls would not
//        move it.
//
// **Verdict (recorded for the CS3 assessment):** the operand-scoped carrier
// (CS1a → CS1b(i) → CS1b(ii)) has reached its COVERAGE CEILING. Every remaining
// identity gap under #3027 — descriptor/member/element/getPrototypeOf results
// stored in a local, passed as a function arg, or paired with a non-`any`
// operand — reduces to the reader-result-INTO-`any` universal carrier = CS3,
// the −299 minefield. CS3 is NOT a bounded slice; it needs its own architect
// pass. This suite is BYTE-INERT (no `src/` change; `prove-emit-identity`
// 39/39 IDENTICAL) — a REGRESSION-LOCK pinning the getPrototypeOf identity
// surface (incl. the coincidental-null cases the #3013 lesson warns about) so
// the eventual CS3 flip is auditable.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a leaked `env` import would mean the case silently ran on a JS
  // host fast-path and the result is not the standalone substrate's answer.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

// (#5270 step 2) The two pins below recorded the standalone `[[Prototype]]`
// answer for a plain object and an array as **null** — the state the header
// above describes ("Object.prototype is not modeled as a `$Object`
// standalone"). That state is gone: `__getPrototypeOf` now distinguishes an
// explicitly null prototype (OBJ_FLAG_NULL_PROTO) from an ordinary object whose
// implicit `%Object.prototype%` terminal is simply not stored, and answers the
// canonical carrier for the latter. Both cases now give the SPEC answer, so the
// regression lock pins that instead — the surface it exists to guard is still
// pinned, at the value the surface now has. The identity/carrier findings the
// rest of this suite records are untouched: case (d) below still compares two
// reads of the same prototype and still answers 1.
describe("#3037 CS1c — plain/array prototypes in standalone (#5270: no longer null)", () => {
  it("Object.getPrototypeOf([1]) === Array.prototype [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [1];
        const p: any = Object.getPrototypeOf(a);
        return (p === Array.prototype && p !== null) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Object.getPrototypeOf({z:1}) === Object.prototype [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { z: 1 };
        const p: any = Object.getPrototypeOf(o);
        return (p === Object.prototype && p !== null) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a null LITERAL stored in two `any` locals IS === (null singleton identity) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p1: any = null;
        const p2: any = null;
        return (p1 === p2) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("getPrototypeOf([1]) === getPrototypeOf([1]) as DIRECT operands [1] (coincidental null)", async () => {
    // #3013 lesson: direct null===null passes coincidentally. Pinned so a future
    // proto-modeling change makes the flip DELIBERATE and auditable.
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [1];
        return (Object.getPrototypeOf(a) === Object.getPrototypeOf(a)) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1c — class-instance getPrototypeOf (real proto anchor)", () => {
  it("getPrototypeOf(instance) === getPrototypeOf(instance) DIRECT operands [1]", async () => {
    expect(
      await runStandalone(`class Foo { x: number = 1; }
        export function run(): number {
          const f: any = new Foo();
          return (Object.getPrototypeOf(f) === Object.getPrototypeOf(f)) ? 1 : 0;
        }`),
    ).toBe(1);
  });
});

describe("#3037 CS1c — KNOWN-GAPs beyond the operand carrier (CS3 / non-any-operand)", () => {
  it("[CLOSED by #3055] CS0 case (d) — gpo([1]) stored then === [now 1]", async () => {
    // Both operands are null externref from getPrototypeOf, stored in `any`
    // locals. Previously the operand seam boxed each via `__any_box_string`
    // (tag-5 lie) → the guarded same-tag string arm answered 0. #3055 made the
    // any-equality operand seam classify externrefs by tag via
    // `__any_from_extern`: a null externref now boxes tag-1 (null), so
    // `null === null` → 1 (the semantically correct answer — two reads of the
    // same object's prototype ARE ===).
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [1];
        const p1: any = Object.getPrototypeOf(a);
        const p2: any = Object.getPrototypeOf(a);
        return (p1 === p2) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("[CLOSED by #3055] class getPrototypeOf stored in `any` locals then === [now 1]", async () => {
    // Same as above for a class instance: honest tag-1 null boxing at the
    // operand seam (#3055) makes the stored-in-local prototype `===` correct.
    expect(
      await runStandalone(`class Foo { x: number = 1; }
        export function run(): number {
          const f: any = new Foo();
          const p1: any = Object.getPrototypeOf(f);
          const p2: any = Object.getPrototypeOf(f);
          return (p1 === p2) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("[KNOWN-GAP: non-any operand] getPrototypeOf(instance) === Foo.prototype [0 today]", async () => {
    // `Foo.prototype` is typed `Foo`, not `any`, so the both-operands-`Any`
    // carrier gate never fires — this is not operand-carrier-addressable.
    expect(
      await runStandalone(`class Foo { x: number = 1; }
        export function run(): number {
          const f: any = new Foo();
          return (Object.getPrototypeOf(f) === Foo.prototype) ? 1 : 0;
        }`),
    ).toBe(0);
  });
});
