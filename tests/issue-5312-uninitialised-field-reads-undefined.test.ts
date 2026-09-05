// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5312 — a class field that is DECLARED but never given a value (`m!: T`,
// `m?: T`) is installed by `useDefineForClassFields` holding `undefined`, but
// its WasmGC slot's construction default is a null reference and the checker
// reports the declared type, which does not admit `undefined`. Every
// observation folded against the declaration instead of the value:
//
//     class A { p() { return 9; } }
//     class B extends A { m!: () => number; f() { return this.m === undefined ? 0 : this.m(); } }
//     new B().f();     // node: 0     js2 before this fix: TRAPPED in `this.m()`
//
// The fix is (b) from the issue's criterion 2 — the OBSERVATION sites learn
// that this slot's null IS its `undefined` — not (a), mapping the slot to a
// real `undefined` value at the read site. (a) is not implementable on the
// standalone lane at all: a boxed field there is an `externref` whose only
// absent inhabitant is `ref.null`, and minting a distinct `undefined` needs the
// `__get_undefined` HOST import, which standalone must not take. See the
// module comment on `src/codegen/uninitialised-field-undefined.ts`.
//
// Rows marked "RED ON BASE" were measured on origin/main 2ca2591652 with the
// three touched files reverted; the value base produced is named on each. The
// rest are pinned so the fix cannot regress them. Every row runs on BOTH lanes
// (JS-host gc and `target: "standalone"`) unless its comment says why not.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile `source` on one lane and call its exported `main`. */
async function runLane(source: string, lane: "gc" | "standalone"): Promise<unknown> {
  const result = lane === "standalone" ? await compile(source, { target: "standalone" }) : await compile(source);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const imports = lane === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, () => unknown>;
  (imports as { setExports?: (e: unknown) => void }).setExports?.(exports);
  return exports.main!();
}

/** Pin one program's answer on both lanes. */
function pin(label: string, source: string, expected: unknown): void {
  for (const lane of ["gc", "standalone"] as const) {
    it(`${label} [${lane}]`, async () => {
      expect(await runLane(source, lane)).toBe(expected);
    }, 60_000);
  }
}

/** Pin one program's answer on the JS-host lane only, with the reason stated. */
function pinGcOnly(label: string, source: string, expected: unknown): void {
  it(`${label} [gc]`, async () => {
    expect(await runLane(source, "gc")).toBe(expected);
  }, 60_000);
}

describe("#5312 an uninitialised declared class field reads as undefined", () => {
  // ---------------------------------------------------------------- the issue
  // Row 1 — the issue program verbatim. RED ON BASE (trapped: the guard was
  // false, so the else arm ran `call_ref` on the null slot).
  pin(
    "row 1: issue program — a guarded call on `m!: () => number` returns 0",
    `class A { p() { return 9; } }
class B extends A { m!: () => number; f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // Row 2 — the same shape with no parent at all. The issue names this as the
  // control proving the defect is independent of #5309's inherited-method
  // alias. RED ON BASE (trapped).
  pin(
    "row 2: same guard with no base class",
    `class B { m!: () => number; f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // Row 3 — `?` rather than `!`. The trigger is the MISSING INITIALIZER, not
  // the definite-assignment assertion. RED ON BASE (trapped).
  pin(
    "row 3: `m?: () => number` guards identically",
    `class B { m?: () => number; f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // Row 4 — the private twin. #5309's lesson is that a public/private split in
  // this area is itself a defect; the predicate resolves both. RED ON BASE
  // (trapped).
  pin(
    "row 4: private `#m!: () => number` guards identically",
    `class B { #m!: () => number; f(): number { return this.#m === undefined ? 0 : this.#m(); } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // ------------------------------------------- criterion 2: all four forms
  // Form 1 — `=== undefined`. Covered by rows 1–4; the negation is pinned here.
  // RED ON BASE (`!== undefined` was 1).
  pin(
    "form 1: `this.m !== undefined` is false",
    `class B { m!: () => number; f(): number { return this.m !== undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // The value is `undefined`, NOT `null`, so the strict null comparison must be
  // false. RED ON BASE (was 1 — the boxed route reduced to a bare `ref.is_null`
  // that could not tell the two apart).
  pin(
    "form 1b: `this.m === null` is false — the installed value is undefined",
    `class B { m!: () => number; f(): number { return this.m === null ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // Form 2 — `typeof`. RED ON BASE (folded to the declared type's "function").
  pin(
    'form 2: `typeof this.m === "undefined"`',
    `class B { m!: () => number; f(): number { return typeof this.m === "undefined" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // RED ON BASE (was 0).
  pin(
    'form 2b: `typeof this.m !== "function"`',
    `class B { m!: () => number; f(): number { return typeof this.m !== "function" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // The comparison must not swing the other way: an uninitialised field is not
  // an object either. Green on base; pinned.
  pin(
    'form 2c: `typeof this.m === "object"` is false',
    `class B { m!: () => number; f(): number { return typeof this.m === "object" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // The STRING-producing `typeof` arm, not just the comparison arm. gc only:
  // a standalone `main` returning a string hands JS a native string array,
  // which reads back as `undefined` regardless of the value. RED ON BASE
  // (was "function").
  pinGcOnly(
    'form 2d: `typeof this.m` evaluates to the string "undefined"',
    `class B { m!: () => number; f(): string { return typeof this.m; } }
export function main(): string { return new B().f(); }`,
    "undefined",
  );

  // Form 3 — `== null`. Already correct on base (a null reference is loosely
  // nullish either way); pinned so the fix cannot break it.
  pin(
    "form 3: `this.m == null` is true",
    `class B { m!: () => number; f(): number { return this.m == null ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // Form 4 — `?.()` short-circuits to `undefined`. gc only, and NOT because of
  // this issue: an optional call on a boxed class field emits the host imports
  // `__call_function` / `__get_undefined` / `__js_array_new` even under
  // `target: "standalone"`, so the standalone module cannot instantiate. That
  // is unrelated to initialisation — a CONSTRUCTOR-ASSIGNED field of the same
  // type emits the same three imports (measured 2026-09-04). Pre-existing on
  // base; recorded in the issue's `## Landed` section as a separate gap.
  pinGcOnly(
    "form 4: `this.m?.()` is undefined",
    `class B { m!: () => number; f(): number { return this.m?.() === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // ------------------------------------------------- the runtime, not a fold
  // The emitted test is a runtime `ref.is_null`, so BOTH sides of a later write
  // are correct with no flow analysis. RED ON BASE (was 0 — the fold said "not
  // undefined" before the write too).
  pin(
    "runtime: a method's own write flips the field from undefined to callable",
    `class B { m!: () => number; f(): number { const before = this.m === undefined ? 1 : 0; this.m = () => 4; const after = this.m === undefined ? 1 : 0; return before * 10 + after; } }
export function main(): number { return new B().f(); }`,
    10,
  );

  // The same, through `typeof`. RED ON BASE (was 1 — "function" both times, so
  // the first probe read 0).
  pin(
    "runtime: `typeof` flips undefined -> function across a method write",
    `class B { m!: () => number; f(): number { const a = typeof this.m === "undefined" ? 1 : 0; this.m = () => 1; const b = typeof this.m === "function" ? 1 : 0; return a * 10 + b; } }
export function main(): number { return new B().f(); }`,
    11,
  );

  // ------------------------------------------------------- receivers & shapes
  // RED ON BASE (was 0). The receiver need not be `this`.
  pin(
    "shape: an uninitialised field read off a plain instance receiver",
    `class B { m!: () => number; }
export function main(): number { const b = new B(); return b.m === undefined ? 1 : 0; }`,
    1,
  );

  // RED ON BASE (was 0). The slot is declared on the PARENT.
  pin(
    "shape: an inherited uninitialised field read from a subclass method",
    `class A { m!: () => number; }
class B extends A { f(): number { return this.m === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // A struct-ref (rather than boxed) carrier: an object-typed field.
  // RED ON BASE (was 0).
  pin(
    "shape: an uninitialised object-typed field `o!: { a: number }`",
    `class B { o!: { a: number }; f(): number { return this.o === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // RED ON BASE (was 0).
  pin(
    'shape: `typeof` of an uninitialised object-typed field is "undefined"',
    `class B { o!: { a: number }; f(): number { return typeof this.o === "undefined" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // A string field's coverage is PARTIAL and context-dependent, so both halves
  // are pinned. This half reaches the fixed nullish arm. gc only (string-
  // returning `main`, see form 2d). RED ON BASE (was "d").
  pinGcOnly(
    "shape: an uninitialised string field compares equal to undefined",
    `class B { s!: string; f() { return this.s === undefined ? "u" : "d"; } }
export function main(): string { return new B().f(); }`,
    "u",
  );

  // ------------------------------------------------------- criterion 3 controls
  // Every row below was ALREADY correct on base and must not move.
  pin(
    "control: a field WITH an initializer is its initializer's value",
    `class B { m: () => number = () => 7; f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    7,
  );

  pin(
    "control: a field assigned in the constructor is callable",
    `class B { m!: () => number; constructor() { this.m = () => 7; } f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    7,
  );

  pin(
    'control: `typeof` a constructor-assigned field is "function"',
    `class B { m!: () => number; constructor() { this.m = () => 1; } f(): number { return typeof this.m === "function" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // `declare m: T` installs NO property, so the inherited callable stays
  // visible through it. The predicate excludes `declare` for exactly this row.
  pin(
    "control: `declare m: T` keeps the inherited method visible",
    `class A { m() { return 9; } }
class B extends A { declare m: () => number; f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    9,
  );

  // A field whose annotation admits `null` can hold a REAL JavaScript null,
  // which shares `ref.null` with the uninitialised default. The predicate
  // excludes it, so all three of node's answers are preserved.
  pin(
    "control: explicit `= null` — `=== undefined` stays false",
    `class B { m: (() => number) | null = null; f(): number { return this.m === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  pin(
    "control: explicit `= null` — `== null` stays true",
    `class B { m: (() => number) | null = null; f(): number { return this.m == null ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  pin(
    'control: explicit `= null` — `typeof` stays "object"',
    `class B { m: (() => number) | null = null; f(): number { return typeof this.m === "object" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // Truthiness was already right (a null reference is falsy) and must stay.
  pin(
    "control: `if (this.m)` on an uninitialised field is falsy",
    `class B { m!: () => number; f(): number { if (this.m) { return 1; } return 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // ----------------------------------------------- known divergences, PINNED
  // These are NOT fixed here. They are pinned at the compiler's current answer
  // so a future change to them is a deliberate, visible edit rather than silent
  // drift. Each names node's answer and why it is out of this issue's scope.

  // node: `undefined`, so this would be 1. A NUMERIC slot's construction
  // default is `0`, not the f64 `undefined` sentinel — `FieldDef.
  // undefinedDefault` is minted only for `?` + f64, never for `!`. Extending it
  // changes numeric field STORAGE for every `x!: number` in the codebase, which
  // is a wider change than this issue's `## Out of scope` allows.
  pin(
    "known divergence: `n!: number === undefined` is false (node: true) — numeric slots default to 0",
    `class B { n!: number; f(): number { return this.n === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // node: `undefined`, so this would be 1. Same numeric-slot reason.
  pin(
    'known divergence: `typeof this.n` is not "undefined" for `n!: number` (node: it is)',
    `class B { n!: number; f(): number { return typeof this.n === "undefined" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // node: `undefined`, so this would be 1. Binding the read to a LOCAL first
  // detaches it from the field declaration, and the local carries the null
  // reference itself. Answering here needs the read site to MINT a real
  // `undefined` — option (a), which standalone cannot do without a host import.
  pin(
    "known divergence: a field read bound to a local compares as null, not undefined (node: undefined)",
    `class B { m!: () => number; f(): number { const v = this.m; return v === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // node: `undefined`, so this would be 1. `m?: T`'s declared type ALREADY
  // admits undefined, so `typeof` never folds — it takes the runtime `__typeof`
  // helper, which classifies a null reference as "object". A different site
  // from the fold this issue fixes; deliberately not widened, because the
  // guard chain nulls `staticTypeof` for many unrelated soundness reasons and
  // firing on all of them would undo those guards.
  pin(
    'known divergence: `typeof this.m` for `m?: T` is not "undefined" (node: it is)',
    `class B { m?: () => number; f(): number { return typeof this.m === "undefined" ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // node: "u". The SAME program with an explicit `f(): string` return
  // annotation takes the string-specialised binary path instead of the nullish
  // arm this issue fixes, so it still answers "d" — a fourth observation site,
  // outside the issue's shape (which is a CALLABLE field). Pinned so the split
  // is visible rather than surprising. gc only (string-returning `main`).
  pinGcOnly(
    'known divergence: an annotated `f(): string` string-field compare still answers "d" (node: "u")',
    `class B { s!: string; f(): string { return this.s === undefined ? "u" : "d"; } }
export function main(): string { return new B().f(); }`,
    "d",
  );

  // node: 1. The numeric-coded twin of the row above, same fourth site.
  pin(
    "known divergence: a numeric-coded string-field compare is false (node: true)",
    `class B { s!: string; f(): number { return this.s === undefined ? 1 : 0; } }
export function main(): number { return new B().f(); }`,
    0,
  );

  // node: 6. A parameter property (`constructor(public m: () => number)`) does
  // not reach a callable slot at all. Identical on base — measured 2026-09-04,
  // both lanes 0 with the three touched files reverted — so this pin records a
  // pre-existing gap, not a regression from this change.
  pin(
    "known divergence: a callable parameter property is not callable (node: 6) — pre-existing, unchanged",
    `class B { constructor(public m: () => number) {} f(): number { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B(() => 6).f(); }`,
    0,
  );
});
