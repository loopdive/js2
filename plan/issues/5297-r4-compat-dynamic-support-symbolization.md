---
id: 5297
title: "R4 compatibility lane: symbolize the externref dynamic support surface (`__box_number` / `__unbox_number` + the externref carrier) as Program-ABI refs — the real blocker behind `implicit-support-reference-unavailable`"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: backend-agnostic-ir
related: [5289, 3523, 3518, 5285, 4208]
requested_by: ttraenkler/orchestrator
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
