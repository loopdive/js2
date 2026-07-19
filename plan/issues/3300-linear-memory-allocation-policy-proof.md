---
id: 3300
title: "Porffor backend P5: prove shared allocation-policy leverage"
status: in-review
sprint: porffor-backend
created: 2026-07-16
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: performance
area: ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3299]
related: [3288, 3298, 3299, 747]
origin: "#3288 P5 split: independently dispatchable allocation-policy comparison"
claimed_by: porffor-codex-developer
claimed_at: 2026-07-17T17:03:36.037Z
branch: symphony/porffor/3300
pr: 3287
loc-budget-allow:
  - src/codegen-linear/index.ts
  - src/compiler.ts
---

# #3300 - Porffor backend P5: prove shared allocation-policy leverage

## Objective

Demonstrate that `LinearMemoryPlan` is a meaningful shared optimization layer
by selecting and comparing at least two allocation policies without changing
the linear-Wasm or Porffor semantic emitters.

## Scope

Implement and compare:

1. the current bump/arena baseline; and
2. one non-trivial policy justified by existing analyses, preferably stack
   promotion for non-escaping fixed-size allocations with managed-heap fallback
   for escaping values.

Use a fixed benchmark set and report output size, peak memory, allocation
count, and runtime for both linear-Wasm and Porffor-C where supported.

## Acceptance criteria

- [x] Both policies consume the same allocation sites, layouts, pointer maps,
      roots, barriers, and symbolic runtime ABI from `LinearMemoryPlan`.
- [x] Switching policy requires no changes to `LinearEmitter` or
      `PorfforEmitter` semantic-operation implementations.
- [x] The alternative policy preserves behavior under alias, identity, bounds,
      and collection-stress fixtures.
- [x] A checked-in measurement note records code size, runtime, peak memory,
      allocation count, supported IR families, exact Porffor commit, compiler,
      and benchmark commands.
- [x] Results distinguish planner decisions from backend-specific artifact
      effects and document any unsupported comparison explicitly.
- [x] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run the P4 heap differential and stress corpus under both policies.
- Run the fixed benchmark suite with warmup/repetition sufficient to report
  stable medians and peak-memory methodology.
- Run linear-Wasm emit-identity coverage for the baseline policy.
- Run scoped IR/equivalence and merge-group conformance validation.

## Non-goals

- Declaring one policy universally optimal from the pilot benchmark set.
- Coupling the shared planner to C, Porffor, or a particular allocator symbol.
- Expanding backend legality beyond families required by the proof.

## Completion of parent

After this PR merges, revalidate every acceptance criterion in #3288 and update
the parent with child PR links, measured results, supported families, and the
final completion status.

## Implementation record (2026-07-17)

- Added `analysis-stack-arena-v1` beside the byte-preserving `arena-v1`
  baseline. Both decisions are made from the same module `LinearMemoryPlan`;
  fixed-size sites proven owned, local, and stack-safe are promoted, while
  every non-promoted site retains the complete baseline decision, including
  managed roots, safepoints, and barriers where applicable.
- Added target-neutral symbolic stack mark/restore operations and stable
  allocation-owner identities. Linear-Wasm and Porffor bind those operations
  in their adapter/assembly layers; `LinearEmitter` was untouched and
  `PorfforEmitter` keeps its established object/vector allocation interface.
- Both adapters reserve one lazy 64 KiB stack region, restore its pointer at
  every function return, preserve returned values across restoration, and
  fall back to the existing arena if a single frame exhausts the region.
- Exposed the experimental `analysis-stack` selector for supported
  single-source linear IR functions. Direct-backend, multi-module, escaping,
  and unsupported families remain arena-backed.
- Checked in a fixed two-allocation benchmark and
  `docs/ir/porffor-allocation-policy-proof.md`. The final 200,000-iteration,
  21-sample medians reduced per-round backing allocations from 400,000 to one
  and peak memory from 9,633,792 to 131,072 bytes in linear-Wasm and from
  10,911,744 to 1,310,720 RSS bytes in Porffor-C. The generated artifacts grew
  by 177 Wasm bytes and 1,173 C-source / 296 native bytes, respectively. Median
  kernel CPU time decreased from 10.856 to 6.382 ms for linear-Wasm and from
  1.858 to 1.075 ms for Porffor-C in the recorded run.
- A mixed managed-heap comparison is explicitly unsupported. ADR-0017 requires
  non-moving raw pointers, Porffor selects GC globally, and JS2 has no managed
  root-slot/type-id contract for these layouts. Managed collection stress is
  therefore inapplicable; the fixtures instead cover repeated frame reuse and
  overflow into the existing non-moving arena.
- The pre-merge safety review closed four gaps: ownership/escape now propagates
  through select, value-producing if, block arguments, slots, and global
  stores; fallback preserves the baseline managed decision; Porffor validates
  and consumes the plan's symbolic allocation and stack operations; and the
  optional Porffor-C test skips cleanly when the submodule is absent. The
  benchmark reads and cross-checks the emitted checksum instead of assuming a
  fixed value.

Validation completed:

- `IR_VERIFY_ALLOC=1 pnpm exec vitest run tests/issue-3300.test.ts tests/issue-3299.test.ts tests/issue-3298.test.ts tests/issue-3297.test.ts tests/issue-3288.test.ts tests/backend-contract.test.ts tests/ir-vec-two-backend.test.ts tests/ir/alloc-registry.test.ts tests/ir/alloc-provenance.test.ts tests/ir/ownership.test.ts tests/ir/escape.test.ts --reporter=dot`
  (9 discovered files, 62 tests passed).
- Scoped cross-backend/equivalence run over `tests/cross-backend-diff.test.ts`,
  `tests/ir-ternary-equivalence.test.ts`, object mutability, shape inference,
  and array-bounds elimination (5 files, 55 tests passed).
- `npx --yes tsx scripts/prove-emit-identity.mjs check --baseline /private/tmp/emit-identity-origin-main-3300.json`
  (all 56 file/target outcomes identical to a clean `origin/main` worktree at
  `49071bce45f`).
- `npx --yes tsx scripts/benchmark-allocation-policies.mts` (five warmups, 21
  fresh measured rounds, 200,000 kernel invocations per round; exact results
  and methodology are in the checked-in measurement note).
- `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, and
  `pnpm run format:check`.
- `pnpm run check:pushraw`, `pnpm run check:loc-budget`,
  `pnpm run check:ir-fallbacks`, `pnpm run check:linear-ir`,
  `pnpm run check:dead-exports`, `pnpm run check:issues`,
  `pnpm run check:coercion-sites`, and `pnpm run check:test262-hard-errors`.
