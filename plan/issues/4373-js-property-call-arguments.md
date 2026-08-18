---
id: 4373
title: "JavaScript callable-property and host bridges truncate arguments beyond declared arity"
status: done
sprint: 78
created: 2026-08-11
updated: 2026-08-18
completed: 2026-08-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions, arguments-object, dynamic-method-call
goal: npm-library-support
related: [1712, 2664, 2687, 3958, 4371]
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-4373-js-property-call-arguments.test.ts
func-budget-allow:
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

# Preserve overflow arguments across JavaScript property-call bridges

## Problem

React's production `createElement(type, config, children)` function deliberately
declares three formals and reads every additional child through `arguments`.
Calling it with five children therefore supplies seven runtime arguments.

Two generic compiler defects independently discarded those trailing values:

1. TypeScript's checker adds a synthetic rest-like parameter to an unannotated
   JavaScript function that reads `arguments`. Callable-property lowering
   treated that checker-only symbol as a real Wasm formal, selected the wrong
   closure shape, and dropped overflow values instead of using the existing
   `__argc` / `__extras_argv` protocol.
2. A callable reached through `__extern_method_call` was wrapped with the
   largest emitted `__call_fn_method_N` dispatcher. Module finalization did not
   observe this wrapper call site's arity, so a module whose real closures had
   at most five formals emitted no dispatcher above five. Seven arguments were
   silently truncated to five before the three-formal closure ran.

The result was observable as `arguments.length === 5` instead of `7`, and React
lost two children. This is a generic JavaScript call-semantics defect, not a
React-specific special case.

## Acceptance criteria

- [x] Source declarations, rather than checker-synthetic symbols, determine a
      non-declaration JavaScript closure's real formal arity.
- [x] Callable-property calls preserve the exact runtime argument count and all
      overflow values through the canonical arguments protocol.
- [x] Host dynamic method calls cause module finalization to emit a dispatcher
      wide enough for their non-spread argument count (within the existing
      supported dispatcher range).
- [x] A three-formal JavaScript function called with seven arguments observes
      `arguments.length === 7` and the correct fifth and seventh values.
- [x] The direct and experimental-IR compilation routes agree.
- [x] React's two previously divergent original ReactChildren tests pass.

## Design

For a real source function, trim only checker parameters that have no matching
source declaration parameter. Preserve real source rest parameters and all
declaration-file signatures. When a callable-property ladder targets the
resulting lower-arity closure, use the existing arguments globals rather than
evaluating and dropping overflow expressions.

For host dynamic method calls, feed the call expression's argument count into
the existing `maxHostDynamicMethodCallArity` accounting. The existing module
finalizer already includes that value when deciding which
`__call_fn_method_N` exports to emit; the missing step was observing this
particular wrapper path.

## Evidence

- `tests/issue-4373-js-property-call-arguments.test.ts`: 4/4 pass, covering
  callable-property and JS-host dynamic-method dispatch on both direct and
  experimental-IR compilation routes.
- React's original `ReactChildren` flat-structure and key-combination tests:
  2/2 pass against compiled Wasm.
- Complete current React extraction: 64/64 runnable/scored original tests pass,
  with zero runtime divergences. Eight further tests remain compile-quarantined
  by the independently tracked async-in-try limitation, and 200 require missing
  upstream Jest/DOM test infrastructure.
