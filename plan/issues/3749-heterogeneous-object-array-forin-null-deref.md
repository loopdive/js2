---
id: 3749
title: "for...in over an array element throws 'dereferencing a null pointer' when the array holds object literals of DIFFERENT shapes"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: for-in
goal: core-semantics
origin: "tests/dogfood/clsx-harness.mjs (#3748) op_array_of_objects — clsx@2.1.1's clsx([{a:true,b:false},{c:true}]) throws 'dereferencing a null pointer' at runtime; reduced to a minimal repro fully independent of clsx"
related: [3748, 3747, 1710, 3716]
---

# #3749 — heterogeneous object-literal shapes in an array crash `for...in`

## Repro (fully independent of clsx)

```js
export function inlineHeterogeneous() {
  var arr = [{ a: true }, { c: true, d: false }];
  var out = "";
  for (var i = 0; i < arr.length; i++) {
    var obj = arr[i];
    for (var k in obj) {
      if (obj[k]) {
        if (out) out += " ";
        out += k;
      }
    }
  }
  return out;
}
```

Compiles clean (`success: true`), binary validates, instantiates — throws
`dereferencing a null pointer` when called. Expected: `"a c"` (native JS
gives this).

## Isolation — the precise trigger

Confirmed via 5 variants compiled/run independently (all same shape:
array literal of 1-2 object literals, `for...in` over each array
element, no function-call/recursion needed — narrowed all the way down
from the original clsx repro, which DID go through an extra function
call + recursion layer, to this direct inline form):

| array literal | result |
| --- | --- |
| `[{ a: true, b: false }]` (single object) | OK |
| `[{ a: true }, { b: true }]` (two objects, **same shape**: 1 key each) | OK — `"a b"` |
| `[{ a: true, b: false }, { c: true, d: false }]` (two objects, **same shape**: 2 keys each) | OK — `"a c"` |
| `[{ a: true, b: false }, { c: true }]` (two objects, **different shapes**: 2 keys then 1 key) | **THROWS** |
| `[{ a: true }, { c: true, d: false }]` (two objects, **different shapes**: 1 key then 2 keys) | **THROWS** |

The rule is exact: **an array literal containing two or more object
literals whose property sets differ in shape (different keys/key count)
crashes when `for...in`-ed by index; same-shaped object literals in the
array, or a single object, do not.**

This is a **silent-until-called** bug — `compile()` succeeds, the binary
validates and instantiates without error; it only throws when the actual
heterogeneous-shape code path executes, meaning it can slip through
without being caught unless the exact combination of shapes is exercised
at runtime.

## Hypothesis (not verified against actual codegen — next step)

Each distinct object-literal shape almost certainly compiles to its own
concrete Wasm GC struct type (matches this project's general
struct-per-shape object representation). An array of `object`-typed
elements presumably stores each element as some common
supertype/externref, and `for...in` presumably needs to recover the
concrete struct type (and its `__struct_field_names` mapping) at each
element to enumerate keys. When two DIFFERENT concrete shapes appear as
elements of the SAME array, something in that per-element type recovery
— a `ref.cast` to a single expected struct type inferred from only ONE
of the literal shapes seen at the array's construction site, most
likely the first — fails to handle the second, differently-shaped
element and derefs null instead of correctly dispatching per-element.
Worth checking whether the array's element type gets over-narrowed to
one specific object shape instead of the general object/`any` supertype
when TypeScript infers the array literal's type from multiple distinct
object literal expressions.

## Relationship to #3747

Different bug, found in the same npm-package-testing session (via the
new clsx dogfood harness, #3748) — #3747 is about closures lost through
object-property reassignment; this one is about `for...in` over
heterogeneously-shaped array elements. No known shared root cause, but
both are in the "object/array shape representation" area of the
compiler and both are silent-wrong/silent-throw rather than caught at
compile time — worth keeping in mind they may turn out related once
someone actually reads the codegen.

## Scope

- [ ] Trace the actual codegen for an array literal whose elements are
      object literals of different shapes, specifically what type gets
      inferred/emitted for the array's element slot and what happens at
      the `for...in`/property-enumeration site when a concrete element's
      runtime shape doesn't match that inferred type.
- [ ] Fix so `for...in` (and likely also plain property access,
      `obj[k]`) works correctly regardless of whether array siblings
      share a shape.
- [ ] Regression test pinning the minimal repro table above (both
      crashing and non-crashing cases, to lock in the fix without
      breaking the already-working same-shape cases).
- [ ] Re-run `pnpm run dogfood:clsx` — `op_array_of_objects` should flip
      from `compiled-threw` to `equal` once fixed.

## Acceptance criteria

- [ ] `inlineHeterogeneous()` above returns `"a c"` instead of throwing.
- [ ] All 5 repro-table variants produce correct output (no regression
      in the already-working same-shape/single-object cases).
- [ ] `tests/dogfood/clsx-harness.mjs`'s `op_array_of_objects` op
      diffs `equal` against native clsx.
- [ ] Equivalence/regression test added and passing.
