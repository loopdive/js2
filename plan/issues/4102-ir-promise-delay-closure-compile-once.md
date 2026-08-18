---
id: 4102
title: "IR R3: prepare the exact Promise-delay closure component before direct body emission"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: critical
horizon: m
complexity: M
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen, compiler
language_feature: Promise, closures, setTimeout
es_edition: ES2015
goal: ir-full-coverage
lane: ir-retirement-r3
parent: 3521
depends_on: [4041]
related: [2138, 2856, 3520, 3521]
origin: "R3 prerequisite: move the checker-certified Promise delay and its two lifted closures onto prepare-before-emit ownership"
files:
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/index.ts
  - src/codegen/program-abi-type-planning.ts
  - src/ir/integration.ts
  - src/ir/prepared-closure-support.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/prepared-component-sealing.ts
  - tests/issue-3521-prepared-component-dependencies.test.ts
  - tests/issue-4102-ir-promise-delay-closure-compile-once.test.ts
  - tests/issue-4102-program-abi-closure-support.test.ts
---

# #4102 — prepare the exact Promise-delay closure component before direct emission

## Objective

Move only the already checker-certified delay shape onto real prepared-component
ownership:

```ts
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
```

The owner, executor closure, and timer closure must be built, dependency-closed,
and sealed before `compileDeclarations` emits any body. The owner then emits
exactly once through IR (`legacyBodyEmitted: false`, `irBodyEmitted: true`) and
has a real `preparedComponentId`. This is a closure-ownership prerequisite for
R3; it is not async-function selection and does not introduce or consume an
async plan.

## Existing capability

#2856 already owns the exact semantic certification and lowering:

- global, unshadowed `Promise` and `setTimeout` identities;
- an exact two-parameter `f64, f64 -> Promise` owner ABI;
- deterministic derived identities for the executor and timer arrows;
- exact capture order and lifted signatures;
- the four runtime imports `Promise_new`, `__timer_set_timeout`,
  `__box_number`, and `__call_1_f64`;
- runtime settlement, concurrent-call isolation, malformed-shape rejection,
  import-collision demotion, and optimized byte determinism.

That lowering currently runs after direct body emission. R2 preparation also
rejects every function containing nested executable syntax. The missing piece
is ownership of the already-planned closure support, not another Promise or
closure recognizer.

## Implementation boundary

1. After final runtime/import preparation, select an R3 candidate only when the
   exact #2856 construction plan still matches its authoritative top-level
   function unit, allocated `(f64, f64) -> externref` slot, source AST identity,
   and non-escaping callable use.
2. Project the owner through the existing prepared free-function transaction.
   Preserve the inherited compile-once skip set for unrelated functions.
3. Immediately before prepared-component sealing, materialize the wrapper,
   lifted-funcref, and captured-subtype types referenced by the final
   `closure.new`, `closure.cap`, and `closure.call` population.
4. Give those physical types canonical Program ABI support bindings and expose
   the exact refs to dependency discovery. Reuse the same closure registry
   instance during lowering so no post-seal duplicate subtype is allocated.
5. Settle all four delay imports before direct emission. Later direct-only
   imports may shift indices through the established fixups, but may not change
   ownership or closure layout.

The closure-support step must fail closed. Unsupported closure signatures,
capture types, stale derived identities, or missing Program ABI bindings leave
the whole component on the direct route before any owner body is skipped.

## Non-goals

- no generic nested-function or function-expression widening;
- no async/generator selection and no `IrAsyncPlan` production or consumption;
- no Promise shape beyond #2856's exact certified delay;
- no host-free, WASI, fast, native-string, or multi-module widening;
- no unsealed pre-direct transaction and no success without a
  `preparedComponentId`;
- no new runtime helpers or changes to Promise/timer ABI.

## Acceptance criteria

- The exact delay outcome has `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and a `prepared-component:*` identity.
- `irFirstSkipped` contains the exact owner, while `irCompiledFuncs` contains
  the owner plus both deterministic lifted closure names.
- Optimized and unoptimized binaries validate and concurrent calls settle to
  their own values.
- A direct-only function that adds a later import cannot corrupt the prepared
  delay's call or closure indices.
- A near-miss Promise shape remains direct (`legacyBodyEmitted: true`,
  `irBodyEmitted: false`) and has no prepared-component identity.
- Runtime-helper collisions retain the existing preclaim demotion behavior.
- The four delay imports and their signatures are unchanged; no replacement
  callback helper appears.
- Focused Promise-delay, prepared-routing, typecheck, IR fallback, and relevant
  pre-push gates pass with no census withdrawal.

## Current status

Implementation is complete on the #4041 merge base. The exact selector routes
only the certified Promise delay through preparation. One pre-seal closure
registry allocates the final wrapper/subtype population, Program ABI planning
publishes support refs keyed by the exact post-pass function/instruction/type
objects, and lowering reuses that same registry. Exact derived callable slots
and the four settled imports are planned before dependency discovery seals the
component. A private physical name keeps early derived slots separate from
source functions that reuse the lifted display names.

The positive owner now has a real `prepared-component:*` identity and no
legacy body; both lifted closures emit through IR. Empty or unrelated closure
evidence remains blocked, nested signature dependencies are still discovered,
near misses remain direct, runtime-helper collisions retain preclaim demotion,
and optimized/unoptimized concurrent delay calls settle correctly.

Validation on this worktree:

- focused #2856/#3521/#4102: 56/56 passing;
- typecheck, IR fallback, LOC budget, function budget, and diff checks passing;
- migration census: 33/37 IR bodies, 34 legacy bodies, 4 Unsupported, 0 Invariant.

The full #3521 prepared-routing file retains its existing class-member boundary
failure on current `origin/main`; #4102 does not change that path.
