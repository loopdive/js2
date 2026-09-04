// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5309 — a child's own instance FIELD is shadowed by the parent's same-named
// METHOD (or accessor) at call sites. `class A { #m(){return 1} }` +
// `class B extends A { #m = () => 2; f(){ return this.#m() } }` returned 1
// where node returns 2, on gc and standalone alike.
//
// Root cause (two independent sites, both required — the plan named only the
// first, and the measurement on the branch showed the public rows still red
// after it):
//   1. `collectClassDeclaration` (src/codegen/class-bodies.ts) aliased
//      `Child_m` → `Parent_m` and added `Child_m` to `classMethodSet`, a
//      PROGRAM-ABI claim that the child HAS that method. Three consumers
//      believed it: the call site's `hasReceiverMember`, `classifyPrivateMember`
//      (which probes `classMethodSet` before `structFields`, so `this.#m = v`
//      raised the §13.15.2 "write to a private method" TypeError), and
//      `resolveReceiverMethodClassName`.
//   2. The ancestor walk in `src/codegen/expressions/call-receiver-method.ts`
//      finds `Parent_m` in `classMethodSet` on its OWN, without the alias. It is
//      guarded for private names but not public ones, so dropping the alias
//      fixed `#m` and left `m` returning the parent's answer.
//
// Every row below is asserted on BOTH lanes (JS-host gc and `target:
// "standalone"`). The rows marked "red on base" were measured wrong on
// origin/main 5a55f7f55f before the fix; the rest are pinned so the fix cannot
// regress them.

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

describe("#5309 a child's own instance field shadows the parent's same-named callable", () => {
  // Row 1 — the issue program. RED ON BASE (was 1).
  pin(
    "row 1: private field `#m = () => 2` beats the parent's `#m()`",
    `class A { #m() { return 1; } }
class B extends A { #m = () => 2; f() { return this.#m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 2 — the public twin. RED ON BASE (was 1). This is why the defect is the
  // inherited-callable lookup, not the `__priv_` mangling.
  pin(
    "row 2: public field `m = () => 2` beats the parent's `m()`",
    `class A { m() { return 1; } }
class B extends A { m = () => 2; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 5 — the callable is two levels up. RED ON BASE (was 1). The grandparent's
  // method reaches the child through the PARENT's inherited alias, so the child's
  // own registration is not enough on its own.
  pin(
    "row 5: child field beats a GRANDparent's method",
    `class G { m() { return 1; } }
class A extends G {}
class B extends A { m = () => 2; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 8 — RED ON BASE: the alias made `classifyPrivateMember` answer "method",
  // so the write raised the §13.15.2 "write to a private method" TypeError and
  // the program trapped instead of returning 3.
  pin(
    "row 8: `this.#m = v` on a shadowing private field is a FIELD write, not a private-method write",
    `class A { #m() { return 1; } }
class B extends A { #m = () => 2; s() { this.#m = () => 3; } f() { this.s(); return this.#m(); } }
export function main(): number { return new B().f(); }`,
    3,
  );

  // Row 9 — the public write twin. RED ON BASE (was 1).
  pin(
    "row 9: `this.m = v` then call resolves to the reassigned field",
    `class A { m() { return 1; } }
class B extends A { m = () => 2; s() { this.m = () => 3; } f() { this.s(); return this.m(); } }
export function main(): number { return new B().f(); }`,
    3,
  );

  // Row 13 — RED ON BASE (was 1). Same alias, reached from outside the class, so
  // the fix has to hold for a non-`this` receiver too.
  pin(
    "row 13: `b.m()` from outside the class, receiver typed as the child",
    `class A { m() { return 1; } }
class B extends A { m = () => 2; }
export function main(): number { const b: B = new B(); return b.m(); }`,
    2,
  );

  // Row 11 — RED ON BASE (was 1). The plan's table recorded this row as already
  // correct; re-measuring it on origin/main 5a55f7f55f showed 1 on both lanes
  // (node: 2). The accessor branch of the inherited registration carries the
  // same false alias as the method branch, so excluding own instance fields
  // there fixes it too.
  pin(
    "row 11: child field beats the parent's GETTER",
    `class A { get m() { return 1; } }
class B extends A { m = 2; f() { return this.m; } }
export function main(): number { return new B().f(); }`,
    2,
  );
});

describe("#5309 rows that were already right — pinned so the fix cannot move them", () => {
  // Row 3 — a child METHOD shadowing a parent private method (criterion 3).
  pin(
    "row 3: child `#m()` shadowing parent `#m()`",
    `class A { #m() { return 1; } }
class B extends A { #m() { return 2; } f() { return this.#m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 4 — no parent member of that name: the callable-field arm always
  // answered this one, which is why it is the proof that the arm is correct and
  // only the alias had to go.
  pin(
    "row 4: child `#m = () => 2` with no parent `#m`",
    `class A { p() { return 9; } }
class B extends A { #m = () => 2; f() { return this.#m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 6 — reading the field into a local first always bypassed the alias
  // (`structFields` is consulted before `classMethodSet` on the READ path).
  pin(
    "row 6: field read into a local, then called",
    `class A { #m() { return 1; } }
class B extends A { #m = () => 2; f() { const h = this.#m; return h(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // Row 7 — a non-callable shadowing field read as a value.
  pin(
    "row 7: `#m = 5` shadowing `#m()`, read as a value",
    `class A { #m() { return 1; } }
class B extends A { #m = 5; f() { return this.#m; } }
export function main(): number { return new B().f(); }`,
    5,
  );

  // Row 10 — STATIC. `ownInstanceFieldNames` is instance-only on purpose: a
  // static field must never stop an instance method of the same spelling from
  // being inherited, and statics travel through `staticMethodSet`.
  pin(
    "row 10: `static m = () => 2` shadowing `static m()`",
    `class A { static m() { return 1; } }
class B extends A { static m = () => 2; }
export function main(): number { return B.m(); }`,
    2,
  );

  // Row 12 — the field must NOT become an own property of the prototype.
  pin(
    "row 12: the shadowing field is not an own key of `B.prototype`",
    `class A { m() { return 1; } }
class B extends A { m = () => 2; }
export function main(): number { return Object.getPrototypeOf(new B()).hasOwnProperty("m") ? 1 : 0; }`,
    0,
  );
});

describe("#5309 shapes the exclusion must NOT capture", () => {
  // `declare m: T` is a pure type re-annotation — it installs no property, so
  // the inherited callable is still the right answer. Excluding it from
  // `ownInstanceFieldNames` is what keeps this row at 1; without the
  // `hasDeclareModifier` guard the call would fall through to an
  // uninitialised struct field.
  pin(
    "a `declare` field re-typing a parent method keeps the inherited method",
    `class A { m() { return 1; } }
class B extends A { declare m: () => number; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    1,
  );

  pin(
    "a static field does not shadow the parent's INSTANCE method of the same name",
    `class A { m() { return 1; } }
class B extends A { static m = () => 9; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    1,
  );

  pin(
    "a child that shadows nothing still inherits the parent method",
    `class A { m() { return 1; } }
class B extends A { x = 7; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    1,
  );

  // A field with no declaration initializer, assigned in the constructor, is
  // still an own property — node answers 2. RED ON BASE (was 1).
  pin(
    "a field assigned only in the constructor still shadows the parent method",
    `class A { m() { return 1; } }
class B extends A { m: () => number; constructor() { super(); this.m = () => 2; } f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );

  // The child's shadowing field must not disturb the PARENT's own private call:
  // `#m` is per-class, so `A`'s body always means `A.#m`. First digit is A's
  // answer through a B instance, second is B's own. RED ON BASE (was 11).
  pin(
    "per-class privates: the parent's own `#m()` still means the parent's",
    `class A { #m() { return 1; } callIt() { return this.#m(); } }
class B extends A { #m = () => 2; f() { return this.#m(); } }
export function main(): number { return new B().callIt() * 10 + new B().f(); }`,
    12,
  );

  // Three levels with an intermediate override: the child's field still wins.
  // RED ON BASE (was 3 — the middle class's method).
  pin(
    "child field beats an intermediate class's override",
    `class G { m() { return 1; } }
class A extends G { m() { return 3; } }
class B extends A { m = () => 2; f() { return this.m(); } }
export function main(): number { return new B().f(); }`,
    2,
  );
});

describe("#5309 out of scope — recorded, unchanged by the fix", () => {
  // A base-TYPED receiver holding a subclass instance. `A_m` is a real method on
  // the static receiver type, so the call resolves before any shadow question is
  // asked. Fixing it needs virtual dispatch over instance fields, which the
  // direct route does not do. node answers 2; js2 answers 1 on base AND after.
  pin(
    "base-typed receiver holding a subclass with a shadowing field still calls the base method",
    `class A { m() { return 1; } }
class B extends A { m = () => 2; }
export function main(): number { const a: A = new B(); return a.m(); }`,
    1,
  );

  pin(
    "a parent method calling `this.m()` dispatches to the parent's own method",
    `class A { m() { return 1; } callIt() { return this.m(); } }
class B extends A { m = () => 2; }
export function main(): number { return new B().callIt(); }`,
    1,
  );

  // A declared-but-never-initialised field was a PRE-EXISTING gap, not #5309's:
  // the control below has NO parent method at all and trapped identically on
  // #5309's base, which is what proved the trap was not caused by the shadow
  // fix. #5312 has since FIXED it — the nullish-comparison and `typeof`
  // observation sites now recognise the slot's null reference as this field's
  // `undefined` — so the row is flipped to node's answer (0) rather than
  // deleted, keeping the #5309 boundary argument on the record. Full analysis:
  // tests/issue-5312-uninitialised-field-reads-undefined.test.ts.
  pin(
    "an uninitialised callable field with NO parent method returns 0 (was a trap; fixed by #5312)",
    `class A { p() { return 9; } }
class B extends A { m!: () => number; f() { return this.m === undefined ? 0 : this.m(); } }
export function main(): number { return new B().f(); }`,
    0,
  );
});
