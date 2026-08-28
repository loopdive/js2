---
id: 5120
title: "ES2015 Array find/findIndex must throw for Symbol length in standalone"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: high
feasibility: medium
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/codex-5120-es2015-array-find-symbol-length
branch: codex/5120-es2015-array-find-symbol-length
task_type: bugfix
area: codegen
es_edition: es2015
language_feature: array-like-methods
files:
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime.ts
  - tests/issue-5120-es2015-array-find-symbol-length.test.ts
  - plan/issues/5120-es2015-array-find-symbol-length.md
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-enumeration.ts
func-budget-allow:
  - src/codegen/array-prototype-borrow.ts::compileArrayLikePrototypeCall
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---
# #5120 -- ES2015 Array `find`/`findIndex` must throw for Symbol `length`

## Scope and ownership

This issue owns exactly these two current host-pass/standalone-fail rows:

- `test/built-ins/Array/prototype/find/return-abrupt-from-this-length-as-symbol.js`
- `test/built-ins/Array/prototype/findIndex/return-abrupt-from-this-length-as-symbol.js`

The historical broad issue `plan/issues/3592-standalone-vacuous-asserts-arity-and-toplevel-throw.md`
was reviewed for context only. It is not rewritten and this issue does not
claim any of its broader rows.

## Current-main A/B

Measured on fresh `upstream/main` (`b1cc63d1b1fd9d4cd301fa2c3ece9c23e81d6e2d`)
in the dedicated branch `codex/5120-es2015-array-find-symbol-length` on
2026-08-28. The authoritative `runTest262File` runner was used for both lanes;
standalone used a 120-second per-row timeout and emitted no host-free imports.

| exact row | host (`js-host`) | standalone | standalone detail |
| --- | --- | --- | --- |
| `Array/prototype/find/return-abrupt-from-this-length-as-symbol.js` | pass | fail | `Expected a TypeError to be thrown but no exception was thrown at all` |
| `Array/prototype/findIndex/return-abrupt-from-this-length-as-symbol.js` | pass | fail | `Expected a TypeError to be thrown but no exception was thrown at all` |

Both tests construct an object with `length = Symbol(1)` and call the borrowed
method. ECMAScript requires `Get(O, "length")`, then `ToLength`; converting a
Symbol to Number is abrupt, before callback callability checks or iteration.

## Source review and exact implementation plan

The bounded ownership seam is `src/codegen/array-prototype-borrow.ts`, which
lowers borrowed Array-like methods through the native `__extern_length` helper.
That helper is built in `src/codegen/object-runtime-enumeration.ts` for the open
`$Object` arm and in `src/codegen/object-runtime.ts` for closed struct carriers.
Both paths get the `length` property, apply `ToPrimitive`, then use
`__unbox_number`; a native `$Symbol` carrier currently reaches the latter's
opaque-value fallback (`NaN`), and `ToLength(NaN)` becomes zero. The positive
array and numeric array-like paths must remain unchanged.

Implement one narrow native conversion guard for the `$Symbol` carrier in the
open and closed object-array-like `length` arms. Reuse the existing exact
TypeError construction and native Symbol type plumbing; do not make
`__unbox_number` globally reject all opaque values, because valid native
object/array carriers and unrelated numeric coercion behavior depend on that
fallback. In `array-prototype-borrow.ts`, defer the existing `__extern_length`
call only for `find`/`findIndex` until their complete outer argument list has
been evaluated; leave other HOF arms' method-owned argument lowering intact:

1. Complete ArgumentListEvaluation first (predicate, `thisArg`, and any extra
   expressions are evaluated exactly once, in order; a later abrupt expression
   wins).
2. Convert the receiver to object as today.
3. Read `length` once and perform `ToLength`; a Symbol length throws the exact
   `TypeError` before predicate callability or any callback invocation.
4. Leave the existing find/findIndex loop and all valid array and numeric
   array-like behavior intact.

The existing syntactic non-callable callback arm is extended only to unwrap
TypeScript casts around literal `null`/`undefined`, so its length-before-
callability ordering remains testable without weakening the runtime callable
fallback for arbitrary identifiers or object carriers.

Add `tests/issue-5120-es2015-array-find-symbol-length.test.ts` with:

- exact `TypeError` identity for `find` and `findIndex`;
- one length getter assertion (called once), callback-not-called and
  non-callable-callback controls proving length conversion precedes callback
  checks;
- argument evaluation/side-effect controls proving predicate, `thisArg`, and
  extra expressions are evaluated once and a later abrupt expression wins;
- a dynamic Symbol carrier when the standalone provider supports it;
- positive real-array and numeric array-like find/findIndex controls;
- mandatory host and standalone controls with zero standalone imports;
- optional execution of the exact corpus rows under an existence guard, with a
  Vitest timeout above the runner's 120-second ceiling.

The focused test must not import standalone-only helpers or the test262 corpus
unconditionally.

## Acceptance

- Both exact rows pass in host and standalone lanes.
- The focused regression test passes, including all ordering, identity,
  getter/callability, side-effect, dynamic-Symbol, positive-control, and
  no-import assertions.
- No unrelated test262 row changes status in the relevant targeted lane.
- Typecheck, lint, formatting, ratchets, and the required standalone/host
  focused checks pass with at most two workers and `SKIP_SLOW_PRECOMMIT=1`.
- No standalone imports are emitted by the regression fixture.

## Handoff

Keep this plan `status: in-progress` until the root agent reviews the branch and
opens the single non-draft upstream PR. Push every implementation and
verification checkpoint to `ttraenkler/js2`; do not open a PR from this branch.
The handoff should include source-review findings, exact A/B and regression
commands/results, full-gate results, clean worktree status, branch/head SHA, and
any blockers.
