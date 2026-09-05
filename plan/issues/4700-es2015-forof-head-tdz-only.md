---
id: 4700
title: "ES2015 for-of lexical head TDZ (bounded identifier heads)"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
sprint: current
priority: high
es_edition: ES2015
language_feature: for-of-lexical-head-tdz
task_type: bug
feasibility: medium
goal: test262-conformance
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfArray
---
# #4700 — ES2015 for-of lexical head TDZ (bounded identifier heads)

## Scope

Reconstruct only the bounded synchronous, non-destructuring `for (let/const x
of iterable)` head-TDZ behavior split from blocked #4698. The receiver must be
evaluated while the lexical head binding is uninitialized, so a receiver read
of that name throws `ReferenceError`.

This issue explicitly excludes the fresh-binding rows (their distinct
externref array/function failure is not part of the TDZ mechanism),
`using`/`await using`, async/for-await, destructuring, IteratorClose, and
Map/Set collection paths.

## Candidate evidence from #4698

The #4698 candidate was measured against the pinned test262 checkout and
reported the bounded result: both TDZ rows passed (2/2), and the five controls
below remained green (5/5). The two fresh-binding rows still failed with the
same pre-existing `TypeError: undefined is not a function` at L16 in a clean
upstream/main worktree, establishing a separate externref array/function
problem. #4700 therefore carries only the two TDZ rows and the five controls.

## Exact artifact rows

| Row | Expected behavior |
| --- | --- |
| `test/language/statements/for-of/head-const-bound-names-fordecl-tdz.js` | The `[x]` receiver is evaluated with `const x` in its TDZ and throws `ReferenceError`. |
| `test/language/statements/for-of/head-let-bound-names-fordecl-tdz.js` | The `[x]` receiver is evaluated with `let x` in its TDZ and throws `ReferenceError`. |

## Controls

- `head-const-bound-names-in-stmt.js`
- `head-let-bound-names-in-stmt.js`
- `head-const-init.js`
- `head-let-init.js`
- `scope-body-lex-boundary.js`

## Plan

1. Keep the change in the synchronous array/vec for-of lowering only.
2. For a simple `let`/`const` identifier head, save outer binding metadata,
   install a temporary TDZ state while compiling the receiver, then remove
   that temporary head environment before loop iteration code is emitted.
3. Preserve existing non-lexical, destructuring, iterator, async, collection,
   and fresh-binding paths. Do not add ref-cell/per-iteration machinery here.
4. Restore all outer binding maps after the loop and add focused regression
   coverage only if needed by the existing test262 runner.

## Acceptance

- The exact two TDZ rows pass in the host lane.
- All five listed controls remain green.
- The excluded fresh-binding rows are not used as acceptance evidence.
- No source change exceeds 180 changed source LOC, and excluded feature paths
  remain untouched.
- Scoped checks and normal pre-push checks pass.

## Test Results

Baseline on `upstream/main` `353b88b94`: the exact TDZ rows failed 2/2 because
the receiver read produced no `ReferenceError`; all five controls passed 5/5.
The candidate's focused `runTest262File` host-lane run (including the runner's
strict rerun where applicable) passes the exact two TDZ rows 2/2 and all five
controls 5/5. The implementation changes 88 source lines in
`src/codegen/statements/loops.ts`; fresh-binding rows were intentionally not
used as acceptance evidence.
