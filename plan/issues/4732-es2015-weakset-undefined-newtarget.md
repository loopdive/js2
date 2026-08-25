---
id: 4732
title: "ES2015 WeakSet rejects calls without new"
created: 2026-08-25
updated: 2026-08-25
status: done
priority: medium
depends_on: []
es_edition: es2015
language_feature: WeakSet constructor NewTarget validation
task_type: bug
completed: 2026-08-25
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-4732.test.ts
---

# #4732 — ES2015 `WeakSet` undefined-`NewTarget` / call-without-`new`

## Scope

Close the remaining ES2015 Test262 residual in
`test/built-ins/WeakSet/undefined-newtarget.js`. The test has two independent
call-without-`new` cases: `WeakSet()` and `WeakSet([])`. Both must throw a
`TypeError`, while constructor controls (`new WeakSet()` and
`new WeakSet([])`) must continue to construct successfully. WeakMap and Set
controls are included to guard the shared builtin-constructor dispatch.

The exact pinned upstream Test262 file is present at:
`test262/test/built-ins/WeakSet/undefined-newtarget.js` (ES2015 source; its
frontmatter cites §23.4.1.1 step 1, “If NewTarget is undefined, throw a
TypeError exception”).

## Baseline (upstream/main)

Measured from upstream/main commit `21d7d893d` on 2026-08-25 before source
changes with `TEST262_PATH_FILTER=test/built-ins/WeakSet/undefined-newtarget.js`
and one focused shard:

| Lane | Result | Error signature | Host imports |
| --- | --- | --- | --- |
| host (`TEST262_TARGET=gc`) | 0/1 pass, 1/1 fail | `other: Expected a TypeError to be thrown but no exception was thrown at all` | 44 dynamic/runtime imports (expected host lane) |
| standalone (`TEST262_TARGET=standalone`, interpreter refusal provider) | 0/1 pass, 1/1 fail | `assertion_fail: Test262Error: Expected a TypeError to be thrown but no exception was thrown at all` | no import-leak row; execution reached the assertion |

The standalone QuickJS provider was not used because this environment cannot
resolve its GitHub build dependency; the interpreter refusal provider is
appropriate for this test because it does not exercise dynamic evaluation.
The committed report names this file in the Map/Set/Weak collections residual,
but that aggregate is not a per-file verdict.

## Plan

1. Reproduce the exact Test262 file on both host and standalone targets and
   record its per-file verdict/error text.
2. Trace the WeakSet identifier-call and `new WeakSet(...)` lowering on current
   main, comparing minimal WeakMap/Set constructor and call controls.
3. Add the narrowest constructor-call guard/fix, preserving native iterable
   construction and host imports where required.
4. Add focused equivalence tests with positive and negative controls, then run
   the exact focused host/standalone lanes plus TS5/TS7/typecheck/lint/format/
   hooks checks.

## Test Results

Measured against the pinned upstream baseline above after the narrow guard:

| Check | Result |
| --- | --- |
| Focused Vitest (`tests/issue-4732.test.ts`) | 6/6 passed across host and standalone lanes |
| Test262 host (`TEST262_TARGET=gc`, run `20260825-212209`) | 1/1 passed; expected host dynamic imports remained (44 imports) |
| Test262 standalone (`TEST262_TARGET=standalone`, interpreter refusal provider, run `20260825-212814`) | 1/1 passed; no host-import leak |
| Standalone QuickJS provider | Not run: this environment cannot resolve its GitHub build dependency; the interpreter refusal provider is sufficient for this non-eval test |
| Prettier format check | Passed |
| Biome lint (`--diagnostic-level=error`) | Passed (existing non-error diagnostics suppressed by the configured diagnostic limit) |
| TypeScript 5 and 7 | Passed |
| LOC/function budgets, oracle ratchet, coercion-site ratchet | Passed with the change-scoped grants above |

The source delta is 42 added lines and one import-format adjustment. The guard
only intercepts an ambient bare `WeakSet` call; constructor forms and shadowed
bindings retain their existing lowering.
