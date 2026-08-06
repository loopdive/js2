---
id: 4183
title: "`$AnyValue === nativeString` answers FALSE inline but TRUE through a local — `(a + b) === \"12\"` disagrees with `const g = a + b; g === \"12\"`"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, coercion
language_feature: strict-equality
goal: core-semantics
related: [4178, 1988, 1888, 4173]
discovered_by: ttraenkler/W3-runtime-eval-ternary
origin: "Found while fixing #4178's coerceType/const-fold defects; out of that PR's scope, filed so it is not lost"
---

# #4183 — inline `$AnyValue === nativeString` answers false

## Problem

Strict equality between a boxed-any value and a native string gives **different
answers depending on whether the left operand passes through a local**:

```js
const a = /* any */ "1";
const b = /* any */ 2;

const g = a + b;
g === "12"        // true   ✅
(a + b) === "12"  // false  ❌  same value, same comparison
```

The value is identical. Only its *static representation at the comparison site*
differs — assigned to a local it has been coerced; used inline it is still the
raw `$AnyValue` box that `compileAnyBinaryDispatch` returns.

## Why it matters beyond the one shape

An expression that changes meaning when you introduce a temporary is a
particularly bad class of bug: the workaround (assign to a local) is invisible
in review, and the failing form is the one people write. It also means any
conformance test asserting on an inline concatenation comparison is measuring
the representation, not the semantics.

This is the same family as the defect fixed in #4178 — `coerceType`'s
`ref → ref_null` arm was missing the `$AnyValue` unbox that its three sibling
arms all had. That fix addressed the *assignment* path. The **comparison** path
has the same shape and was deliberately left out of scope there.

## Reproducing

`const g = a + b; g === "12"` vs `(a + b) === "12"` in the standalone lane,
with `a`/`b` reaching the `+` as `any`. #4178's `tests/issue-4178.test.ts`
harness is the closest existing setup.

## Likely root cause

The strict-equality lowering compares an `$AnyValue` box against a native
string reference without unboxing the carrier first — so it compares the box
identity rather than the payload, and always answers false. Compare against
the #1988 split that the fixed `coerceType` arms already honour: *a native
string rides in `externval` (field 4), not `refval` (field 3)*. A comparison
site that does not know that split cannot answer correctly.

Note **#4173 / PR #4157** is concurrently reworking boxed strict-eq dispatch
("fast tag-pair dispatch for boxed strict-eq — no `$AnyValue` allocs on the
identity-miss path"). **Check whether that lands this fix or collides with
it before starting.**

## Acceptance criteria

- `(a + b) === "12"` and `const g = a + b; g === "12"` agree, in all four lanes.
- The same holds for `!==`, and for the reversed operand order.
- No regression on the equivalence baseline; ratchet any newly-fixed rows.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate`, taken above 4172
  because ids 4163–4171 were squatted by the (now closed) PR #4124.
- Sibling filed at the same time: **#4184** (eval-consumer `$AnyValue`/externref
  carrier mismatch), which has a sharper trap — fixing its boxer alone converts
  a wrong answer into a crash.
