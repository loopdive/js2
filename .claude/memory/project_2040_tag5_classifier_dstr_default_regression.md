---
name: project_2040_tag5_classifier_dstr_default_regression
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

PR #1888's unified tag-5 field-4 equality arm (in `src/codegen/any-helpers.ts`)
EJECTED from merge_group on the standalone-highwater floor (#2097): pass 24771 vs
floor 24883 = **−162 standalone**, all in the class / class-dstr / generator-
destructuring cluster. Rolling regr-gate passed (net+0); the absolute floor caught
it. Bisected on the live worktree (faithful runner standalone, canary
`language/statements/class/dstr/meth-dflt-ary-ptrn-empty`: empty `[]=generatorDefault`
must NOT iterate; clean main PASS, #1888 iterations 0→2).

**RESHAPE that lands (lead+user approved, 2026-06-22):**

1. **KEEP (FIX1) — Native string-eq (`tag5StringEqThen`):** #1888's `recoverNative`
   does `ref.cast $AnyString` on field-4 with NO `ref.test` guard (#1864's original
   HAD it; the refactor dropped it). On a non-string tag-5 field-4 (a boxed generator
   the dstr default `undefined`-check compares) the cast traps/mis-answers. **Restore
   the `ref.test $AnyString` guard on BOTH operands → else `i32.const 0`.** The guard
   ALONE fixes the dstr canary AND banks #2579 boxed-string `===` + #2583
   `Array.prototype.{indexOf,…}.call`. Also makes #1883 landable (NOT the stale
   "−1970 catastrophe"; that was an old framing).

2. **DEFER the WHOLE `tag5FieldEqDecision` classifier** — NOT just the #2585 object
   arm. **CRITICAL CORRECTION:** the **#2040 numeric `f64.eq` arm ALSO regresses
   dstr.** Changing `i32.or`→`i32.and` on the numeric gate was necessary but NOT
   sufficient — bisection proof: re-enabling ONLY the classifier (with `i32.and`
   numeric gating AND the objectEq arm removed) STILL re-breaks the dstr canary. So
   both the numeric (`f64.eq`) and object (`ref.eq`) arms change tag-5 boxed-VALUE
   equality the dstr / generator-iterator lowering implicitly relied on (it counted
   on the legacy always-false tag-5 non-string eq). Both DEFER to the value-rep
   substrate (#2580 M2 / #35); architect-spec-first. The cross-tag String⇄Number
   `tag5ToNumber` arm in `__any_add` is dstr-SAFE and STAYS.

**Disposition that lands:** guarded string arm only → banks #2583 search + #2579
boxed-string-eq, fixes the −162, net-positive (+2/0 in-cluster A/B). Both #2040
numeric-eq and #2585 proto-identity → #2580 M2 follow-up. `it.skip` the 4 classifier
cases in `tests/issue-2040-tag5-field4-eq.test.ts` (#2580 ref); fold
`tests/issue-2579.test.ts` (8 cases) so closing #1864 loses no coverage.

**Why it slipped the PR gate:** floor runs ONLY in merge_group
([[project_standalone_floor_only_on_merge_group]]); the equality-cluster scoped
A/B was +N/0 but the −162 is a DIFFERENT cluster — the
[[project_broad_impact_validate_full_ci]] scoped-sweep blind spot. PITFALL: a
hand-written minimal repro hit a SEPARATE pre-existing `__str_flatten`
f64.convert_i32_s invalid-wasm that ALSO reproduces on clean main — trust the
faithful `runTest262File`, not a hand-rolled minimal repro. Related:
[[project_brand_check_swap_savedbodies]].
