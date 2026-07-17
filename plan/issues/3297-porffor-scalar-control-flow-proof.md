---
id: 3297
title: "Porffor backend P2: scalar and control-flow differential proof"
status: in-review
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: feature
area: ir, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3296]
related: [3288, 3295, 3296, 3030]
origin: "#3288 P2 split: independently dispatchable scalar Porffor backend proof"
claimed_by: porffor-codex-developer
claimed_at: 2026-07-17T02:12:12.870Z
branch: symphony/porffor/3297
---

# #3297 - Porffor backend P2: scalar and control-flow differential proof

## Objective

Lower a real scalar/control-flow subset of JS2 typed SSA IR into Porffor IR,
render it through the pinned optional renderer, compile the C, and prove
behavior against JavaScript and JS2's linear-Wasm backend.

## Scope

1. Implement `PorfforSink` as a structured builder with a statement list and
   expression/value stack while preserving left-to-right evaluation and
   effects.
2. Implement constants, numeric conversion/arithmetic/comparison, locals,
   globals, select, structured conditionals/blocks/loops/branches, direct
   calls, return, and unreachable.
3. Reject every heap/reference operation in this slice.
4. Assemble functions and modules with stable symbolic names; assign Porffor
   array positions only during final assembly.
5. Render with the pinned Porffor renderer, compile with the available CI C
   compiler, and execute differential fixtures.

## Acceptance criteria

- [x] Real JS2 IR reaches Porffor IR through the five-part backend contract;
      there is no parallel AST-to-Porffor front end.
- [x] Expression construction preserves operand order and `FX` semantics for
      effectful scalar/control-flow fixtures.
- [x] Unsupported heap/reference IR fails through legality before emission.
- [x] Scalar fixtures produce equal results under JavaScript, linear-Wasm, and
      Porffor-C.
- [x] Function and module assembly is deterministic and independent of
      registration order.
- [x] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run focused IR-node mapping and operand-order tests.
- Run three-way scalar differential tests.
- Compile rendered C with warnings treated as errors where supported.
- Run existing backend contract tests.

## Non-goals

- Heap allocation, objects, arrays, roots, or barriers.
- A public Porffor compile target.
- Adopting Porffor's `jsval` or object ABI.

## Handoff

After this PR merges and #2956 is complete, #3298 extracts the shared
backend-neutral linear-memory plan.

## Implementation record (2026-07-17)

- Added an IR-only Porffor integration path using the existing type converter,
  Porffor legality profile, generic function-body lowerer, structured emitter,
  and module assembler. Production source does not statically import the
  optional renderer or Porffor internals.
- Added a symbolic `PorfforSink` whose statement list and value stack spill
  pending reads/effects before later statements. Effectful operands and Wasm
  `select` inputs are evaluated eagerly from left to right before final C
  expression construction.
- Added deterministic final assembly. Functions, globals, and interned types
  retain symbolic handles during lowering, sort by stable names/keys, and only
  receive Porffor array positions in `finalize()`.
- Moved scalar slot and loop lowering off the Wasm-only raw-instruction escape
  path so all four emitter families can use their own sink type. Heap,
  reference, indirect-call, exception, and raw-Wasm families remain rejected
  by Porffor legality or fail loudly at the emitter boundary.
- The differential fixture lowers real typed SSA IR, renders with the pinned
  optional Porffor checkout, compiles the generated C with `-Werror`, and
  proves results `[1312, 26, 15, 10, -1]` against JavaScript and linear Wasm.
  The first value distinguishes left-to-right calls from reversed evaluation.

Validation completed:

- `pnpm exec vitest run tests/issue-3297.test.ts tests/issue-3288.test.ts tests/issue-3295-porffor-compat.test.ts tests/backend-contract.test.ts tests/issue-2952.test.ts tests/issue-1982-ir-emission-order.test.ts --reporter=dot`
  (6 files, 44 tests passed)
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run format:check`
- `pnpm run build`
- `pnpm run check:pushraw` (80 call sites, two fewer than merge-base)
- `pnpm run check:loc-budget`
