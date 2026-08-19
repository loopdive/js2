---
id: 4294
title: "codegen: pack JavaScript arguments for source closure rest parameters"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures, rest-parameters, calls
goal: dogfood
related: [1244, 4286, 4292]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/expressions/calls-closures.ts::compileRestClosureArguments
  - src/codegen/expressions/calls-closures.ts::compileClosureCall
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

# codegen: pack JavaScript arguments for source closure rest parameters

## Problem

The compiler represents a source `...rest` parameter as one vec-typed Wasm
formal. Direct and dynamically selected closure calls treated that formal as
one ordinary positional argument. A zero-rest call passed a null/default vec;
a call with multiple trailing values kept at most one value. Hono consequently
entered recursive `mergePath` with a bogus non-empty rest value and lost route
handlers installed through computed class-field closures.

Pack every trailing JavaScript argument into a concrete vec for known source
rest closures, including an allocated empty vec for zero extras. Keep explicit
array parameters distinct from rest parameters and preserve the true JS argc.

## Acceptance criteria

- [x] Direct zero-rest and positional multi-rest closure calls preserve exact
      arity; one trailing spread vec is passed through intact.
- [x] Computed class-field closures receive all fixed and trailing arguments.
- [x] Hono's recursive `mergePath` and route registration advance with Node's
      argument shapes.
- [ ] Mixed/multiple dynamic spreads are materialized without treating the
      spread source as one rest element.
- [ ] Dynamic dispatch distinguishes a source rest closure from an explicit
      final-array closure with the same Wasm funcref signature.

## Result

Known direct, recursive, and stored-field closure calls now use the source
`hasRestParam` fact to materialize the final vec formal. Recursive self metadata
retains the same rest fact, and a trailing spread can fill missing fixed slots
before its remainder is copied into the rest vec. The focused reductions return
`42`, `212`, `11`, and `221`, and Hono registers its expected seven routes. The broad
inline-dynamic candidate experiment was removed after an adversarial reduction
showed that funcref-only dedup cannot distinguish a rest allocation from an
explicit-array allocation; that and mixed dynamic spread packing remain open.
