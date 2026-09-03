---
id: 5297
title: "R4 compatibility lane: symbolize the externref dynamic support surface (`__box_number` / `__unbox_number` + the externref carrier) as Program-ABI refs — the real blocker behind `implicit-support-reference-unavailable`"
status: done
assignee: ttraenkler/opus-5297
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: backend-agnostic-ir
related: [5289, 3523, 3518, 5285, 4208]
requested_by: ttraenkler/orchestrator
# 2026-09-03 — new file `src/ir/prepared-dynamic-support.ts`: the
# generalized dynamic sidecar (187 lines). It is deliberately a NEW module
# rather than growth inside `compiler-timer-shim-preparation.ts` (which stays at
# imports-and-exports only) or `prepared-component-sealing.ts` (which takes a
# 21-line merge). Splitting it out keeps the timer shim's one-shape proof
# separable from the general arm and keeps both existing files under their
# base sizes.
loc-budget-allow:
  - src/ir/prepared-dynamic-support.ts
---

# The slice #5289 uncovered and deliberately did not do

PR #5525 ([#5289](5289-any-module-binding-abi-unification.md)) admitted `any`
module-binding storage in both lanes and **measured** that the two carriers
already agree (same type index in all four `{gc,standalone}×{compat,fast}`
cells — `resolveWasmType` and `resolveIrDynamicCarrierType` are the same
function of `ctx.fast`, written twice). Storage is no longer the blocker.

With storage clear, the **compatibility** lane (`fast: false`) demotes on a
different, nameable code:

```
implicit-support-reference-unavailable:
  IR dynamic carrier resolves backend type/helper support
  without a symbolic Program ABI ref
```

Source: `src/ir/prepared-component-dependencies.ts:434-437` — the `dynamic`
arm of `recordImplicitTypeRequirement` blocks whenever no `dynamicCarrierRef`
reaches it. The fast lane reaches `emitted` because its `$AnyValue` surface is
symbolically planned; the compat lane's externref surface
(`__box_number` / `__unbox_number`, `f64 ↔ externref`) has **no symbolic
Program-ABI ref** and no support-type binding for the externref carrier, so
every unit that touches a dynamic value in compat mode fails preparation
*after* storage was admitted.

Measured consequence (PR #5525, "One honest cost"): in `gc/compat` a module
with an `any` binding now moves bytes without gaining an emitted unit —
preparation proceeds further, then demotes here. That churn is the price of
keeping the #5285 census honest; this issue is what removes it.

## What "symbolize" means here

The carrier side already has the hook: `ctx.programAbiTypes.prepareDynamicCarrier(resolveIrDynamicCarrierType(ctx))`
(`src/ir/integration.ts:727`) mints a `carrierRef` for accessor writebacks.
The gap is that (1) the module-init / free-function preparation path does not
thread that ref into `recordImplicitTypeRequirement`'s `dynamicCarrierRef`
parameter for the externref case, and (2) the helper *callables*
(`__box_number`, `__unbox_number`, and the `__typeof_*` family the compat arm
routes through — `src/ir/integration.ts:8983`) are reached as raw `env`
imports, not through a Program-ABI `support` binding
(`src/ir/program-abi.ts:82`, `kind: "support"`), so
`recordSupportTypeReference` refuses them (`ref.binding.kind !== "support"`,
line 460).

The #3526 F1-S3 precedent (`src/ir/intrinsic-support.ts:262-278`) is the
pattern: the manifest decides which physical symbol answers the seam, the seam
binds it through the one binding kind its observation path accepts, and the
physical target is identical either way — which is why that migration was
byte-neutral.

## Acceptance criteria

1. Compat-lane focused fixtures from #5525 (six `any`/`unknown` × `let`/`const`
   × initialized/reassigned) reach `irBodyEmitted: true` in `gc/compat` and
   `standalone/compat`, matching what the fast lane already does.
2. Re-run the #5285 dogfood survey: the seven files that lost all storage
   refusals in #5525 either reach `emitted` or land on a **named non-support**
   blocker (`body-shape-rejected` etc.); zero rows may remain on
   `implicit-support-reference-unavailable` with the "dynamic carrier" detail.
3. Byte identity where the arm is inactive: per-row sha256 over the #5525
   cohort (dogfood 20×4, playground 13×4, controls) — every row that was
   identical in #5525 stays identical. The compat-lane "bytes move without an
   emitted unit" churn measured in #5525 must either vanish (unit now emitted)
   or be explained row by row.
4. The four-cell carrier-agreement check in
   `tests/issue-5289-any-module-binding-abi.test.ts` stays green; add the
   symbolic-ref assertion (the compat carrier and both helpers resolve through
   `support` bindings) as a new pinned test, red on base.
5. Gates: full ratchet chain + `LOC_GATE_BASE` simulation, `check:ir-dialect`,
   `check:ir-kind-neutrality` (verdict table must not move — this is not an
   instruction-kind change), `check:ir-fallbacks`, `check:ir-only` READY.
   No new host import (dual-mode rule: standalone must keep its Wasm-native
   arm).

## Conflict surface

`src/ir/prepared-component-dependencies.ts`, `src/ir/program-abi.ts`,
`src/ir/integration.ts` (module-init preparation), `src/codegen/any-helpers.ts`.
Disjoint from the wave-9 accounting PRs (#5528 `ir-prepared-free-functions.ts`,
#5530 `ir-overlay-outcomes.ts`). Do not branch until #5525 has merged — this
slice builds on its admission arm.

## Implementation Plan

Written 2026-09-03 by the Fable lane from a read of `src/ir/prepared-component-dependencies.ts`,
`src/ir/prepared-instruction-support.ts`, `src/ir/compiler-timer-shim-preparation.ts`,
`src/ir/runtime-manifest.ts`, `src/ir/runtime-host-capabilities.ts` and
`src/ir/integration.ts` at `origin/main` `91d4999050` (post-#5525/#5528). Line
numbers are from that revision.

### Mechanism (reasoned from source; confirm in step 1)

The `dynamic` arm at `prepared-component-dependencies.ts:434-437` blocks only
when `dynamicCarrierRef` is `undefined`. That argument comes from
`preparedDynamicCarrierRef(terminalOwnerUnitId, input)` (call site `:1385`),
which reads **two sidecars only** (`prepared-instruction-support.ts:40-48`):
`classAccessorWritebacks` (minted in `integration.ts:727-745` for dynamic
class-setter writebacks) and `dynamicInstructionSupport` — and the only
producer of the latter on main is the **compiler-timer-shim** preparation
(`compiler-timer-shim-preparation.ts:446-461`). An ordinary compat-lane unit
that touches a dynamic value (an `any` module binding read/write, a `box` /
`unbox` / `dyn.*` instruction) has **neither sidecar**, so its
`dynamic`-typed params/results/values hit the block. The fast lane does not
reach this arm the same way because its `$AnyValue` surface is planned as a
symbolic support type elsewhere (which is why PR #5525 saw `emitted` there).

The helper callables are the second half: `__box_number` / `__unbox_number`
(and, standalone, `__to_primitive` / `__to_number`) are reached as raw
`env` imports or defined runtime funcs; the dependency recorder only accepts
them when the unit's `instructionCallables` sidecar names them
(`prepared-instruction-support.ts:59`), otherwise `recordSupportTypeReference`
sees no `support` binding and fails (`:460`).

**The template already exists**: `prepareCompilerTimerShimDynamicShapes` mints
the carrier once via `ctx.programAbiTypes.prepareDynamicCarrier(resolveIrDynamicCarrierType(ctx))`
(`:213-221`), and `prepareCompilerTimerShimDynamicInstructionSupport`
(`:226-294`) binds each helper through `exactPreparedDynamicHelperRef`
(`:96-133`) — an `env` import ref when the funcIdx is an import, an observed
`irRuntimeFuncRef` through `ctx.programAbiCallableProviders.observe` when it
is a defined func — with the standalone arm routed through
`prepareStandaloneExternrefToNumberProviders`. Both arms select the SAME
physical symbol the manifest already governs (`runtime-manifest.ts:1205-1228`
`number.box`/`number.unbox` providers; capability records
`runtime-host-capabilities.ts:710-711`). So this slice **generalizes** the
timer-shim sidecar to every prepared unit in the compat lane; it mints no new
import and no new spelling (dual-mode rule satisfied by construction).

### Change

1. **New module `src/ir/prepared-dynamic-support.ts`** (keep
   `compiler-timer-shim-preparation.ts` untouched except for re-using its two
   helpers — export `exactPreparedDynamicHelperRef` and the
   `PreparedTimerDynamicHelperName` union from there, or move both into the new
   module and import them back; pick whichever keeps the timer file's diff to
   imports only).
   - `prepareDynamicInstructionSupportForUnits(ctx, units, callableImports)`:
     for each terminal unit whose final IR contains a `box`, `unbox`,
     `dyn.*` instruction, or whose signature/values carry a `dynamic` type
     (walk `fn.params`, `fn.resultTypes`, `valueTypes` — the same population
     `collectType` at `:1388-1398` visits), mint the carrier **once per
     program** (`prepareDynamicCarrier` is idempotent on the registry — verify,
     and cache the `carrierRef` locally regardless) and bind the helpers the
     unit's instructions need: `box` (f64→externref) → `__box_number`;
     `unbox` → `__unbox_number` (compat) / the standalone provider triple;
     `dyn.*` → whatever `ensureIrDynamicRuntime` (`integration.ts:8894-8897`)
     registers for that op — record the exact helper set per op kind as a
     table in the PR body, measured from `dynamicRuntimeNeeds`.
   - Return `ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence>`
     (existing type, `prepared-instruction-support.ts:23-26`).
2. **Thread it into sealing**: where `prepared-component-sealing.ts:583` takes
   `input.dynamicInstructionSupport`, merge the timer-shim map and the new map
   (unit ids are disjoint by construction — assert it, fail closed on overlap
   with a `selection-preparation-mismatch` invariant, never silently prefer one).
3. **Compat lane only by measurement, not by flag**: do not gate on
   `!ctx.fast`. Run the same preparation in both lanes; in the fast lane the
   helper lookups resolve to the any-helper family and the carrier to
   `ref_null $AnyValue` — both must be byte-neutral there (criterion 3 proves
   it). If the fast lane is NOT byte-neutral, gate on the lane and record why.
4. **Do not touch** `recordImplicitTypeRequirement` or the `dynamic` arm's
   block message — the arm is correct; the fix is supplying what it asks for.
   Do not touch `src/ir/module-bindings.ts` / `module-binding-value-kinds.ts`
   (#5525's files; W2-B's surface).

### Measurement order

1. **Probe on base** (`.tmp/probe-5297.ts`): compile one of #5525's six
   `any`/`unknown` fixtures in `gc/compat` with `trackIrOutcomes` and print
   the failing unit's `implicit-support-reference-unavailable` detail plus a
   temporary `console.error` at `prepared-component-dependencies.ts:435`
   showing `dynamicCarrierRef === undefined` and which sidecars are absent.
   Expected: both sidecars absent for the module-init unit. If a sidecar IS
   present and the ref still fails, the mechanism differs — stop and re-plan.
2. Capture base copies at first edit (`.tmp/base-*.ts`) — sealing,
   dependencies, timer-shim files.
3. Implement 1–3. Re-run the six fixtures: `irBodyEmitted false → true` in
   `gc/compat` and `standalone/compat`; values unchanged (`1`, `2`, `42`, `2`).
4. Re-run the #5285 dogfood survey (20 files × 4 cells): count rows on
   `implicit-support-reference-unavailable` with the "dynamic carrier" detail
   before/after (expected → 0); record where each of the seven #5525 files
   lands now (named non-support blocker or `emitted`).
5. Byte identity: per-row sha256 over dogfood 20×4 + playground 13×4 +
   #5525's controls, base vs after. Rows that may legitimately move: only
   compat-lane rows whose unit now reaches `emitted`. The #5525 "bytes move
   without an emitted unit" churn must be gone or explained per row.
6. `check:ir-fallbacks -- --verbose` before/after (module-level buckets);
   `check:ir-only` READY not regressed; `check:ir-kind-neutrality` verdict
   table byte-identical (if only a line cite shifts, regenerate with
   `--update-on-decrease` + prettier, or rebase onto #5298 if it has landed).
7. Equivalence, 8 shards by name; full ratchet chain + `LOC_GATE_BASE`.

### Tests

- Extend `tests/issue-5289-any-module-binding-abi.test.ts` or add
  `tests/issue-5297-compat-dynamic-support.test.ts`: (a) compat-lane `any`
  module binding unit reaches `emitted` in gc and standalone (red on base:
  `implicit-support-reference-unavailable`); (b) the prepared evidence for
  that unit names `__box_number`/`__unbox_number` through `support`-kind
  bindings (assert via the published dependency evidence, not internals);
  (c) fast-lane control: the same program's fast-lane bytes are identical
  before/after (sha256 pinned in-test against a base compile done in the
  test's own `beforeAll` with the sidecar disabled by env flag — if no such
  flag exists, pin the sha in the PR body only).
- Non-vacuity: reverting the sealing merge (step 2) alone must return (a)
  to red — measure and record.

### Budget and conflict surface

New file `src/ir/prepared-dynamic-support.ts` (~120 LOC, grant in this
issue's frontmatter with dated rationale) + small edits to
`prepared-component-sealing.ts` (merge) and `compiler-timer-shim-preparation.ts`
(exports). No `src/ir/integration.ts` edit is expected; if one is needed,
say why in the PR body — that file is R6 F3-S3's surface. Disjoint from
#5283 (`src/codegen/ir-overlay-outcomes.ts`), #5299 (publication), #5300
(`imported-functions.ts`), #3520 W1-D (`program-abi-*.ts`).

## Outcome — measured 2026-09-03 on `origin/main 42a0adf7d4`

**Probe (step 1) confirmed the planned mechanism exactly.** For the
`gc/compat` and `standalone/compat` `<module-init>` of `let a: any = 1`:
`classAccessorWritebacks` is a map WITHOUT an entry for the unit,
`dynamicInstructionSupport` is absent entirely, so
`preparedDynamicCarrierRef` returns `undefined` and the `dynamic` arm blocks.
Two failures are reported, not one — the carrier type ref AND the `box`
instruction's callable ref. The fast lane never enters
`prepareDependencyCompletePreparedComponents` for this program at all.

**Change.** New `src/ir/prepared-dynamic-support.ts` mints the module's own
carrier and binds `__box_number` through the timer shim's
`exactPreparedDynamicHelperRef` (now exported, together with
`isDynamicInstruction`); `prepared-component-sealing.ts` merges the two
sidecar maps and fails closed on overlap. `src/ir/integration.ts` is NOT
touched.

**Scope, narrowed by measurement.** Only `box`-to-dynamic with an f64 operand
is named. `emitBox`'s externref/ref arms call nothing at all, so no callable
ref can honestly satisfy `implicitSupportRequirement`; the i32/Boolean arm
(`__box_boolean`) and the whole `unbox`/`dyn.*` family have no reachable
prepared unit in the measured cohort, so naming helpers for them would be
unverifiable code. Units carrying any other dynamic instruction are left
exactly as the base tree leaves them.

**Cohort measurement** (dogfood 20 x 4 cells + playground 13 x 4 cells + 6
controls x 4 cells = 156 rows, per-row sha256 of the production binary):

| result | rows |
| --- | --- |
| byte-identical base vs after | 150 |
| moved | 6 |
| fast-lane rows moved | 0 |
| dogfood / playground rows moved | 0 |

The six that moved are exactly `{any-number, unknown-number, any-const}` x
`{gc/compat, standalone/compat}`: `unsupported / late-preparation-unsupported`
with 0 emitted units, to `emitted` with 1 emitted unit. Rows carrying an
`implicit-support-reference-unavailable` "dynamic carrier" detail: **6 to 0**.
The #5525 "bytes move without gaining an emitted unit" churn is gone on
every affected row.

`any-reassigned` does NOT move: it is blocked earlier, in all four cells
including fast, on `property-write-unsupported`
(`ir/from-ast: assignment to module binding "a" (dynamic) got f64`). That is a
named non-support blocker outside this arm. `any-var` stays
`body-shape-rejected` by design.

`check:ir-fallbacks --verbose`, `check:ir-only` (READY, 38/41 emitted) and
`check:ir-kind-neutrality` are byte-identical base vs after; no
`scripts/*-baseline.json` was touched.
