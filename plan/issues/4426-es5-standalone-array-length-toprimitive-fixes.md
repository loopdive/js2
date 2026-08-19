---
id: 4426
title: "ES5 standalone: array-length write lane + ToPrimitive closure-dispatch conformance fixes"
status: done
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
goal: standalone-gap
sprint: 78
es_edition: ES5
task_type: bug
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/literals.ts
  - src/codegen/type-coercion.ts
  # concat reflective body: all logic lives in the NEW string-proto-concat.ts
  # subsystem module; these +11 lines are dispatch wiring + the param-slots
  # table entry, which are by definition dispatch-site edits.
  - src/codegen/array-object-proto.ts
func-budget-allow:
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/type-coercion.ts::coerceType
coercion-sites-allow:
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/vec-length-set.ts
---

# #4426 — ES5 standalone: array-length write lane + ToPrimitive closure-dispatch conformance fixes

## Problem

Four independent defects clustered in the ES5 standalone failure list
(`benchmarks/results/test262-standalone-current.json`, buckets
`object-property-semantics` / `array-typedarray-buffer` /
`object-to-primitive`), together worth ~10+ es5id-tagged tests plus
non-ES5 collateral:

1. **`arr.length = n` receiver trap after evolving reassignment.** The
   static length-set lowering (`expressions/assignment.ts`) typed the
   receiver local with the checker's *flow-typed* vec (`$__vec_f64` after
   `x = [0]`), while an evolving `var x = []` global is *stored* as
   `$__vec_externref`. The local-set-coerce repair then emitted a sibling
   `ref.cast` that always traps: every `x.length = n` after reassignment
   died with `illegal cast` (test262 `S15.4.5.1_A1.3_T1` family).

2. **`arr.length = <non-number>` skipped ToNumber.** Wrapper objects,
   strings, booleans and null either no-oped (dynamic `__extern_set` arm:
   bare `__unbox_number`, no ToPrimitive) or stored garbage (static lane:
   value fell to the local-set-coerce repair). Spec (§10.4.2.4 step 3 /
   ES5 §15.4.5.1) applies ToUint32(ToNumber(value)) with a RangeError on
   invalid lengths (`S15.4.5.1_A1.3_T1/T2`, `S15.4.5.1_A1.1_T2`).

3. **`new Array(x)` / `Array(x)` single non-Number argument.** §23.1.1.1
   step 5 (ES5 §15.4.2.2): a single argument is a LENGTH only when it is
   a Number; otherwise the result is the one-element array `[x]`.
   Both lowerings unconditionally length-coerced with an f64 hint
   (`S15.4.2.2_A2.3_T1–T5`).

4. **ToNumber valueOf closure dispatch null-deref.** Zero-capture closure
   wrapper structs canonicalize structurally to ONE runtime type, so
   `ref.test closureTypeIdx` passing does not prove the stored funcref has
   that candidate's signature. Two same-shaped object literals assigned to
   one var made the inline valueOf dispatch (type-coercion.ts) hit a
   funcref-signature miss, where the guarded cast manufactured `ref.null`
   into `ref.as_non_null` → `dereferencing a null pointer` at module init
   (`S9.1_A1_T1`, `S8.12.8_A3`, `S15.10.6.2_A4_T12` and the rest of the
   null-deref-in-`__module_init` bucket).

## Fix

- `assignment.ts` length-set: receiver local + `struct.set` now use
  `$__vec_base` (length is field 0 of the shared supertype — every
  concrete vec upcasts safely); non-numeric values coerce through the
  real ToNumber chain (`coerceType → __to_primitive + __unbox_number`)
  and then get the §10.4.2.4 RangeError validation.
- `vec-length-set.ts` dynamic arm: value goes through
  `__to_primitive("number")` before `__unbox_number` when the standalone
  object runtime is present (both funcs already exist at finalize — no
  minting, no funcidx shift).
- `new-indexed.ts` / `literals.ts`: single argument with a *provably*
  non-number static tag (`ctx.oracle.staticJsTypeOf ≠ number/mixed`)
  builds the one-element externref-vec array; `mixed`/number keep the
  historical length lowering.
- `type-coercion.ts` valueOf dispatch: a funcref-signature miss inside a
  matched closure-struct candidate now falls through to the next
  candidate (mirrors the documented eqref-path rule) instead of trapping.

## Verification

- `S15.4.5.1_A1.3_T1/T2`, `S15.4.5.1_A1.1_T2`, `S15.4.2.2_A2.3_T1/T4/T5`,
  `S9.1_A1_T1`, `S8.12.8_A3`, `S15.10.6.2_A4_T12` flip fail→pass under
  `--target standalone` (runner-verified locally).
- `tests/es5-standalone-array-filter.test.ts` green;
  `tests/issue-2679-toprimitive-this.test.ts` /
  `tests/es5-array-new-filter-holes.test.ts` failures reproduced at the
  merge-base (pre-existing, one of them fixed by this change-set).

## Coercion-sites note

The two `coercion-sites-allow` entries are new CALL SITES of the existing
engine helpers (`__to_primitive` in the vec length arm, `__extern_toString`
in the compound-assign wrapper miss arm) — no fresh
ToString/ToNumber/ToPrimitive matrix is introduced; both routes delegate to
the #1917/#2108 engine's canonical implementations.

## LOC-budget note

`loc-budget-allow` covers the three god-files above: the fixes live at
the existing length-set / valueOf-dispatch sites and are comment-heavy
per house style; net growth is +26/+19/+13.
