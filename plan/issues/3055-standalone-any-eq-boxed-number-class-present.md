---
id: 3055
title: "Standalone `any === any` on boxed numbers returns equal-for-unequal when an object-runtime/class is present"
status: ready
updated: 2026-07-17
model: fable
fable_role: spec
sprint: current
created: 2026-07-05
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: strict-equality, any-boxing, standalone
es_edition: ES2015
test262_category: (broad — numeric equality)
goal: standalone-mode
related: [3054, 3056]
---

# #3055 — Standalone boxed-number strict-equality miscompiles when a class is present

## Summary

In the **standalone / WASI lane**, `a === b` where both operands are `any`-typed
(tag-boxed) **numbers** returns the WRONG result — it answers _equal_ for
**unequal** numbers — **when the module also defines a class** (or otherwise
pulls in the object-runtime / tag machinery). Two boxed numbers `1` and `2`
compare `===` as `true`. This is a real correctness miscompile that affects **user
programs**, not just the test harness — it was _discovered_ via the harness (see
#3054 measurement-integrity finding) but is not harness-specific.

## Reproduction (all on `upstream/main`, `--target standalone`)

Verified via `compile(src, { target: "standalone" })` + `instantiateWasm`:

```ts
function eq(a: any, b: any): number {
  return a === b ? 1 : 0;
}
export function test(): number {
  return eq(1, 2);
} // → 0 (CORRECT, no class)
```

```ts
// The SAME with a class in the module regresses through the harness path:
// via the real test262 wrapTest, `assert.sameValue(1, 2)` returns test()=1 (PASS)
// in standalone but 2 (FAIL) in host. Bisection: removing the unconditionally
// injected `class Test262Error { ... }` from the wrapped source flips standalone
// 1 → 2. So: class present + any-boxed numeric `===` → equal-for-unequal.
```

- **Minimal `eq(1,2)` + a class** did NOT reproduce in isolation — the trigger
  needs the fuller module shape the harness produces (class + the `isSameValue`/
  `assert_sameValue` nest + the other `any`-param shims). The **robust, stable
  repro** is: the real `tests/test262-runner.ts#wrapTest` output for
  `assert.sameValue(1, 2)`, compiled `--target standalone`, returns `test()=1`;
  delete `class Test262Error` → returns `2`. (Transcript in the #3054 discussion.)
- **String** operands are unaffected: `assert.sameValue("a","b")` → 2 (FAIL) in
  both lanes. Only the boxed-**number** `===` path miscompiles.

## Suspected root cause (for the architect)

The object-runtime / tag allocation (registered when a class exists) perturbs the
**tag-boxed number strict-equality** path — likely the tag-5/tag-6 boxed-primitive
`===` arm (see memory `reference_1629b_boxed_primitive_typeof_eq_layers`,
`reference_2040_tag5_field4_three_way_classifier`, `reference_2583_any_strict_eq_tag5_host_only`).
The hypothesis: with an object-runtime present, two boxed f64s route through a
ref-identity / same-tag arm that answers identity (or a vacuous constant) instead
of unboxing and comparing the f64 values. Needs a WAT-level trace of `any === any`
on two boxed numbers with vs. without a class registered, to find the diverging arm.

## Why this matters

- **User-program correctness**: any standalone program that compares two
  `any`/`unknown`-typed numbers with `===` (or `!==`) in a module that also has a
  class can silently get the wrong answer.
- **Measurement integrity**: it is the mechanism behind the standalone floor NOT
  enforcing numeric assertions (#3056) — a large fraction of numeric-heavy
  standalone "passes" are vacuous because the harness's `isSameValue` rides this
  path. Fixing #3055 is the _correct_ fix; #3056 (harness `_num` routing) only
  sidesteps it.

## Acceptance criteria

- `eq(a: any, b: any) => a === b` returns the correct result for two boxed numbers
  in standalone **regardless of whether the module defines a class**.
- The real `wrapTest` output for `assert.sameValue(1, 2)` returns `test()=2`
  (FAIL) in standalone, matching host.
- No regression to boxed-string / boxed-object / mixed `===` (tag-5/6 arms).
- **Coordinated with #3056**: enforcing numeric asserts will turn currently-vacuous
  numeric standalone "passes" into honest FAILS → the `host_free_pass` floor DROPS.
  This is a deliberate measurement RE-BASELINE (the floor gate would auto-park it
  as a false regression) and a **human decision** — do NOT land unilaterally under
  the autonomous loop. See #3056.

## Root cause (traced on upstream/main b3fa4a082c)

The bug is in the **`any`-equality operand seam**, not in `__any_strict_eq`'s
body. `emitAnyEqOperands` (`src/codegen/coercion-engine.ts`) marshals each
operand of `a === b` into the `(ref null $AnyValue)` shape the helper takes. For
an operand that did NOT naturally produce an `$AnyValue` — i.e. a bare
`externref` (an `any` param reads as `externref` in standalone) — it called
`coerceType(externref → $AnyValue)`. That path's externref default
(`value-tags.ts` line ~213) is the **#1888 tag-5 "string" lie**:
`return emit("__any_box_string")`. So a **boxed NUMBER** (`$BoxedNumber`
externref produced by `__box_number`) was wrapped as a **tag-5 string** box.

Two such operands then hit `__any_strict_eq` with tagA=tagB=5 → the guarded
**tag-5 string-content arm** → it answers `equal-for-unequal` for two numbers:
`isSameValue(1, 2)` returns `1`. Every numeric `assert.sameValue` in the
standalone harness rides this exact path (`isSameValue(a: any, b: any)` →
`a === b`), so every numeric assertion was **vacuous** — it could never fail.

**Why a class flips it**: without a class the module keeps `a === b` on the IR
path, which lowers the comparison with the honest tag machinery inline (correct).
With a class/object-runtime present the function demotes to the legacy AST path
(`compileAnyBinaryDispatch` → `emitStrictEq` → `emitAnyEqOperands`), which is the
buggy seam. WAT bisection: with-class `isSameValue` emits
`call $__any_box_string` (×2) then `call $__any_strict_eq`; without-class it
inlines the correct numeric arm.

Direct proof on the legacy path (harness shape), unequal number pairs:

| case            | before | after |
| --------------- | ------ | ----- |
| isSameValue(1,2)| 1 (WRONG) | 0 ✓ |
| isSameValue(1.5,2.5)| 1 (WRONG) | 0 ✓ |
| isSameValue(100,200)| 1 (WRONG) | 0 ✓ |
| isSameValue(3,3)| 1 ✓ | 1 ✓ |

## Fix

`emitAnyEqOperands` now recovers an `externref` operand's runtime tag via
`__any_from_extern` (the tag-classifying helper the loose-eq externref tail —
`emitAnyEqFromExternTemps` — already uses) instead of the blind
`coerceType`→`__any_box_string`. The **default (non-honest) `__any_from_extern`
already** classifies `$BoxedNumber` → tag-3 and `$BoxedBoolean` → tag-4
honestly; only its string/object fallback keeps the tag-5 wrap **byte-for-byte**.
So the fix repairs boxed numbers (and bools, and null → tag-1) while leaving
string-content equality, object-operand equality, and the #3037 tag-6 identity
carrier **unperturbed** (an object operand is a `ref`, not `externref`, and never
enters this arm; an object *externref* keeps the same tag-5 fallback). Guarded to
standalone/wasi (`__any_from_extern` is `undefined` in host mode → host lane keeps
`coerceType`, so host-lane `===` and all equivalence tests are untouched).

Bonus: closed two `#3037` `getPrototypeOf`-stored-in-`any`-local gaps (a null
externref now boxes tag-1, so `null === null` → 1, the correct answer). See the
updated `tests/issue-3037-cs1c-getprototypeof-carrier.test.ts`.

Regression test: `tests/issue-3055-numeric-any-eq-class.test.ts`.

## ⚠️ DO NOT LAND WITHOUT #3056 (floor re-baseline + human sign-off)

This fix DE-VACUIFIES numeric asserts → previously-vacuous numeric standalone
"passes" become honest FAILS → the `host_free_pass` floor DROPS. The merge_group
floor gate will (correctly) read that as a regression and auto-park the PR. The
PR is opened with `hold` + `do-not-merge` and MUST be coordinated with the #3056
re-baseline under human decision. Measured floor-drop magnitude is reported on
the PR.
