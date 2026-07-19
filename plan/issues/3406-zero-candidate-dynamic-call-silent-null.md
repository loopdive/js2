---
id: 3406
title: "Dynamic any-callee with zero closure candidates silently returns null instead of invoking or throwing"
status: ready
created: 2026-07-18
updated: 2026-07-18
priority: critical
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: dynamic-call
goal: correctness
sprint: current
related: [2939, 2940, 3335, 1858]
origin: "2026-07-18 codebase engineering audit (plan/log/2026-07-18-codebase-engineering-audit.md, F1)"
---

# #3406 — zero-candidate dynamic calls silently return `null`

## Problem

A real JS function passed through an `any` parameter is silently not called when
the current module has no registered closure-wrapper candidates:

```ts
export function test(f: any): any {
  return f(2);
}
```

Verified on `origin/main` at `852c40a9`: compilation succeeds and the Wasm
validates, but invoking `test((x) => x + 1)` returns `null` instead of `3`.

This is a silent miscompile, not a diagnostic-quality issue. Argument side
effects still execute, while callee side effects and the return value disappear.
A non-callable value likewise takes the synthesized-`null` path instead of throwing a
catchable `TypeError`.

## Root cause

`tryEmitInlineDynamicCall` derives closure arms from
`ctx.closureInfoByTypeIdx`. At
`src/codegen/expressions/calls.ts:3618`, it returns `null` when there are zero
closure candidates and no standalone special carrier. That happens before the
host `__call_function` default arm added by #3335 can be built.

The identifier-call caller interprets `null` as "unsupported unknown function"
and deliberately lowers the call to:

1. evaluate each argument;
2. drop each argument value;
3. push `ref.null.extern` as the result.

See `src/codegen/expressions/call-identifier.ts:1651-1666`.

#3335 repaired the default arm of a dispatch chain that has candidates. It did
not cover the zero-candidate early return, so the old silent fallback remains
reachable in the simplest exported-parameter shape.

## Scope

- Repair bare identifier calls whose callee is dynamically typed and whose
  closure candidate set is empty.
- Host lane: invoke a non-null raw host callable through the existing
  `__call_function` bridge.
- Standalone/WASI: dispatch any supported native callable carrier; otherwise
  refuse at compile time or throw a catchable runtime `TypeError`.
- Preserve exactly-once evaluation of the callee and every argument.
- Do not broaden unrelated property/method-call dispatch in the same slice.

## Implementation steps

1. Add `tests/issue-3406.test.ts` with the minimal exported-parameter regression
   before changing code. Assert compile success, Wasm validation, exactly one
   callback invocation, argument `2`, and result `3`.
2. Add a non-callable probe under `try/catch` and assert a catchable `TypeError`,
   not `null`/`undefined` and not an uncatchable Wasm trap.
3. Restructure the zero-candidate guard in `tryEmitInlineDynamicCall` so host
   mode can build the existing raw-callee `__call_function` arm even when the
   closure-arm list is empty. Reuse the existing argument array and host-call
   marshalling; do not add a second bridge.
4. Keep standalone special carriers (`Proxy`, bound functions, TypedArray
   constructors) ahead of the refusal arm. Add a loud terminal arm for an
   unsupported/non-callable dynamic value.
5. Audit late-import registration order. All host helper imports must be
   ensured and `flushLateImportShifts` completed before any helper/function
   index is captured into detached dispatch buffers.
6. Remove or narrow the outer `ref.null.extern` call fallback so no reachable
   dynamic call reports success while deleting the invocation.

## Acceptance criteria

- [ ] The verified `test(f:any) { return f(2) }` probe calls a host function
      once and returns `3` in the default lane with zero closure candidates.
- [ ] A dynamically supplied non-callable throws a catchable JS `TypeError`.
- [ ] Callee and argument expressions are evaluated once, in JS order, on both
      success and throw paths.
- [ ] Host, standalone, and WASI behavior is explicit; none silently synthesizes
      a synthesized nullish value for an unsupported call.
- [ ] Existing one-candidate and multi-candidate closure dispatch tests remain
      valid and stack-balanced.
- [ ] Generated modules pass `WebAssembly.validate`; no new stack-balance,
      function-index, host-import, or codegen-fallback debt is introduced.

## Validation plan

- Targeted `tests/issue-3406.test.ts` regression suite covering zero/one/many candidates,
  void/value-returning callbacks, non-callables, thrown callback errors, and
  side-effectful arguments.
- Existing dynamic dispatch suites: #2939, #2940, #3031, #3140, #3177, and
  #3335 tests.
- `pnpm run typecheck`
- `pnpm run check:stack-balance`
- `pnpm run check:codegen-fallbacks`
- `pnpm run check:loc-budget`
- Default-lane test262 comparison, with special attention to callback-vacuity,
  Promise, TypedArray harness, and `TypeError` buckets.

## Dependencies

- Reuse the host-call bridge landed by #3335.
- Coordinate with any in-flight work touching
  `tryEmitInlineDynamicCall`/`call-identifier.ts`; this is a high-conflict,
  stack-sensitive area.

## Risks

- Ensuring host imports inside detached buffers can shift function indices and
  reproduce the #1858/#2611 class of invalid Wasm unless the shift is flushed
  before indices are captured.
- Every `if` arm must leave the exact declared block result type. Void and value
  call sites need separate coverage.
- A broad fallback change can turn existing vacuous results into real execution,
  exposing honest test262 failures. Treat such flips as behavior corrections,
  not grounds to restore the silent no-op.
