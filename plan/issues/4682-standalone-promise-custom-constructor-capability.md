---
title: "standalone: Promise combinator custom-constructor capability executor"
status: done
priority: P1
assignee: codex/es6-promise-capability-wave4
issue: 4682
completed: 2026-08-25
loc-budget-allow:
  - src/codegen/promise-combinators.ts
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# Scope

Bounded ES2015 standalone Promise follow-up after #4872: reproduce and fix one
custom-constructor/NewPromiseCapability failure in the Promise combinator
surface. The `.call(Promise, iterable)` routing landed in #4872 is excluded,
as are async/generator drive failures and the broader inbound callback/value
marshalling lane tracked by #2623.

## Cohort / plan

Bounded cohort: `test262/test/built-ins/Promise/all/capability-executor-not-callable.js`
(six synchronous subcases). Each subcase passes an ordinary compiled function
as the `.call` receiver with an empty iterable; the constructor either omits
the capability executor call or supplies at least one non-callable slot. The
homologous `allSettled`/`race`/`any` files and
`capability-executor-called-twice.js` remain explicit follow-up residuals.
The `.call(Promise, iterable)` route, non-empty custom iterables, and
class/subclass receivers remain out of scope. Keep the implementation to one
constructor/capability protocol arm and preserve the gc/host lane.

Plan:

1. Capture a fresh upstream-main baseline for the bounded six-subcase row and
   identify the first failing operation.
2. Implement the narrowest host-free standalone fix that addresses that
   operation without changing generic custom constructors or async drive.
3. Add focused equivalence coverage for the six subcases plus before/after
   zero-loss and required typecheck/format gates.

## Test Results

Baseline (fresh upstream/main `56afab8c3`, wasm SHA `af476666ab72`):
`Promise/all/capability-executor-not-callable.js` failed with
`TypeError: Promise resolve or reject function is not callable`.

After (#4682 branch, wasm SHA `53efe413775a`): the same exact Test262 row
passes (authoritative standalone runner evidence).

Focused checks:

- `tests/issue-4682.test.ts`: 3/3 passed; all six capability-executor
  subcases return the expected post-constructor checkpoint (`71`) with zero
  imports, and both non-empty standalone and gc/host fallback controls retain
  `env.Promise_all`.
- `prettier --check` on all changed TS files: passed.
- Biome lint on all changed TS files: passed.
- TypeScript 7 project typecheck: passed.
- TypeScript 5 changed-file filter: no diagnostics in changed files.

Explicit residual: `capability-executor-called-twice.js` remains outside this
bounded row and is not claimed by #4682; the homologous allSettled/race/any
rows and non-empty custom-constructor protocol remain follow-up work.
