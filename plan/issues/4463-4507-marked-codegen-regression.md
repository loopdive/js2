---
id: 4463
title: "regression: 044b8d09 (#4507 marked watchdog) broke 7 gc-lane tests + grew the null_deref trap ratchet 140→142 — three independent codegen defects"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
assignee: claude/es6-standalone-session
priority: high
horizon: s
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
related: [4444, 2025, 4447]
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
---

# #4463 — #4507's codegen changes regressed 7 passing tests + 2 traps

## What happened

Merge `6756ed8c` (PR #4507, "npm-compat marked watchdog") contained commit
**`044b8d09`** ("fix(marked): bound upstream compilation and preserve class
object shapes") which, despite the npm-compat title, changed 17 codegen files.
It flipped 7 previously-passing gc-lane test262 tests and grew the #3189
null_deref uncatchable-trap ratchet 140→142. The merge-group gate then
mis-attributed these to PR #4567 (its baseline predated `6756ed8c`); #4567's
wave emits byte-identical wasm for every affected test.

Bisect evidence (dev-4567-cifix, 2026-08-15): first-parent bisect over
`f92a9aa6..e1d84f3d` pins `6756ed8c`; inner bisect pins `044b8d09`; parent
`57228240` is clean. Full matrix with wasm shas in the fix PR and the
session record.

## Three independent defects (one per regression family)

1. **`closed-method-dispatch.ts` `collectMethodEntries`** — replaced the
   exact-arity check with "omitted formal has any default marker". But
   `buildEntryArm` can only fabricate a callee-recognisable "absent" value for
   a CONSTANT default or an `f64` slot (sNaN sentinel); every REFERENCE slot
   degrades to `ref.null.extern`, indistinguishable from an explicit null, so
   the callee skips its default. Probed: `method(tokens=[1,2])` under-applied
   binds null (`tokens.length` → NaN) — #4507's marked "fix" was receiving a
   wrong value, not a fix. Regressed: `meth/gen-meth/async-gen-meth-dflt-obj-
   ptrn-empty.js`.
2. **`literals.ts`** — deleted the `semanticProviders === "native-first"` gate
   on spread materialization, extending eager struct→open-`$Object` snapshot
   copying to the HOST lane, breaking getter-mutation evaluation order.
   Regressed: `spread-obj-manipulate-outter-obj-in-getter.js` ×3
   (array/new/super-call).
3. **`closures/method-trampolines.ts` `coerceTrampolineThisSlot`** — guard
   compared `ValType.kind` only, missing the `ref_null <S>` → `ref <S>`
   nullability-only case, so it emitted a null-eliminating cast over #2025's
   deliberate `ref.null` passthrough → uncatchable null_deref trap.
   Regressed: `super-access-inside-a-private-method.js` (pass→trap) and
   `private-method-get-and-call.js` (fail→trap, the second ratchet growth).

## Fix (this PR)

Forward fix in the same 3 files (+87/−20) + 11 guards in
`tests/issue-4447-mg-regressions.test.ts` (8 fail on unfixed base). Proof: all
7 tests pass on gc with wasm shas byte-identical to the pre-regression
baseline; `private-method-get-and-call` back to its non-trap failure at exact
baseline sha (`2c8f2b58c1ea`, ratchet 142→140); zero delta base-vs-fixed on
the #4444 wave's four scoped suites; equivalence gate clean.

## Carried consequences / follow-ups

- **The arity relaxation is REVERTED, not repaired**: marked's under-applied
  `inline(text)` call returns to the host fallback. A correct version needs a
  reference-typed "absent" sentinel or callee-side default evaluation —
  follow-up for whoever owns npm-compat/marked; do not re-land the relaxation
  without that design. `classMemberFuncKey` (the other #4507 codegen change)
  is untouched.
- **Measurement-basis discrepancy to reconcile**: the #4447 record quotes gc
  `for-of/dstr` 395/569 (official wrapper, in-worktree); the fix lane's driver
  measures 49 (pre-#4507) / 74 (current main) on the same filter. Base==fixed
  so it does not gate this PR, but the two bases differ by the wrapper's
  strict-rerun rows (same class as the #4445 92-vs-108 correction) — worth a
  measurement-tooling note next time the number is load-bearing.

## Cross-lane outcome (2026-08-15, post-merge reconcile)

The /workspace lane diagnosed and fixed the same regression in parallel:
**#4466** (PR #4579, `bda75c6a7`) repaired the dispatch-arity and literals-gate
defects and **#4469** (PR #4581, `87cf253a2`) the trampoline nullability — both
landed on main while this lane's PR #4582 was in flight. Reconciliation: main's
versions adopted for `closed-method-dispatch.ts`/`literals.ts` (semantically
equivalent policies); `method-trampolines.ts` keeps both guards (this lane's
externref-only early return + #4469's same-carrier-family check — compatible,
defensive). This PR's surviving unique contribution: the 11 regression guard
tests (`tests/issue-4447-mg-regressions.test.ts`, all green on the merged
tree), this bisect/root-cause record pinning `044b8d09` specifically, and the
marked-revert consequence note. Duplicate-diagnosis cost note for the retro:
both lanes independently ran the same bisect within hours — the auto-park
comment's "same signature on another PR ⇒ drift" hint was the missed
cross-check that would have linked the two efforts earlier.
