# IR migration handover — 2026-08-02

Work is wound down after the first production `IrAsyncPlan` source-owner
slice. All delegated agents have finished, and no follow-up implementation
slice was started. The completed work is published as ready PR
[#4050](https://github.com/loopdive/js2/pull/4050), with auto-merge enabled.

The issue Markdown files remain authoritative. Start with:

- `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`
- `plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md`
- `plan/issues/4106-ir-async-fetch-user-state-machine.md`
- `plan/issues/3522-*` through `plan/issues/3528-*`

## Exact stop point

- Branch: `codex/4106-ir-async-fetch-user`
- Isolated worktree: `/private/tmp/ts2wasm-4106-async-fetch-user`
- PR head before this handover commit: `b0237c394b41024e75b6c0a7e62b23409ca89a7a`
- Base at publication: `origin/main` `b157531c1e59ef85fa4047371d33a25205e12e8f`
- PR state at handover: open, ready, auto-merge enabled, required CI running,
  no observed failures.

Do not amend or push this branch once GitHub places it in the merge queue.

## What this slice completes

The exact host/WasmGC source shape

```ts
async function f(...): Promise<T> {
  const value = await expression;
  return value;
}
```

can now be prepared as a canonical two-state `IrAsyncPlan`, with the
pre-suspension computation moved into a structurally identified IR state
helper. The prepared plan resolves its six host runtime adapters through the
frozen runtime manifest and Program ABI, then emits through the existing async
frame/scheduler engine.

The producer keeps the semantic fulfilled value (`f64` for the playground
case) separate from the physical Promise-returning callable ABI (`externref`).
For the exact numeric identity tail, it also preserves the direct path's
optimization by avoiding an `externref -> f64 -> externref` carrier round trip.

The playground `fetchUser` function and `fetchUser__ir_async_state_0` now emit
through IR with no post-claim error. `fetchAllSequential`,
`fetchAllParallel`, and `main` remain typed `async-function` blockers.

## Measured migration state

The production single-host readiness lane is:

- 5/5 entries observed
- 37 terminal source units
- 34 IR-emitted terminal units (91.9%)
- 3 typed Unsupported units
- 0 Invariant units
- 34 legacy bodies emitted
- 34 IR bodies emitted

The high IR-emission percentage is overlay coverage, not retirement coverage.
Only three terminal units currently avoid legacy body emission. The compiler
therefore remains a default-on hybrid, and the direct frontend/codegen path is
not ready for deletion.

## Safest next serial steps

1. Let #4050 merge; fetch the resulting `origin/main` before starting work.
2. Move the exact proven async owner from the post-direct overlay into
   compile-once preparation. Allocate its canonical Promise callable ABI
   before body emission and prove `direct=0, IR=1` at the terminal owner.
3. Widen the same producer and frame-consumer seam from one suspension to
   multiple states and explicit spills.
4. Migrate the three remaining playground async owners through that widened
   seam. Keep loops, Promise combinators, rejection, and settlement behavior
   on the shared frame engine.
5. Continue the broader retirement sequence: R2 dependency families, R3
   classes/closures, R4 ordered module init, R5 whole-program ownership, R6/R7
   runtime and suspension families, R8 linear consumption, then the R9 default
   flip and R10 deletion.

Keep core changes serial. `src/codegen/index.ts`, `src/ir/select.ts`,
`src/ir/from-ast.ts`, `src/ir/integration.ts`, declaration planning, and class/
closure allocation are overlapping ownership seams. Safe parallel work is
limited to disjoint fixtures, provider catalogues, benchmark evidence, and the
optimization ledger.

## Optimization-retirement guard

Do not retire a direct handler solely because its syntax family emits through
IR. Preserve every optimization with an explicit IR owner and evidence.

The existing ledger contains the Acorn representation requirements, but the
following still need stable machine-tracked rows:

- #4106 numeric Promise-carrier round-trip elision;
- leaf-struct finality used for V8 devirtualization;
- inline-small eligibility discovery;
- monomorphized clone identity/signature preservation;
- allocation-provenance preservation.

Before final deletion, add a fail-closed inventory denominator tying every
reachable direct handler and fast-path marker to a ledger row. A green ledger
is insufficient if an optimization was never inventoried.

## Last green validation

```bash
pnpm exec vitest run \
  tests/issue-4106-ir-async-fetch-user.test.ts \
  tests/ir/issue-1373b-async-plan.test.ts
pnpm run typecheck
pnpm run check:ir-fallbacks
pnpm exec tsx scripts/check-ir-only.ts --policy=hybrid
pnpm run check:loc-budget
pnpm run check:func-budget
```

The focused matrix passed 13/13. Typecheck, fallback and post-claim ratchets,
the 34/37 hybrid readiness gate, formatting, oracle/coercion ratchets, and LOC/
function budgets passed. The value-level test instantiates the Wasm and proves
`fetchUser(7)` settles to `70`.

## Resume procedure

1. Read this handover and #4106 completely.
2. Confirm #4050 is merged and its merge commit is an ancestor of the live
   `origin/main` ref.
3. Use a new isolated worktree. The root checkout contains unrelated user and
   parallel-session state.
4. Re-run the readiness lane before widening it; do not infer compile-once
   ownership from `irBodyEmitted` alone.
5. Allocate a new Markdown issue through `scripts/claim-issue.mjs --allocate`
   and keep the implementation/result/validation/handoff current there.
6. Open completed PRs as ready, enable auto-merge, and never rewrite a queued
   head.
