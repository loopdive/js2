---
id: 3142
title: "IR module-init overlay adoption (claimability milestone; compile-once remains)"
status: done
completed: 2026-07-16
assignee: ttraenkler/fable-b
sprint: 72
created: 2026-07-11
updated: 2026-07-21
note: "Slice 1 (selector + telemetry) landed via PR #3160; Slice 2 (claim-feeding lowering + __module_init patch, f64/i32 module bindings) lands in this PR."
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
related: [3090, 2855, 2856, 3518]
origin: "plan/bloat-reduction-battle-plan.md slice 6; gate G3 in plan/log/3090-phase0-legacy-delete-list.md"
# Slice 1 adds the module-init claim assessment to the selector; it must live
# in select.ts because it reads the module-level isPhase1* walk state
# (earlyReturnLoopDepth / barrier / forInitLeakedNames) that is deliberately
# not exported (see the threading rationale on currentHostGlobalResolver).
# Slice 2 wires the module-init build/patch into the integration pipeline
# (integration.ts: build block + moduleBindings map + Phase-3 slot patch)
# and forwards the claim through planIrOverlay's safeSelection (index.ts).
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/from-ast.ts
  - src/codegen/index.ts
---

# #3142 — IR module-init overlay adoption

> **Retirement clarification (2026-07-21):** this completed issue made a
> synthetic module-init unit selectable, lowerable, and patchable. It did **not**
> make module init compile-once and therefore did not clear deletion gate G3.
> The pipeline still emits the legacy `__module_init` body first and patches
> that shared slot after IR integration succeeds. #3518 R4 owns the
> prepare-before-emit module-init replacement; a zero module rejection
> histogram proves claimability only.

## Problem

At filing time the IR claim unit was the `FunctionDeclaration` (+ class
members), so top-level statements were never claimable. This issue added the
first module-init overlay ownership step. Legacy statement handlers nevertheless
stay reachable until #3518 R4 moves module preparation ahead of legacy body
emission and R9 removes hybrid fallback.

## Implementation Plan (architect)

1. **New claim unit**: a synthetic module-init function wrapping the top-level
   statement list, selected by `src/ir/select.ts` under the same per-kind rules as
   function bodies (rejection buckets reuse `IrFallbackReason`; falls back whole-module
   to legacy, exactly like the function-level demote channel).
2. **LowerCtx scope**: module scope = outermost LowerCtx; exported bindings map to
   the existing global/export machinery in `src/codegen/declarations.ts` (shared,
   "stays" bucket) — reuse, don't fork.
3. **Ratchet**: add a `module-level` telemetry bucket to `check:ir-fallbacks` so
   adoption is measurable on the corpus like every other bucket.
4. Sequencing: independent of the IR-first default flip (#3143). Together they
   establish measurable overlay coverage, but #3518 R4/R9 are still required
   before #3090 handler deletion.

## Acceptance criteria

- Modules whose top-level statements are all IR-supported kinds patch their
  module-init through the IR overlay (verifiable via genuine-emission
  telemetry).
- ir-fallback gate has a `module-level` bucket with a corpus baseline.
- Equivalence suite + merge_group net ≥ 0.

These acceptance criteria close the overlay-adoption slice only. They are not
IR-only or direct-handler-deletion criteria.

## Slice plan (fable-alpha, 2026-07-16)

Precedent: #1370 Phase A landed the class-member claim unit **selector-only**
first, then wired integration in Phase B. Same sequencing here:

- **Slice 1 (this PR) — selector assessment + `module-level` telemetry bucket.**
  - `src/ir/select.ts`: new `IrModuleInitAssessment` on `IrSelection`
    (`moduleInit?`), populated under `trackFallbacks` only (production
    compiles byte-identical — `STRICT_IR_REASONS` is empty, so
    `trackFallbacks` is off outside the gate/tests). The assessment takes the
    top-level statement population (everything except function/class/type/
    import/export declarations), wraps it in a synthetic void
    `<module-init>` FunctionDeclaration, and runs the EXISTING per-kind
    rules: `isPhase1BodyStatement` per statement (constructor-body
    precedent: no tail requirement, early-return barrier armed), then the
    same external-call / call-graph-closure gate as Step 2 via
    `buildLocalCallGraph` over `declByName ∪ {<module-init>}` — every local
    callee must be in the FINAL claimed set. Rejection reasons reuse
    `IrFallbackReason` per the architect plan.
  - `scripts/check-ir-fallbacks.ts`: new `moduleLevel` baseline section
    (rejection-reason histogram over corpus modules) gated
    must-not-increase, plus informational claimable/empty counts;
    back-compat with baselines lacking the field (info-only until
    refreshed).
  - `scripts/ir-fallback-baseline.json`: corpus baseline for the new bucket.
  - `tests/issue-3142.test.ts`: unit tests over `planIrCompilation`
    (empty population, claimable init, body-shape reject, external-call,
    call-graph-closure).
- **Slice 2 (this PR, fable-b) — lowering + integration.** Build the synthetic
  module-init through from-ast/lower with a module-scope outermost LowerCtx
  (bindings → symbolic `global.get/set`, reusing the existing global/export
  machinery in `declarations.ts`), patch the `__module_init` slot in
  `compileIrPathFunctions`, and demote whole-module to legacy on any
  build/verify failure (the existing warning channel). Flip the selector
  assessment from telemetry-only to claim-feeding.

## Slice 2 record (fable-b, 2026-07-16)

- `src/ir/from-ast.ts`: `moduleInitUnit` mode on `lowerFunctionAstToIr` —
  constructor-body precedent (every statement via `lowerStmt`, implicit empty
  return). New `moduleGlobal` ScopeBinding: top-level `let`/`const` in the
  unit write the legacy `__mod_<name>` global via symbolic `global.set`
  (TDZ flag mirrored per legacy `emitTdzInit`), reads/writes/`++`/`+=`
  route through global get/set. Demote throws for: module-level closures,
  destructuring declarations, `var` anywhere in the unit.
- `src/ir/integration.ts`: module-init build block (gates: legacy
  `__module_init` slot exists, no static class initializers / live-func
  seeds, f64/i32-backed bindings only, no top-level `throw` outside WASI —
  legacy drops those), `buildModuleBindingsMap`, BuiltFn.moduleInit threading
  through Phases 2–3, Phase-3 slot patch by NAME with typeIdx parity guard.
- `src/ir/select.ts`: assessment now runs on production (`!trackFallbacks`)
  paths — claim-feeding; exported `MODULE_INIT_UNIT_NAME` /
  `collectModuleInitPopulation` / `makeModuleInitSynthetic` (one population
  definition for selector + integration).
- `src/codegen/index.ts`: `safeSelection.moduleInit` forwarding (cleared
  under the `new.target` coarse gate).

## Test Results

- `tests/issue-3142.test.ts`: 14/14 pass — S1 selector verdicts (updated:
  production selections now carry `moduleInit`), S2 genuine emission
  (`irCompiledFuncs` has `<module-init>`; runtime values correct through
  the patched init: numeric decl+assign+claimed-call, `++`/`+=`
  module-init-only claim, boolean i32 binding), demote guards (string
  binding, top-level `var`, module-level closure — all fall back to the
  legacy body with correct runtime output).
- `tsc --noEmit`: clean. `check:ir-fallbacks`: moduleLevel baseline
  unchanged (assessment logic untouched; only the gating flipped).

## merge_group park fix (PR #3168, 2026-07-17, commit d696143f)

The PR parked twice with the identical single-test regression:
`test/language/statements/for-in/order-simple-object.js` (pass → fail,
"returned 2", byte-identical numbers both runs — real, not drift).

**Root cause**: the IR lowering terminates the void module-init unit with an
explicit `return` (the legacy body falls through). `finalizeInModuleInitFlag`
(#2800, `src/codegen/index.ts`) runs AFTER the Phase-3 slot patch and wraps
`__module_init`'s body with `__in_module_init = 1 … = 0` whenever a
delete-aware any-receiver read recorded the flag. With the IR body's trailing
`return`, the appended `= 0` reset became unreachable — the flag stayed 1
forever, so every post-init flag-gated property access took the init-only arm
(the test's `delete o.p1; o.p1 = 'p1'` re-add skipped `__dyn_set` and lost its
re-insertion enumeration order; `p1` vanished from `for-in`).

**Fix** (`src/ir/integration.ts` Phase 3, commit d696143f): the module-init
patch skips `applyIrTailCalls` for the unit (a `return_call` would bypass the
epilogue the same way), strips trailing bare `return`(s) so the body falls
through exactly like legacy's, and demotes to the legacy body if any
non-trailing return-class op remains (`bodyContainsReturnClassOp`, deep scan —
defensive; the claimable population can't contain `return` statements).

**Verification** (two independent reproductions converged on the same fix):
the wrapped test's emitted WAT is byte-identical to main's; the test passes;
a 70-test for-in/Object.keys/delete sweep has zero status diffs vs main;
`tests/issue-3142.test.ts` 15/15 (incl. the new pinning test, which fails on
the pre-fix code).
