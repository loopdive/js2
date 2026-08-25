---
id: 4690
title: "ES2015 standalone for-of destructuring: assign array rest to property references"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
assignee: codex/4690-es2015-forof-destructuring-wave6
priority: medium
horizon: s
feasibility: medium
task_type: conformance
area: codegen, destructuring, for-of
es_edition: es6
goal: standalone-mode
related: [4447, 2602, 2869]
loc-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts
---

# #4690 — for-of assignment-rest property references

## Scope and measured baseline

The supplied standalone snapshot is
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
(timestamp `25.8.2026, 04:31:12`–`04:36:35`, oracle version 13; snapshot file
mtime 2026-08-25 05:27:06).  The bounded slice is exactly four non-passing
official `language/statements/for-of/dstr` rows:

| file | snapshot status/signature |
| --- | --- |
| `array-rest-put-prop-ref.js` | `fail / assertion_fail` — expected rest length/value, observed `0` |
| `array-rest-put-prop-ref-no-get.js` | `fail / assertion_fail` — expected setter result, observed `0` |
| `array-rest-put-prop-ref-user-err.js` | `fail / assertion_fail` — expected setter `Test262Error`, no throw |
| `array-rest-put-prop-ref-user-err-iter-close-skip.js` | `fail / assertion_fail` — expected setter `Test262Error`, no throw |

Count: **4 rows, 4 fail, 0 compile errors, 0 passes** in this slice.  The
current `upstream/main` used for implementation is `eba07b0e8` (2026-08-25).
Faithful `runTest262File(file, "issue-4690", 120000, "standalone")` probes on
that tip reproduce all four failures:

- `array-rest-put-prop-ref.js`: `Expected SameValue(«0», «3») ... x.y.length`
- `array-rest-put-prop-ref-no-get.js`: `Expected SameValue(«0», «3») ... setValue.length`
- `array-rest-put-prop-ref-user-err.js`: expected a `Test262Error`, no exception
- `array-rest-put-prop-ref-user-err-iter-close-skip.js`: expected a `Test262Error`, no exception

The known-good control `array-rest-after-element.js` is a baseline pass on the
same snapshot and current tip; it exercises the already-supported identifier
rest target and guards against changing the ordinary rest slice.

## Root cause hypothesis

`src/codegen/statements/for-of-destructuring.ts` contains the assignment-rest
helpers `emitForOfRestAssignment` (externref/iterator and tuple paths) and
`emitVecRestAssignment` (WasmGC vec path).  The helpers had no member-target
PutValue path, so a property/element target such as `...x.y` was dropped after
the source slice was available (or returned before building the vec slice).
While adding that path, the native vec helper also exposed a second local-stack
bug: it built a fresh vec but did not store it into the temporary that
`emitAssignToTarget` reads, so the member write received null.  As a result the
required §13.15.5.5 PutValue never retained the rest or invoked a setter.  The
`no-get` case confirms the target must be evaluated without reading its current
value, and the final row requires a setter abrupt completion to propagate
without IteratorClose.

## Implementation plan

1. Extend the externref/tuple rest helper to materialize the slice into a temp
   and route property/element targets through the existing `emitAssignToTarget`
   PutValue dispatcher.  Keep identifier and nested-pattern paths byte-stable.
2. Extend the native vec rest helper to materialize the fresh vec into a temp
   and route property/element targets through the same dispatcher.  Preserve
   native slice construction and typed vec identity for identifier targets.
3. Add strict four-row pins plus the passing identifier-rest control to
   `tests/issue-4690.test.ts`.  Require all five to be `pass` in standalone.
4. Re-run focused controls and normal compiler/pre-push gates after merging the
   latest upstream main.

## Risks and non-goals

- This slice covers only array assignment-rest targets that are a direct
  property/element reference.  It does not broaden nested rest patterns,
  defaults on property targets, iterator-close semantics, object-rest targets,
  or binding-form rest.
- `emitAssignToTarget` is the existing member PutValue path; no new getter or
  property-read should be emitted.  A setter throw must remain the active
  abrupt completion and must not be swallowed.
- Keep source growth below 150 LOC and avoid rewriting shared destructuring.

## Acceptance

- The four named rows and `array-rest-after-element.js` pass via the exact
  standalone `runTest262File` seam.
- No baseline-pass control in the focused slice regresses, and the compiler
  typecheck, formatting, focused tests, and normal pre-push checks pass.
- The implementation remains within the intended files:
  `src/codegen/statements/for-of-destructuring.ts`,
  `tests/issue-4690.test.ts`, and this issue record.

## Test Results

- `pnpm exec vitest run tests/issue-4690.test.ts --maxWorkers=1 --minWorkers=1`
  — **5 passed** (four exact standalone pins plus the identifier-rest control).
- Exact `runTest262File(file, "issue-4690", 120000, "standalone")` rows: **4
  before → 4 pass after**; control: **pass before → pass after**.
