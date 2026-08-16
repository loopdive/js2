---
id: 4525
title: "Moment: every generated upstream module fails validation — closure struct.new receives i32 where a ref-typed capture field is expected"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures
goal: npm-library-support
related: [4384, 3996, 3995]
files:
  - src/codegen/closures.ts
  - src/codegen/closures/arrow-phases.ts
  - tests/dogfood/moment-upstream-suite.mjs
---

# Moment: closure capture field typed `(ref null N)` receives an i32 at `struct.new`

## Problem

The pinned Moment 2.30.1 upstream slice (6 selected test files, 10 callbacks)
is **0/10 in Wasm on current main** because **all six generated modules fail
`WebAssembly.compile()` validation** with one consistent defect — a closure
allocation passes an `i32` where the capture struct's field is a reference:

```text
CompileError: WebAssembly.compile(): Compiling function #1115:"__closure_296"
failed: struct.new[5] expected type (ref null 72), found local.get of type i32
```

Measured 2026-08-16 on `a9b20d4c` (local run reproduces the npm-compat CI card
bit-for-bit: 0/10). Per-module: `days_in_year` (`__closure_296`), `is_date`
(`__closure_298`), `is_moment` (`__closure_301`), `min_max` (`__closure_297`),
`mutable` (`__closure_297`), `normalize_units` (`__closure_296`) — always
capture field **[5]**, always `(ref null 72)` vs `i32`, in a `__closure_*`
allocation. All six modules *emit* successfully (`success: true`,
~630–660 KB); only validation fails, so no callback ever runs.

## Relationship to #4384

#4384's 2026-08-13 checkpoint measured **6/6 modules compile AND validate,
10/10 Node, 10/10 Wasm** — on its remediation branch. That work has not merged
(`git log origin/main --grep="#4384"` is empty). Current main fails earlier
than #4384's resolver problem: the module never instantiates, so the
declaration-pairing defect #4384 describes is masked. Whoever picks this up
should first check whether the #4384 branch already fixes the capture typing
(its final remediation touched exactly this area: "async resume frames …
name-remapped capture sources", "captures written after a declaration use a
live cell").

## Reproduction

```bash
node --import tsx tests/dogfood/moment-upstream-suite.mjs --json
# compile.details[*].validationError — all six modules
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce first.** Extract the smallest of the six modules
   (`.moment-upstream-suite*/generated/src/test/moment/days_in_year.*`) and
   bisect the source by halving until the `struct.new[5]` mismatch reproduces
   in a standalone `.tmp/` file. The suspect shape, given field index 5 and
   one consistent closure per module, is a lifted closure capturing a mix of
   scalar (i32-storage) and reference locals where the capture *plan* and the
   capture *emission* disagree on one slot's storage class — i.e. the plan
   said "boxed/ref cell" (field type `(ref null 72)`) but the allocation site
   pushes the raw i32 storage value.
2. **Locate the disagreement**: `planClosureCaptures`
   (src/codegen/closures/arrow-phases.ts) decides field types;
   `compileLiftedClosureBody` / the `struct.new` emission in
   src/codegen/closures.ts pushes capture values. Compare the code paths for a
   capture that is (a) written after declaration (live-cell rule from #4384's
   notes) or (b) an i32-storage boolean/int local captured into a ref-cell
   field. The fix belongs at the emission site: coerce/box the pushed value to
   the planned field type, or make the plan record the raw storage class it
   will actually push — whichever direction the existing invariants support.
   Do NOT special-case Moment.
3. **Bisect main if the reduction stalls**: #4384's checkpoint proves a
   branch existed where all six validated. `git bisect` between that
   checkpoint's merge-base and current main with
   `node --import tsx tests/dogfood/moment-upstream-suite.mjs --json | jq .compile.validated`
   (expect 6 → 0 flip) pins the regressing merge; /bisect-regression has the
   protocol.
4. **Validation gates**: (a) reduction compiles+validates and runs correct in
   `.tmp/` probe; (b) moment harness reports 6/6 validated (pass count may
   still be limited by #4384's resolver issue — record whatever it is, do not
   claim 10/10 unless measured); (c) equivalence tests + scoped closure tests
   (`npm test -- tests/issue-4384-merge-group-regressions.test.ts` and the
   closure suites); (d) `pnpm run check:ir-fallbacks` no unintended growth.

## Acceptance criteria

- [ ] All six generated Moment modules validate on main.
- [ ] The reduced closure-capture shape is a committed regression test.
- [ ] Moment upstream slice pass count recorded in this file (Node 10/10 must
      hold; Wasm count depends on #4384's unmerged resolver fix).
