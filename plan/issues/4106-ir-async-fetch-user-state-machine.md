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


## Implementation Plan — 2026-09-05 — Astra integration runtime repair

The existing R7 async candidates exposed a quality-test failure in the
host-free refusal control. This is consolidation under the parent
`3518:integration-consolidation` claim, not expansion of async ownership.
On main `b1537bbeca3858faf45fd89eff5506d21d1e230f`, the exact test fixture
compiles successfully with IR on and off. Both binaries are byte-identical
between flagged and unflagged Node runs, but Wasm validation succeeds only
with `--experimental-wasm-exnref`; the unflagged error explicitly identifies
opcode `0x1f` and that feature. The generic async cross-call equivalence
regression is a separate compiler repair tracked in the R7 issue.

1. Preserve the current compile options, ownership assertions, and all GC
   execution controls in `tests/issue-4106-ir-async-fetch-user.test.ts`.
   Change only validation of the already compiled host-free binary to use
   the established test-scoped Node child convention. Pass the exact binary
   bytes through stdin; do not recompile a substitute fixture in the child.
2. Start the child using `process.execPath` and the explicit experimental
   Wasm exnref flag. Require an ordinary successful exit and a non-vacuous
   validation result; surface child error/signal/stderr. Invalid binaries
   must still fail. Do not skip the test, weaken its assertions, modify
   Vitest's global fork configuration, or add an environment opt-out.
3. Exercise the helper against a deliberately invalid binary to prove it
   can reject, then run the complete issue4106 suite using the ordinary
   repository Vitest fork invocation. Typecheck and formatting must pass.
   Parent will rerun against the combined initializer/async/linear candidate.
4. Ownership is restricted to the host-free helper/call and this issue
   record. The separate async lane owns any changes to generic-suspension
   expectations in the same test file; preserve those changes at integration.
   Keep the clean P2A commit as an ancestor, create a signed local repair
   commit with normal hooks, and leave publication to the parent.

## Astra integration runtime repair — implementation record

- Added a test-scoped `process.execPath` child with
  `--experimental-wasm-exnref` to validate the exact host-free compilation
  bytes received through stdin. The helper reports child errors, signals,
  stderr, exit status, and the boolean validation output.
- Added a first-byte corruption control; the valid host-free binary returns
  `true` and the corrupted copy returns `false` in the same flagged child
  path. Existing compile, IR ownership, and GC execution assertions remain
  unchanged.
- `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 pnpm exec vitest run
  tests/issue-4106-ir-async-fetch-user.test.ts --pool=forks
  --poolOptions.forks.singleFork=true --no-file-parallelism` — 7/7 tests pass.
- `pnpm run typecheck`, focused Prettier, and `git diff --check` pass.
