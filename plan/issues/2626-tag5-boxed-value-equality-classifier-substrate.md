---
id: 2626
title: "tag-5 boxed-VALUE equality classifier (numeric #2040 f64.eq + object #2585 ref.eq) — value-rep substrate (deferred from #1888)"
status: backlog
assignee: ""
sprint: Backlog
created: 2026-06-22
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, value-rep
language_feature: equality, ===, boxed numbers, object identity, destructuring defaults
goal: test262-conformance
related: [2040, 2585, 2580, 2579, 2583, 2141, 3032]
---

## ROOT CAUSE CORRECTED + ARMS LANDED FLAG-GATED (2026-07-04, #2141 S2 — fable-tag5)

**The premise below ("the dstr/generator lowering implicitly relied on the
legacy always-false tag-5 eq") is DISPROVEN.** WAT trace of the canary
module: the only `__any_strict_eq` callers are the test262 harness's three
`isSameValue` sites — no dstr/iterator lowering touches the eq helpers. The
real chain: (1) the dstr fixture `var iter = function*(){ iterations+=1 }()`
is an anonymous generator EXPRESSION → eager-buffer path → **body runs at
creation**, `iterations` is already 1 (probe-verified); (2) the legacy tag-5
non-string eq (`0`) makes lie-boxed values SELF-unequal (fake NaN), so
`isSameValue(a,b) = a===b || (a!==a && b!==b)` is vacuously TRUE for every
lie-boxed pair, masking the latent failure; (3) each classifier arm closes
the vacuity escape → the −162 is UNMASKING, not breakage. See #2141 S2 and
#3032 for the full evidence + the lazy-first-resume fix (zero-param wave
landed; canary green with the arms force-enabled).

**Status now:** BOTH arms (numeric `f64.eq` + object `ref.eq`) are IN-TREE
inside the both-tags-5 arm of `__any_eq`/`__any_strict_eq`, gated on
`tag5ValueEqClassifier` (CompileOptions, default OFF;
`JS2WASM_TAG5_CLASSIFIER=1` env defaults it on for runner A/B). The 4
formerly-skipped cases in `tests/issue-2040-tag5-field4-eq.test.ts` run
with the flag. Remaining scope of THIS issue = flip the default ON, gated
on the #3032 waves (method generators W4 is the known residue — the
24-sample flip delta is 4 unmaskings / 2 fixes, all `gen-meth-*` shapes)
and the merge_group standalone floor A/B. Also note the S2 discovery: the
cross-tag cell (tag-5 `$BoxedNumber` × honest tag-2/3 equal numbers →
wrongly unequal) is NOT covered by the both-tags-5 classifier and needs its
own slice.

# #2626 — tag-5 boxed-VALUE equality classifier (numeric + object arms) — substrate-blocked

## Problem

The standalone `$AnyValue` tag-5 box's `externval` (field 4) is overloaded: under
tag 5 it can hold a genuine string, a `$BoxedNumber` (the #1888 −794
"box-the-externref-as-tag-5" contract), or a non-string GC object/closure. The
tag-5 arm of `__any_eq` / `__any_strict_eq` (`src/codegen/any-helpers.ts`) currently
routes to the GUARDED native string-content compare (`tag5StringEqThen()`,
`ref.test $AnyString`-gated, `0` for non-strings) — which LANDED in #1888 and banks
#2579 boxed-string `===` + #2583 search.

Two equality cases remain WRONG for non-string tag-5 boxes (they fall to the `0`
fallback today):

1. **Numeric (#2040):** two boxed NUMBERS through `$AnyValue` — `23 === 23.0`,
   `a !== a` after a numeric op, boxed-number `===` boxed-number — should compare
   `__any_to_f64(a) == __any_to_f64(b)` (with `f64.eq` preserving `NaN===NaN`
   false / −788). Today they hit the string fallback → wrong.
2. **Object identity (#2585):** two boxed eqref OBJECTS —
   `getPrototypeOf(Object.create(p)) === p`, `o === o` — should compare `ref.eq`
   (reference identity). Today they hit the string fallback → wrong.

## Why it is substrate-blocked (the #1888 eject)

#1888 first shipped a `tag5FieldEqDecision` 3-way classifier adding exactly these
two arms (numeric `f64.eq`, object `ref.eq`). It **EJECTED from the merge_group on
the standalone-highwater floor (#2097): −162 standalone**, all in the
class / class-dstr / generator-destructuring cluster.

**Root cause (bisected, faithful runner standalone).** Canary
`language/statements/class/dstr/meth-dflt-ary-ptrn-empty`: the empty
`ArrayBindingPattern : [ ]` default (`method([] = iter)`) must NOT iterate the
generator default — `iterations === 0`. With the classifier active it iterates
(0→2). The destructuring / generator-iterator lowering compares tag-5 boxed VALUES
through `__any_eq` / `__any_strict_eq` and **implicitly relied on the legacy
always-false tag-5 non-string equality** (main's `i32.const 0` stub). Making the
numeric (`f64.eq`) OR object (`ref.eq`) arm return a *correct* (non-zero) answer
flips a comparison the dstr machinery counted on, corrupting the default-application
/ iteration-guard decision.

Bisection proof (re-runnable):
- Restore #1864's `ref.test $AnyString` guard on `tag5StringEqThen` (LANDED in
  #1888) → dstr canary PASSES, string-eq + search preserved.
- Re-enable ONLY the classifier (numeric arm with `i32.and` gating AND object arm
  removed) → dstr canary RE-BREAKS. So **the numeric `f64.eq` arm ALSO regresses
  dstr**, not only the object `ref.eq` arm — both are blocked by the same
  dstr-iterator-protocol dependency.

## Scope / approach (architect-spec-first)

This is NOT a point-fix on the eq helper. The dstr / generator-iterator lowering
must stop depending on the legacy always-false tag-5 non-string equality before the
numeric/object arms can be turned on. That dependency lives in the value-rep
substrate — the same uniform-externref / tag-aware-reader work tracked by
**#2580 M3/M4 (#35)**. Land this only WITH (or after) that substrate, and validate
via the **merge_group standalone floor** (#2097) — broad-impact value-rep, NEVER a
scoped sweep (the #1888 eject was missed by a scoped equality A/B because the −162
is a DIFFERENT cluster; see `project_broad_impact_validate_full_ci`).

Deliverables when unblocked:
- numeric arm: BOTH field-4 `$BoxedNumber` (`i32.and`) → `__any_to_f64` + `f64.eq`;
- object arm: BOTH field-4 non-null eqref (`ref.test (ref eq)`) → `ref.eq`;
- re-enable the 4 `it.skip`ped cases in `tests/issue-2040-tag5-field4-eq.test.ts`
  (marked `DEFERRED #2580 M2`);
- merge_group floor must clear net-positive with the dstr cluster GREEN.

## Provenance

Deferred out of the reshaped **#1888** (merged 2026-06-22). The guarded string arm
(#2579/#2583) landed; this captures the two value-equality arms that ejected. See
the `## RESHAPE LANDED` + `## Merge_group EJECT + root-cause` sections in
`plan/issues/2040-standalone-generator-dstr-runtime-semantics.md`, and memory
`project_2040_tag5_classifier_dstr_default_regression`.
