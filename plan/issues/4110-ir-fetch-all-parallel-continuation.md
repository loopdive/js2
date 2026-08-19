---
id: 4110
title: "IR async fetchAllParallel non-identity continuation"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-03
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, runtime, codegen
language_feature: async, Promise.all
goal: ir-full-coverage
lane: ir-retirement-r7
parent: 3527
depends_on: [4107]
related: [1042, 1373b, 2867, 2906, 2918, 3137, 3518, 3587, 3792, 4106, 4109]
files:
  - src/ir/async-prepare.ts
  - src/codegen/async-ir-planning.ts
  - src/codegen/ir-async-frame.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  - scripts/ir-only-baseline.json
  - tests/ir/issue-1373b-async-plan.test.ts
  - tests/issue-1042-host-drive.test.ts
  - tests/issue-4110-ir-fetch-all-parallel.test.ts
  - plan/issues/4110-ir-fetch-all-parallel-continuation.md
loc-budget-allow:
  - src/codegen/ir-async-frame.ts
  - src/ir/async-prepare.ts
---

# #4110 — IR async fetchAllParallel non-identity continuation

## Problem

After #4107, the exact playground `fetchUser` owner has a canonical
Promise-returning source slot and compiles once from its prepared async plan.
`fetchAllParallel` still receives a typed `Unsupported / select /
async-function` outcome, emits one direct body, and emits no IR body.

Its one suspension is already structurally simple:

```ts
const pending: Promise<number>[] = [];
for (...) pending.push(fetchUser(ids[i]));
const results = await Promise.all(pending);
let total = 0;
for (...) total = total + results[i];
return total;
```

`prepareSingleAwaitIrFunction` can split the ordinary IR around the await and
derive entry and continuation helpers. The prepared frame consumer currently
rejects the result because it accepts only an empty identity continuation.
Keeping this owner direct would preserve a backend-specific AST path for a
shape already representable by the shared IR plan.

## Scope

- Admit only a checker- and IR-certified top-level host/WasmGC function with
  one real suspension and a continuation whose only live input from before the
  await is the delivered fulfillment value.
- Freeze the canonical Promise source-callable ABI before Program ABI
  publication, using the same structural owner and no function-name allowlist.
- Retain the existing prefix helper for vector construction, `fetchUser`
  fan-out, and `Promise.all`; derive one ordinary IR continuation helper for
  the post-resume reduction.
- Extend the prepared frame adapter to invoke that symbolic continuation
  helper after fulfillment, then settle its numeric result through the
  existing frame engine and six frozen host adapters.
- Keep `spills: []`: `pending` is dead at suspension, `results` is the resume
  value, and `total`/the reduction counter are created after resumption.
- Seal entry, continuation, source callable, runtime adapters, and every
  required vector/runtime provider as one dependency-complete prepared
  component before direct body emission.
- Bank every measured decrease through the #4109 legacy-body ceiling.

## Semantic and optimization parity

- All `fetchUser` calls must occur before the single suspension; the IR path
  may not serialize the fan-out.
- Preserve `Promise.all` input ordering, output ordering, assimilation, and
  fail-fast rejection. Reuse its existing runtime provider rather than adding
  a new combinator or scheduler.
- Preserve the canonical Promise-only, always-async caller ABI and propagate
  rejection through the existing frame rejection path.
- Preserve the pending/result vector representations, direct indexed reads,
  numeric accumulator representation, loop-counter narrowing, and any proven
  bounds-elision shape present on the direct path.
- Add function-specific WAT assertions for the continuation call, result
  settlement, and vector hot path. Runtime equality alone is insufficient for
  optimization retirement.
- Record any newly exposed direct fast-path decision in the optimization
  retirement ledger before its direct owner can be deleted.

## Fail-closed boundary

- A continuation that captures any pre-await value other than the fulfillment
  value remains typed Unsupported until explicit spills exist.
- Multiple awaits, nested awaits, loops containing awaits, handlers across an
  await, nested executable syntax, function-value escape, generic/reference
  ABI drift, standalone, WASI, and linear remain on their established route.
- A dependency, Program ABI, verifier, or lowering failure after the owner is
  sealed is terminal. It cannot retry the direct body.
- Source syntax may certify early ABI eligibility, but the backend consumes
  only the prepared `IrAsyncPlan`, symbolic function references, and frozen
  runtime manifest; it may not inspect TypeScript AST nodes.

## Acceptance criteria

- The unchanged playground `fetchAllParallel` has
  `legacyBodyEmitted: false`, `irBodyEmitted: true`, and a non-empty
  `preparedComponentId`.
- Its source callable, entry helper, and continuation helper are all emitted
  through IR and resolve through Program ABI identities, with no post-claim
  errors or direct fallback.
- Runtime coverage proves all requests are started before any one resolves,
  results retain input order, the sum is correct, and the first rejection
  rejects the outer Promise without running the reduction.
- Near-miss capture, multi-await, host-free, ABI-mismatch, and injected-failure
  controls stay direct or fail terminally as specified.
- The production readiness lane moves from 34/37 to 35/37 IR-emitted, from
  three to two typed async blockers, from 33 to 32 legacy bodies, and remains
  at zero invariants.
- The committed legacy-body ceiling is exactly the freshly measured 32; an
  increase fails the hybrid gate.
- Focused async-plan/runtime tests, typecheck, fallback/readiness/optimization
  gates, formatting, source/function budgets, and relevant pre-push tests pass.

## Result

`fetchAllParallel` now compiles through the prepared IR async component. Its
source callable, entry helper, and post-resume reduction continuation share a
frozen Promise ABI and resolve through stable Program ABI identities. The
entry preserves the three-request fan-out before suspension; the continuation
materializes the fulfilled host array into the typed vector representation,
reduces it with direct indexed reads and numeric loop state, and settles the
outer Promise through the existing frame runtime. Rejection bypasses the
continuation and reaches the established rejection path.

The production census is now 35 of 37 reachable functions emitted through IR,
32 legacy bodies, two typed async blockers, and zero invariants. The two
remaining blockers are `fetchAllSequential` and async `main`.

No new optimization-retirement ledger row was required: this slice introduced
no new direct-only optimization. Existing vector representation, indexed-read,
numeric accumulator, loop-counter, and bounds decisions are covered by the
focused WAT assertions. The next serial slice is `fetchAllSequential`.

## Validation evidence

- The focused #4110 suite passes all 18 tests, covering source/entry/
  continuation ownership, fan-out and ordering, first rejection, stable
  symbolic targets, exact vector materialization, continuation WAT shape, and
  fail-closed controls.
- The post-rebase async, runtime, allocation, vector, and regression selection
  passes all 147 tests across 12 files.
- Typecheck and formatting checks pass.
- Source LOC and function-size budgets pass with only the issue-scoped
  allowances for `ir-async-frame.ts` and `async-prepare.ts`.
- The raw-checker TypeOracle ratchet passes with zero new checker accesses.
- The normal fallback ratchet and the body-shape diagnostic pass with zero
  unintended fallback growth, post-claim fallback growth, module growth, or
  body-shape rejection.
- Hybrid readiness passes at 35/37 IR-emitted, 32 legacy bodies, two
  unsupported async owners, and zero invariants.
- Optimization-retirement validation passes all 22 tracked decisions: 11 are
  IR-owned, one is retirement-ready, and two remain source-anchored.

## Validation plan

- Reuse the pending-input, element-order, and first-rejection controls from
  `tests/issue-2867-gap4.test.ts`; the new host fixture must exercise the same
  semantics through the prepared source owner.
- Keep `tests/issue-2918-promise-then-funcidx-shift.test.ts` green and add a
  late-import control around the prepared entry/continuation helpers so
  Promise combinator indices cannot drift after sealing.
- Keep `tests/issue-3587-async-rejection-delivery.test.ts` green and assert the
  prepared continuation never runs after the awaited combinator rejects.
- Use `tests/issue-3137.test.ts` as the existing Promise.all ordering/rejection
  semantic control; #4110 does not replace or fork the combinator runtime.
- The focused #4110 file must inspect the exact source owner, entry helper,
  continuation helper, resume function, and their resolved calls in WAT, then
  instantiate the module and prove value, timing, ordering, and rejection.

## Integration order

This is the first serial async widening after #4107. `fetchAllSequential`
follows with structured `for` CFG states and spills; `main` follows last with
two awaits, explicit liveness, and `Promise<void>` settlement. These slices
share the async producer, frame consumer, dependency scanner, Program ABI
routing, and codegen driver, so their production edits must not be developed
or merged concurrently.
