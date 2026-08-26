---
id: 4710
title: "ES2015 for-of destructuring-head TDZ during receiver evaluation"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
sprint: current
priority: high
es_edition: ES2015
language_feature: for-of-destructuring-head-tdz
task_type: bugfix
goal: test262-conformance
related: [4700, 4702, 4706, 4709]
loc-budget-max: 180
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfArray
---
# #4710 — ES2015 for-of destructuring-head TDZ during receiver evaluation

## Scope

Own only the synchronous, array/vec lowering defect exposed by
`test/language/statements/for-of/scope-body-lex-open.js`: a closure created
while evaluating the receiver of `for (let [x, ...] of receiver)` must capture
the head's uninitialized binding and throw `ReferenceError` when invoked.
The existing declaration-default and statement-body captures are controls, not
new per-iteration machinery.

This slice excludes simple identifier-head TDZ work (#4700, used as a
reference), post-loop restoration (#4709), fresh-binding closure semantics
(#4702), async/for-await, Map/Set collections, iterator-protocol lowering, and
IteratorClose. No changes to those paths are acceptance evidence.

## Exact baseline and controls

Baseline is `upstream/main` `21c94b7075b8522bb771415e009f8db2ef9e78e3`
(2026-08-25) with test262 submodule `b363f29d3c43c626dc852744ad64a0b48a003693`.
The authoritative command is `runTest262File` in a fresh process with the
original harness and a 30-second timeout.

| Row | Baseline | Why it is measured |
| --- | --- | --- |
| `language/statements/for-of/scope-body-lex-open.js` | fail — `probeExpr` does not throw `ReferenceError` | exact target: receiver closure sees the outer `x` instead of the head TDZ binding |
| `language/statements/for-of/scope-body-lex-boundary.js` | pass | direct per-iteration capture control; must remain unchanged |
| `language/statements/for-of/scope-body-var-none.js` | pass | non-lexical for-of control |
| `language/statements/for-of/head-let-bound-names-fordecl-tdz.js` | fail on clean upstream/main | simple-head TDZ integration control owned by #4700; not claimed here |
| `language/statements/for-of/head-const-bound-names-fordecl-tdz.js` | fail on clean upstream/main | same #4700 integration control; destructuring fix must not regress it |

The sibling `scope-body-lex-close.js` is intentionally excluded: its
post-loop outer-binding failure belongs to #4709. Fresh-binding, async,
collection, iterator, and IteratorClose rows are likewise excluded.

## Plan

1. Reproduce the exact row and controls against the pinned baseline before
   source edits, recording statuses and the first observable failure.
2. In the synchronous vec/array for-of path, identify destructuring binding
   names before compiling the receiver. Save surrounding binding descriptors,
   install only a temporary zero-initialized TDZ descriptor for the head, and
   compile the receiver so captured probes retain that descriptor.
3. Tear down the temporary receiver descriptor before the existing destructuring
   iteration/body lowering. Restore saved descriptors on every speculative or
   error exit. Leave simple heads, iterator paths, collections, async paths,
   and post-loop restoration untouched.
4. Run exact target plus direct controls and a bounded compile/type check. Keep
   changed compiler source below 180 lines; record integration with #4700 if
   that branch is not yet in `upstream/main`.

## Acceptance

- Exact `scope-body-lex-open.js` passes through the original Test262 harness.
- `scope-body-lex-boundary.js` and `scope-body-var-none.js` remain passing.
- The simple-head TDZ controls either remain at their clean-baseline status or
  pass when #4700 is integrated; no regression is introduced.
- Excluded post-loop, fresh-binding, async, collection, iterator, and
  IteratorClose behavior is not claimed or modified.
- Changed compiler source is at most 180 lines, latest upstream/main is merged
  without rebase/force-push, and the upstream PR is opened for review (not
  merged by this task).

## Test Results

Baseline recorded before source edits with one fresh process per row:

```text
scope-body-lex-open.js:                       fail — probeExpr did not throw ReferenceError
scope-body-lex-boundary.js:                   pass
scope-body-var-none.js:                       pass
head-let-bound-names-fordecl-tdz.js:         fail — simple-head #4700 control
head-const-bound-names-fordecl-tdz.js:       fail — simple-head #4700 control
```

Candidate validation on the same pinned Test262 checkout:

```text
scope-body-lex-open.js:                       pass
scope-body-lex-boundary.js:                   pass
scope-body-var-none.js:                       pass
head-let-destructuring.js:                    pass
body-dstr-assign.js:                          pass
Focused Vitest (tests/issue-4710.test.ts):    5/5 pass
```

`scope-body-lex-close.js` remains failing as expected and is excluded for
#4709's post-loop restoration. The simple-head #4700 controls remain at their
clean upstream/main failures because #4700 is not included in this PR; no
dependency is required for the destructuring-head row. `prettier --check` is
green. The repository's plain `tsc --noEmit` invocation reports the checkout's
pre-existing Node-global/type errors because its bundler configuration does
not auto-load the available declarations; the equivalent scoped check with
`tsc --noEmit --types node` exits 0.
