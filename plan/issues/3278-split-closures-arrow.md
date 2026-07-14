---
id: 3278
title: "Decompose compileArrowAsClosure — extract capture-analysis / struct-minting / destructuring / construction phases into named phase helpers"
status: in-progress
sprint: current
priority: high
feasibility: hard
model: opus
task_type: refactor
subtask_of: 3182
assignee: ttraenkler/Dev-WaveB-Closures
area: codegen
---

# Decompose `compileArrowAsClosure` (WAVE B)

## Scope

Behaviour-preserving **intra-function** decomposition of the ~1,311-LOC
god-function `compileArrowAsClosure` in `src/codegen/closures.ts` (the remaining
core after the wave-1 closures split). The function compiles a full
arrow / function-expression body as a first-class WasmGC closure and is a
natural PHASE sequence:

1. capture analysis (referenced / written free vars, outer-write boxing,
   TDZ-flag boxing) →
2. capture-struct type minting →
3. lifted-fctx build + capture-extraction prologue →
4. param destructuring + defaults →
5. lifted-fn body compilation (async / generator / block / concise) →
6. finalize + construction-site emit + closure-info registration.

The decomposition lifts cohesive phase blocks **verbatim** into named phase
helpers in a sibling module `src/codegen/closures/arrow-phases.ts` (matching the
established WAVE B pattern — #3271/#3275/#3276 — and the #3182
code-bloat-elimination goal of *shrinking* the god-file). The helpers are called
at the same point with the same arguments (operating on the shared `liftedFctx`
/ `fctx` objects by reference), so the emitted bytes are IDENTICAL.

## Safety — prove-emit-identity

Every slice is gated by `scripts/prove-emit-identity.mjs`: golden baseline
(`write`) BEFORE the edits, `check` AFTER each phase extraction must print
IDENTICAL (39/39 gc/standalone/wasi). tsc 0. Any drift = the phase helper does
not reproduce the block's state threading → fix or revert.

## Slices

- **Slice 1** — `planClosureCaptures` (capture analysis, phase 1) +
  `mintClosureStructTypes` (capture-struct type minting, phase 2). Non-emitting
  analysis / type phases. ~370 LOC lifted.
- **Slice 2** — `emitClosureParamDestructuring` (phase 4 destructuring loop) +
  `emitClosureConstruction` (construction-site emit, phase 6) +
  `registerClosureBindingInfo` (closure-info registration, phase 6). The
  emission-heavy phases. ~330 LOC lifted.

## Implementation notes (WHY, not just WHAT)

- The function threads a **lot** of local state between phases. Phase boundaries
  were chosen where the shared state at the cut is minimal:
  - `planClosureCaptures(ctx, fctx, arrow, body) → { captures, selfBindingName }`.
    Its only side effect on the caller's `fctx` is seeding `fctx.tdzFlagLocals`
    (the #1177 block-scope-shadow rescan) — preserved because `fctx` is passed by
    reference. Everything else is fresh Sets it builds internally.
  - `mintClosureStructTypes(ctx, {...}) → { structTypeIdx, liftedFuncTypeIdx,
    liftedParams }`. `closureResults` and `isNamedFuncExpr` stay caller locals
    (both are read again downstream) and are passed in; `closureResults` is
    passed by reference and read-only inside the helper.
  - `emitClosureParamDestructuring` / `emitClosureConstruction` mutate
    `liftedFctx` / `fctx` (body, locals, boxedCaptures, boxedTdzFlags,
    tdzFlagLocals) by reference — a verbatim relocation of the emit statements,
    so field offsets and instruction order are byte-identical.
- Conservative: `compileArrowAsClosure` and its sibling `compileArrowAsCallback`
  share capture-analysis idioms, but they are NOT merged in this issue — the
  wave-A analysis flagged +0/+1 field-offset sensitivity in the shared emit, so
  a DRY-merge is out of scope unless prove-emit-identity stays IDENTICAL.

## Acceptance

- prove-emit-identity IDENTICAL (39/39) after every slice.
- tsc 0, `tests/issue-3278.test.ts` closure/arrow smoke test green.
- `compileArrowAsClosure` shrinks from ~1,311 LOC toward a thin phase-orchestrator.

## Test Results

### Slice 1 — planClosureCaptures + mintClosureStructTypes (sibling module)

- Phases 1–2 lifted verbatim into a new sibling module
  `src/codegen/closures/arrow-phases.ts` (`planClosureCaptures` capture
  analysis, `mintClosureStructTypes` capture-struct type minting).
- `src/codegen/closures.ts`: 3,472 → 3,129 LOC (−343 — passes the #3102
  LOC-budget gate); `compileArrowAsClosure` body 1,311 → 966 LOC. Four shared
  private helpers (`arrowOwnLocals`, `collectOverBody`,
  `closureProvablyAfterLetDecl`, `buildCaptureFieldDef`) exported for the sibling
  (a function-body-only import cycle, safe).
- `scripts/prove-emit-identity.mjs check`: **IDENTICAL — 39/39** (gc/standalone/wasi),
  control = origin/main.
- `tsc --noEmit`: 0 errors. LOC-budget gate OK. biome clean.
- `tests/issue-3278.test.ts`: 10/10 green (no-capture concise, immutable/mutable
  captures, outer-write boxing, nested transitive captures, named-funcexpr
  recursion, self-recursive const arrow, array-destructuring param, default
  param, generator function-expression).
- CI (PR #3082, slice-1 state): all required checks GREEN.

### Slice 2 — emitClosureParamDestructuring + emitClosureConstruction + registerClosureBindingInfo

- Phases 4 / 6a / 6b lifted verbatim into `src/codegen/closures/arrow-phases.ts`:
  - `emitClosureParamDestructuring` — binding-pattern param destructuring
    (array / tuple-struct / object / externref-host).
  - `emitClosureConstruction` — construction-site emit (ref.func + capture
    values + TDZ-flag ref cells + struct.new).
  - `registerClosureBindingInfo` — closure-info registration (by-type-idx +
    variable/assignment/global closureMap).
- `src/codegen/closures.ts`: 3,472 → 2,814 LOC (−658 total);
  `compileArrowAsClosure` body **1,311 → 638 LOC** (halved). Two orphaned
  imports (`destructureParamArray`, `destructureParamObjectExternref`) removed.
- `scripts/prove-emit-identity.mjs check`: **IDENTICAL — 39/39**, control =
  origin/main. tsc 0, LOC-budget OK, biome clean, smoke 10/10.

Both slices ship in PR #3082 (one cohesive decomposition; not stacked, to avoid
merge-queue ordering fragility).
