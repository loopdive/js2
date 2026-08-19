---
id: 4106
title: "IR async fetchUser plan producer and frame consumer"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, runtime, codegen
language_feature: async
goal: ir-full-coverage
lane: ir-retirement-r6
parent: 3526
depends_on: [4104]
related: [1042, 1373b, 3527]
files:
  - src/ir/async-prepare.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/codegen/async-frame.ts
  - src/codegen/async-ir-planning.ts
  - src/codegen/ir-async-frame.ts
  - src/codegen/ir-overlay-identity.ts
  - src/codegen/program-abi-planning.ts
  - src/ir/ast-lowering-plans.ts
  - src/ir/identity.ts
  - scripts/ir-only-baseline.json
  - plan/agent-context/ir-migration-handover-2026-08-02.md
  - tests/issue-4106-ir-async-fetch-user.test.ts
  - tests/ir/issue-1373b-async-plan.test.ts
  - plan/issues/4106-ir-async-fetch-user-state-machine.md
loc-budget-allow:
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/codegen/async-frame.ts
---

# #4106 — IR async fetchUser plan producer and frame consumer

## Problem

#4104 closes an `IrAsyncPlan` to its prepared host runtime and Program ABI
dependencies, but no source function produces that plan and no backend emits
its state graph. The playground `fetchUser` function therefore remains an
`async-function` fallback even though its lowered IR is the bounded one-await
shape needed for the first production suspension slice.

## Scope

- Admit only the exact host/WasmGC linear shape `const x = await E; return x`
  when the existing async engine already proves that it genuinely suspends.
- Split the ordinary IR at its single `await`: move the pre-await computation
  into one structurally identified derived IR state helper and attach a
  canonical two-state `IrAsyncPlan` to the source owner.
- Convert that prepared plan into the existing async frame engine's CFG
  contract. Reuse its Promise assimilation, callback, rejection, scheduling,
  and settlement implementation instead of introducing another state machine.
- Resolve the state helper and six runtime adapters through frozen symbolic
  references and Program ABI slots; do not rediscover imports from AST syntax.
- Preserve the current post-direct overlay for this first producer slice. A
  follow-up moves the proven owner into compile-once preparation after its
  Promise-returning callable ABI is allocated before body emission.

## Acceptance criteria

- The exact playground `fetchUser` source produces one immutable two-state
  plan, one derived IR state helper, and a Promise-returning IR-owned wrapper.
- The frame emitter consumes only the prepared plan/helper for the replacement
  body while retaining the existing host scheduler and settlement behavior.
- Playground async execution still resolves the same values, and the terminal
  census drops from four blockers to three with no new invariant.
- Near-miss async shapes remain on their prior route.
- Focused tests, typecheck, formatting, source/function budgets, and the IR
  fallback ratchet pass.

## Result

- The selector admits only the exact host/WasmGC two-statement source shape;
  non-identity post-await tails and host-free targets remain on the direct
  route.
- IR preparation splits `fetchUser` into a Promise-returning state-0 helper
  and an immutable two-state async plan. The callable Program ABI projects the
  source owner to `externref` while its semantic fulfillment remains `f64`.
- The existing async frame engine consumes the prepared graph and retains its
  scheduler, Promise assimilation, rejection, and settlement behavior. The
  numeric tail also avoids the legacy `externref` to `f64` to `externref`
  carrier round trip.
- The playground census has five terminal functions: `delay` and `fetchUser`
  emit through IR, while `fetchAllSequential`, `fetchAllParallel`, and `main`
  remain typed `async-function` blockers. `fetchUser__ir_async_state_0` is also
  IR-emitted as a derived helper, with no post-claim errors.

## Validation

- `pnpm exec vitest run tests/issue-4106-ir-async-fetch-user.test.ts tests/ir/issue-1373b-async-plan.test.ts`
  — 13/13 tests pass, including a value-level `fetchUser(7) === 70` check.
- `pnpm run typecheck` — passes.
- `pnpm run check:loc-budget` and `pnpm run check:func-budget` — pass; async
  planning lives in a dedicated subsystem module instead of growing the
  codegen driver or its largest functions.
- Focused Prettier and `git diff --check` — pass.
- `pnpm run check:ir-fallbacks` — passes with no gated fallback or post-claim
  increase.
- `pnpm exec tsx scripts/check-ir-only.ts --policy=hybrid` — READY at 34/37
  terminal bodies emitted by IR, three typed async blockers, and zero
  invariants. The supported baseline update consolidates the prior body-shape
  and call-graph labels into the more accurate `async-function` reason.

## Handoff

After this slice, move this exact owner into the prepared compile-once route by
allocating its canonical Promise result ABI during declaration planning. Then
widen the plan producer from the one-await tail form to multiple states and
spills before claiming `main` and the loop/combinator functions.
