// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS0 — object-identity canonicalization CHARACTERIZATION + invariant lock.
//
// This suite is BYTE-INERT: it adds NO codegen change. It pins the *current*
// standalone `===` boundary as a table so the later substrate slice (CS1+) that
// flips reader/any-object identity `0 -> 1` is auditable, and so the cases that
// must NEVER move are guarded against a coincidental regression. `prove-emit-
// identity` stays 39/39 IDENTICAL alongside this file (no `src/` byte changes).
//
// ── The measured root cause (traced on upstream/main @ af6eff6c1) ──────────────
//
// The architect spec (#3037) framed the residual as *dynamic-reader-specific*:
// two objects read through the same dynamic reader box tag-5 (externval) and hit
// the guarded tag-5 same-tag arm of `__any_strict_eq`, which returns 0 for
// non-strings. CS0's measurement CONFIRMS that failure — AND shows it is a
// *symptom of a broader representation defect*, not a reader-only bug:
//
//   * An `any`-typed OBJECT value loses `ref.eq` identity UNIVERSALLY, not only
//     through a reader. `const inner: any = {z:1}; inner === inner` is **0**
//     (an object compared to *itself*!). The object literal, evaluated in a
//     contextually-`any` position, is carried as an externref and boxed **tag-5**
//     at the `===` operand-marshalling site (`emitAnyEqOperands` ->
//     `coerceType(externref -> $AnyValue)` -> `boxToAny` -> `__any_box_string`).
//     Two tag-5 boxes land in the guarded tag-5 same-tag arm -> 0.
//
//   * The identity-PRESERVING cases prove the fix direction: a *typed* object
//     (`const inner = {z:1}`) stays a raw `ref $Object`, so boxing to `any` uses
//     `__any_box_ref` -> **tag-6** (refval), and the tag-6 same-tag `ref.eq` arm
//     answers identity correctly. Typed-object holds, function values, and
//     objects passed through `any` params all stay tag-6 -> `1`.
//
//   * Empirically (a temporary `emitAnyEqOperands` probe): the operand of a
//     dynamic `any`-member read has ValType **externref** (`isAnyValue=false`),
//     so the tag-5 boxing happens at the `===` operand site via the *generic*
//     `boxToAny` externref arm — the #1888 −788 chokepoint. There is NO separate
//     "reader boxes its result to $AnyValue" site to migrate: the reader returns
//     a bare externref and the tag is decided downstream at the operand site.
//
// Consequence for CS1 (recorded here so the next slice is scoped correctly):
// making objects reach `===` as tag-6 without touching the generic externref
// boxing arm (−788) or the `===` operand-site (−299, V2-S3b) requires a
// PRODUCTION-SITE representation change — object values entering an `any` slot
// must be boxed as raw refs (tag-6) rather than externalized to tag-5 — i.e. the
// `any`-object carrier, not a reader-local box. See the issue file for the full
// CS1 re-scope. Partial coverage remains SAFE (S3a's cross-tag arm reconciles a
// transitional tag-6 × tag-5 pair), so CS1 can land per carrier-family.
//
// ── The $BoxedNumber eq-castability probe (spec open question, settled here) ────
//
// The honest classifier must NOT box a $BoxedNumber-carrying externval tag-6:
// `__box_number_struct` is a plain WasmGC struct (index.ts:11690), so every
// concrete struct is a subtype of the `eq` abstract heap type -> `ref.test (ref
// eq)` returns 1 for it. A BARE `ref.test $eq` classifier WOULD mis-route a boxed
// number to the tag-6 arm and re-break numeric `===`. The existing
// `__any_from_extern` honest arm already guards this by peeling $BoxedNumber
// (tag-3) and $BoxedBoolean (tag-4) via `ref.test nativeBox*TypeIdx` BEFORE its
// `$AnyString`-first / eq-second classification (any-helpers.ts ~496-528) — so
// CS1 MUST reuse the FULL `__any_from_extern` classifier, never the bare
// `fallbackStringAny` eq fragment. (str3)/(num-lit) below guard this edge.
//
// ── Table legend ──────────────────────────────────────────────────────────────
//   FLIP-TARGET : currently 0; the CS1+ substrate fix must turn it to 1.
//   FLIPPED     : a FLIP-TARGET the landed CS1a carrier already turned to 1.
//   INVARIANT   : must NEVER change (anti-vacuity negatives + already-correct).
//
// ── CS1a landed (any-object-literal carrier) ───────────────────────────────────
// Case (c) — `const inner: any = {z:1}; inner === inner` — is now **1**. CS1a
// (statements/variables.ts + literals.ts `objectLiteralIsStandaloneAnyObjectCarrier`)
// slots a spread-free data-only object literal produced into an `any` context as a
// raw `ref $Object` local instead of an externref: at `===` it boxes **tag-6**
// (`__any_box_ref`, identity in `refval`) so the tag-6 same-tag `ref.eq` arm answers
// identity, while dynamic `any`-typed reads coerce the ref back to externref
// (`extern.convert_any`) for `__extern_get`. The `===` operand seam (−299) and the
// generic externref boxing arm (−788) are untouched. The OTHER FLIP-TARGETs stay 0:
// (a) gOPD `.value`, (b) two dynamic reads of an aliased object, (d) getPrototypeOf,
// (e) a dynamically-read number — those flip via CS1b (dynamic-read carrier) / CS1c
// (reflective-producer carrier), separate slices whose reads still box tag-5.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a leaked env import would mean the case silently ran on a host
  // fast-path and the identity result is not the standalone substrate's answer.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#3037 CS0 — standalone object-identity characterization (FLIP-TARGETs)", () => {
  it("(a) two gOPD().value reads of the same data property ARE ===  [FLIPPED by CS1b: now 1]", async () => {
    // Descriptor `.value` stores the raw ref honestly; the loss was at the read +
    // === operand-marshalling (both reads boxed tag-5). CS1b re-classifies a
    // dynamic `any`-member read that is a direct `any`-equality operand through
    // `__any_from_extern_honest` -> the shared function ref boxes tag-6 -> the
    // tag-6 `ref.eq` arm answers identity.
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; } };
        const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
        const d2: any = Object.getOwnPropertyDescriptor(p, "exec");
        return (d1.value === d2.value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(b) two dynamic reads of one aliased object ARE ===  [FLIPPED by CS1b: now 1]", async () => {
    // The pivotal CS1b case: `o.a` and `o.b` alias one stored ref. Each read is a
    // direct operand of the `any === any` comparison, so CS1b classifies both to
    // tag-6 (identity in `refval`) -> the tag-6 same-tag `ref.eq` arm -> 1.
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const o: any = { a: inner, b: inner };
        return (o.a === o.b) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(c) an any-typed object IS === to ITSELF  [FLIPPED by CS1a: now 1]", async () => {
    // The pivotal case. Before CS1a the object literal in an `any` context was
    // carried as externref -> tag-5 -> guarded same-tag arm -> 0 (an object not
    // `===` to itself). CS1a slots the local as a raw `ref $Object` so `===` boxes
    // it tag-6 (identity in `refval`) -> the tag-6 `ref.eq` arm answers identity.
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        return (inner === inner) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(d) getPrototypeOf(x) === getPrototypeOf(x)  [FLIPPED: now 1]", async () => {
    // (#2963 PR housekeeping) This FLIP-TARGET pin was stale-RED on current
    // main (verified pre-change): an intervening landed change canonicalized
    // the stored-null comparison, so the two `getPrototypeOf([1])` results
    // (both null in standalone — see the CS1c null-proto facts) now compare
    // `===` -> 1, which is the CORRECT JS answer (null === null). Pin updated
    // to the correct value; CS1c's KNOWN-GAP rows still audit the remaining
    // stored-in-local identity cases.
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [1];
        const p1: any = Object.getPrototypeOf(a);
        const p2: any = Object.getPrototypeOf(a);
        return (p1 === p2) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(e) a dynamically-read number IS === to a re-read of itself  [FLIPPED by CS1b: now 1]", async () => {
    // A boxed-number externval read twice boxed tag-5 twice -> guarded string
    // arm -> 0. CS1b's honest classifier peels `$BoxedNumber` -> tag-3 BEFORE the
    // eq test, so `o.n === o.n` compares by value (42 === 42) -> 1, spec-correct.
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { n: 42 };
        return (o.n === o.n) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS0 — INVARIANTS that must never regress (anti-vacuity + already-correct)", () => {
  it("(neg1) distinct objects with equal shape are NOT ===  [INVARIANT: stays 0]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { a: { z: 1 }, b: { z: 1 } };
        return (o.a === o.b) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("(neg2) two distinct gOPD properties are NOT ===  [INVARIANT: stays 0]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; }, test: function () { return 2; } };
        const de: any = Object.getOwnPropertyDescriptor(p, "exec");
        const dt: any = Object.getOwnPropertyDescriptor(p, "test");
        return (de.value === dt.value) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("(pos1) a TYPED object aliased through two any locals IS ===  [INVARIANT/control: stays 1]", async () => {
    // Proves tag-6 works today: a raw `ref $Object` boxed to any via __any_box_ref.
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const a: any = inner;
        const b: any = inner;
        return (a === b) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(pos2) a function value assigned to any IS === to itself  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const f: any = function () { return 1; };
        return (f === f) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(pos3) a typed object passed through any params IS ===  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`
        function eq(a: any, b: any): number { return (a === b) ? 1 : 0; }
        export function run(): number { const inner = { z: 1 }; return eq(inner, inner); }`),
    ).toBe(1);
  });

  it("(pos4) aliased array elements (typed array) ARE ===  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const arr: any[] = [inner, inner];
        return (arr[0] === arr[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(str1) a dynamically-read string IS === to a re-read (content)  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (o.s === o.s) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(str2) a dynamically-read string IS === to a literal (content)  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (o.s === "ab") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(str3) a dynamically-read string is typeof 'string' (tag-5 intact)  [INVARIANT]", async () => {
    // Guards the $BoxedNumber/$AnyString edge: strings must stay tag-5. A CS1 that
    // mis-boxed a string externval tag-6 would flip `typeof` to "object". (The
    // `+`-concat-then-=== path is a *separate* pre-existing residual — its result
    // `.length`/=== reads back 0 today — and is out of CS1's identity scope.)
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (typeof o.s === "string") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(num-lit) a dynamically-read number IS === to a literal (by value)  [INVARIANT: stays 1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { n: 42 };
        return (o.n === 42) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
