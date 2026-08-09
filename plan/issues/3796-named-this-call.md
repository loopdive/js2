---
id: 3796
title: "Receiver-correct stable named FunctionDeclaration.call"
status: in-progress
sprint: current
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, ir
es_edition: multi
language_feature: functions
goal: ir-full-coverage
parent: 3522
depends_on: [3794]
related: [1636, 1702, 2069, 2152, 3673, 3795]
assignee: codex/finish-node-at-receiver-call
branch: codex/3796-named-this-call
files:
  - src/codegen/named-this-call.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-3796-named-this-call.test.ts
loc-budget-allow:
  - src/codegen/named-this-call.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/named-this-call.ts::resolveNamedThisCallTarget
  - src/codegen/named-this-call.ts::ensureNamedThisCallTrampoline
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #3796 — preserve `thisArg` for an exact named `.call`

## Problem

The direct path for `stableFunction.call(thisArg, ...args)` resolves a named
`FunctionDeclaration` to its exact Wasm target, but evaluates and discards
`thisArg`. A declaration whose own body reads `this` therefore observes the
unbound fallback instead of the receiver supplied by `.call`.

Acorn reaches this gap in both `finishNode` and `finishNodeAt`:

```js
function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations) node.loc.end = loc;
  if (this.options.ranges) node.range[1] = pos;
  return node;
}

pp.finishNodeAt = function (node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc);
};
```

The IR selector cannot claim that stable call until the exact direct fallback
has receiver-correct semantics.

## Scope

- Admit only an exact checker-resolved, body-bearing, non-generator,
  non-async, unique top-level `FunctionDeclaration` whose own body reads
  `this`, and require the Program ABI source-callable registry to prove that
  exact declaration owns the resolved `FuncHandle`.
- Handle `.call` only. Keep `.apply`, closures, aliases, explicit TypeScript
  `this` parameters, rest parameters, reassigned live function bindings,
  nested/same-name shadows, and unstable declarations on their existing paths.
- Require exact source arity and no spread. Under- and over-application remain
  on the legacy path. Repair that legacy over-application path so it compiles
  only formal operands and preserves extras through the established
  `arguments`/extras ABI (or evaluates and drops them when unobserved).
- Admit Acorn's bare-`this` receiver and other receiver expressions whose
  checker type excludes null, undefined, and void.
- Reserve one exact-target trampoline with ABI
  `(externref thisArg, ...targetParams) -> targetResults`.
- Save/install/restore `__current_this`, including restoration in
  `catch_all` before `rethrow 0`.
- Preserve receiver-before-arguments evaluation order, exact target ABI,
  `arguments.length` plumbing, result values, nesting, and re-entrancy.
- Keep a runtime-null receiver on the prior unbound exact call.
- Add no host import and preserve all unrelated direct-call optimizations.

## Acceptance criteria

- [x] Receiver identity and four-argument order execute correctly.
- [x] Nested and re-entrant calls restore the outer receiver.
- [x] A throwing target restores the outer receiver before rethrow.
- [x] Acorn's locations/ranges `finishNodeAt` shape executes by value.
- [x] Nullish, `.apply`, alias, closure, this-free, reassigned, nested-shadow,
      and over-arity negative shapes do not reserve the trampoline.
- [x] IR-first enabled/disabled runs are behaviorally identical.
- [x] Focused and adjacent tests, typecheck, formatting, LOC/function budgets,
      IR fallback ratchet, and equivalence gate pass.

## Completion evidence

- Focused #3796 suite: 6/6 passing. It executes the four-argument
  receiver-first order, `arguments.length`, nested/re-entrant restoration,
  exceptional restoration, the locations+ranges Acorn shape, negative
  admission (including anti-vacuity runtime checks for reassigned,
  same-name-shadowed, and over-arity targets), and IR-first `0`/`1` parity.
- Every focused standalone module has zero Wasm imports.
- Adjacent `.call`/ambient-`this` suites: 59 passing. The sole adjacent failure,
  #2069's string-constants import-object setup, reproduces unchanged on the
  detached `origin/main` control.
- Typecheck, Biome lint, Prettier, issue integrity, LOC/function budgets,
  stack-balance, dead-export, coercion-site, IR fallback, and optimization
  retirement gates pass.
- Equivalence gate: 1,611 passing, 32 baseline failures, four baseline failures
  now passing, and zero new regressions.
