---
id: 4723
title: "ES2015 for-of assignment-rest property setter receives the rest value without a getter"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
assignee: codex/4723-es2015-forof-rest-property-setter
priority: medium
horizon: s
feasibility: medium
task_type: conformance
area: codegen, destructuring, for-of
es_edition: es6
language_feature: for-of-assignment-destructuring
related: [4690, 4715, 4720, 4944]
loc-budget: 180
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
---

# #4723 — for-of array assignment-rest property setter must not read the target

## Scope and live baseline

The exact assembled `runTest262File` seam was run on `upstream/main` commit
`778e4ae0f4c58562551b8de7172e1d02dfeb86d8` (2026-08-25) with pinned
`pnpm@10.30.2`. The bounded residual is the one row whose rest target is a
property reference with a throwing getter and a setter that records the value:

| file | host/GC | standalone | observed signature |
| --- | --- | --- | --- |
| `language/statements/for-of/dstr/array-rest-put-prop-ref-no-get.js` | **fail** | pass | host setter receives `undefined`; expected rest length `3` |

The three sibling rows from the already-landed property-rest implementation
pass in both lanes: `array-rest-put-prop-ref.js`,
`array-rest-put-prop-ref-user-err.js`, and
`array-rest-put-prop-ref-user-err-iter-close-skip.js`. Passing property-reference
controls required by #4715/#4720 also remain green in both lanes:
`array-rest-put-prop-ref.js` and `array-elem-put-prop-ref.js`. The ordinary
identifier-rest control `array-rest-after-element.js` passes in both lanes.

`Depends on #4944`: no. The residual plus passing property-reference controls
were checked in both lanes against `upstream/pr-4944`; the dependency branch
still fails the host residual, while its controls pass. This branch therefore
starts directly from `upstream/main`.

## Root cause hypothesis

`emitForOfRestAssignment` now materializes the externref rest slice and routes a
property target through `emitAssignToTarget`, which is the right no-get shape.
The host accessor callback was the remaining mismatch: TypeScript inferred the
unannotated setter parameter as an `i32`, so `compileArrowAsCallback` exposed a
scalar Wasm parameter. `__extern_set_strict` correctly supplied the JS array,
but the host-to-Wasm call then coerced that array through the scalar ABI before
the setter stored it. Standalone uses the native closure path and does not hit
this host callback ABI.

## Implementation plan

1. Keep rest materialization and PutValue unchanged, and trace the host
   callback ABI through `compileArrowAsCallback` and the accessor literal path.
2. Add an accessor-setter-only option that declares callback parameters as
   `externref`, preserving arbitrary values crossing `__extern_set_strict` while
   leaving getter, ordinary callback, and standalone closure paths unchanged.
3. Add an exact focused test pin for the residual plus the passing property-ref
   controls from #4715/#4720 and the identifier-rest control. Require host and
   standalone outcomes explicitly.
4. Re-run the exact host+standalone matrix, focused Vitest test, TS5/TS7,
   typecheck, targeted/full lint, format, and pre-push checks. Keep compiler
   source growth at or below 180 lines and do not broaden into element no-get,
   object-rest, or iterator-close families.

## Acceptance

- `array-rest-put-prop-ref-no-get.js` passes in host/GC and standalone.
- The sibling property-rest rows and #4715/#4720 property-reference controls
  remain passing in both lanes.
- The setter is called without a getter read, receives a three-element rest,
  and setter errors still propagate without an unintended inner IteratorClose.
- Focused, compiler, formatting, lint, and pre-push gates pass with no unrelated
  source changes.

## Implementation

Host accessor setters now opt into an externref callback parameter ABI. This
preserves the value supplied by `__extern_set_strict` when the setter parameter
would otherwise be inferred as a scalar, while typed reference parameters still
receive their normal local conversion. The option is passed only for object
literal setters; getters, ordinary callbacks, and standalone closures are
unchanged. Source delta: 10 lines.

## Test Results

- Exact baseline on `upstream/main`: residual `host=fail`,
  `standalone=pass`; all six focused controls passed in both lanes.
- Dependency check on `upstream/pr-4944`: same residual/control result, so no
  `Depends on #4944` stack is needed.
- Exact post-fix host + standalone matrix: 12/12 pass.
- Focused `tests/issue-4723.test.ts`: 12/12 pass.
- `pnpm@10.30.2 run typecheck:ts5`: pass.
- `pnpm@10.30.2 run typecheck:ts7`: pass.
- `pnpm@10.30.2 run lint`: exit 0.
- `pnpm@10.30.2 run format:check`: pass.
