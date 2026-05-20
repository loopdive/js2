---
id: 1524
sprint: backlog
title: "test262 harness: TypedArray `ctors` fixture not visible in resizable-buffer tests"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: test-runner
language_feature: test262-harness, typed-array
es_edition: n/a
test262_category: built-ins/Array/prototype, built-ins/TypedArray
test262_count: 202
related: []
---

# #1524 — `ctors` fixture not exposed in resizable-buffer test262 tests

## Problem

202 test262 tests fail with `ctors is not defined`. All of them are
resizable-ArrayBuffer iteration tests for `Array.prototype.*` /
`TypedArray.prototype.*`, which include the shared harness file
`resizableArrayBufferUtils.js`. That helper declares a top-level
`var ctors = [...]` listing the typed-array constructors to iterate
over. Our test262 runner appears to either:

1. fail to inline the helper into the compiled module,
2. inline it but lose the `var` binding because of unified-module
   scoping, or
3. compile the helper, but mark `ctors` as an unresolved external
   when the test body references it.

## Failing test examples

- `test/built-ins/Array/prototype/every/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findLastIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/forEach/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/indexOf/coerced-searchelement-fromindex-shrink.js`

Error (all identical):

```
L49:3 ctors is not defined
```

## Investigation hints

- `harness/resizableArrayBufferUtils.js` in the test262 worktree —
  inspect what the file declares.
- Compare with how `assert.js` / `sta.js` are included. They appear to
  reach test bodies fine (other top-level decls work).
- The fact that line `49` / `41` is consistent across hundreds of
  tests suggests the helper compiles but its top-level `var` does not
  reach the test export scope.

## Acceptance criteria

- The 5 example tests above compile and execute at least to their
  first assertion (pass or assertion-fail, not `ctors is not defined`).
- No new compile errors elsewhere.

## Estimated impact

**202 test262 fails** unblocked — many will still fail downstream on
resizable-buffer semantics, but converting CE → assertion fail makes
the underlying gaps visible for follow-up.
