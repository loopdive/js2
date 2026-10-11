---
id: 6852
title: "Host `__call_<method>` dispatch on an object-literal struct calls the shared shape method, not the instance's per-literal fork — its promoted captures read null"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: objects, closures
goal: npm-library-support
related: [4526, 4618]
---

# Problem

Two Redux `createStore.spec.ts` rows (`should pass an integration test with
no unsubscribe` / `… with an unsubscribe`) trap with
`RuntimeError: dereferencing a null pointer at __anon_<N>_next`.

The test passes an observer literal into a JS-library method that invokes it
dynamically:

```ts
const results: any[] = []
observable.subscribe({ next(state: any) { results.push(state) } })
// redux: observerAsObserver.next(getState())   (dynamic, host-bridged)
```

Measured on the generated harness module (WAT of
`.redux-upstream-suite-generated/test/probe-obs.ts`, 2026-10-05):

- Every `{ next(state) { … } }` literal with the same shape dedups to ONE struct
  type `$__anon_16`, and the method body is FORKED per literal
  (`$__anon_16_next__lit2097380`, `…lit2097481`, …), each reading its OWN
  promoted capture global (`__captured_results` #759, #765, …), which that
  literal's frame `global.set`s right before `struct.new`.
- The host-facing dispatcher `__call_next` (what `closureBridge` invokes for a
  dynamic `o.next(x)` on a Wasm struct) tests `ref.test (ref $__anon_16)` and
  then calls the SHARED `$__anon_16_next` — whose body reads global #757, set
  only by the first-compiled (and, after the re-compile passes, dead) frame.
  So every later literal's method runs against a null capture.

A single-literal fixture does not reproduce (the shared function IS that
literal's body); it needs two same-shape literals capturing a same-named local,
as every `it(...)` body of a test file does.

# Implementation Plan

1. In the `__call_<name>` dispatcher emission (`src/codegen/index.ts`, the
   per-method-name host dispatch; find via the `__call_${name}` consumer in
   `src/runtime.ts` ~3724/9118), when the struct type carries a FIELD of that
   name holding the per-instance method closure (`$next (mut externref)`
   above — `struct.new 106 … extern.convert_any` stores the fork's closure),
   dispatch through the field value (`__call_fn_method_N` with the receiver)
   instead of the shape-level method function.
2. Alternatively record the fork on the instance at `struct.new` time
   (`ctx.objectLiteralMethodFuncIdx` already maps literal → fork) and have the
   dispatcher read it; option 1 needs no new state.
3. Regression: two-file fixture, two same-shape observer literals in two
   arrow bodies each capturing `const results`, invoked from a `.js` library
   through `obj.next(v)`; Node oracle comparison as in
   `tests/issue-4526-redux-wave10.test.ts`.

# Acceptance criteria

- [ ] Both Redux observable integration rows pass; Redux suite does not drop.
- [ ] No new host import; standalone lane unchanged (scoped test262 on
      `language/expressions/object/method-definition`).
