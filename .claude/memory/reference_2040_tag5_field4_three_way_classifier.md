---
name: reference_2040_tag5_field4_three_way_classifier
description: "#2040/#2585 tag-5 field-4 is overloaded (string/$BoxedNumber/object); fix = 3-way classifier INSIDE the both-tags-5 arm of __any_eq/__any_strict_eq, numeric branch gated on nativeBoxNumberTypeIdx>=0 only. Stacks on #1883's tag5StringEqThen."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2040 (numeric eq) + #2585 (proto identity): the tag-5 (string) `$AnyValue`
box's field-4 `externval` is OVERLOADED — under tag 5 it holds a genuine string
($AnyString/$NativeString/cons/host), a `$BoxedNumber` (the #1888 −794
"box-the-externref" contract for numbers passing through externref), OR an
object/proto ref. The tag-5 arm of BOTH `__any_eq` and `__any_strict_eq` ran
string-eq unconditionally on the two field-4 externrefs → with #2583's native
`tag5StringEqThen()` arm, `ref.cast $AnyString` TRAPS ("illegal cast") on a
boxed-number/object; pre-#2583 it returned a wrong `0`.

FIX (PR #1888, branch issue-2040-tag5-classifier, stacks on #1883):
`tag5FieldEqDecision()` — a 3-way classifier INSIDE the both-tags-5 arm (shared
by both eq helpers):
1. EITHER field-4 `ref.test $BoxedNumber` → `__any_to_f64` both + `f64.eq`
   (`23===23.0` true; `NaN===NaN` stays FALSE because f64.eq is self-false →
   −788 preserved). Gate ONLY on `ctx.nativeBoxNumberTypeIdx >= 0` (ALWAYS true
   in standalone/wasi — union imports register `$__box_number_struct` before the
   eq helpers build), NEVER on `nativeStrings` (that mis-gate killed sd-3's
   attempt — degenerated to const 0 before the numeric branch).
2. BOTH `ref.test anyStrTypeIdx` → `tag5StringEqThen()` (content-eq, #2583).
3. BOTH `ref.test (ref eq, -19)` → `ref.eq` (#2585 proto-identity).
4. else → conservative `tag5StringEqThen()`.
Also harden `__any_eq`'s cross-tag String⇄Number sub-read (`tag5ToNumber()`):
boxed-number field-4 → `__any_to_f64`, genuine string → `__str_to_number`.

CRITICAL distinction: this is NOT the rejected "numeric-class-gate broadening"
(the 14-regression / 0-improvement verdict recorded in 2040.md) — that admitted
tag-5 into the CROSS-TAG `{2,3}` arm and mis-classified tag-5-vs-tag-2. The
classifier touches ONLY the both-tags-5 arm, so it cannot cause that. arch-tag5
EMPIRICALLY confirmed `nativeBoxNumberTypeIdx >= 0` in pure standalone — sd-3's
"−1" premise (which had motivated a full distinct-boxed-number-tag rep overhaul)
was FALSE; no representation change needed, consumer-side only.

Pre-existing-and-unrelated standalone failures on the #1883 base (verified by
reverting any-helpers.ts — identical fail counts): `issue-1888-any-extern-
roundtrip` (open-any dispatch bridge returns NaN, 5), `issue-1888.test` 2-4-arg
closure (1), `issue-2081` wasi loose-eq (#2043 late-import shift, 10),
`logical-conditional-identity` void→NaN (3). NOT eq-classifier regressions.

Builds on [[reference_2583_any_strict_eq_tag5_host_only]]. MUST be full-baseline
(merge_group) gated — risk is the −788/−794 contracts.
