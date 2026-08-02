---
id: 4113
title: "Require final allocation-provenance verification for every IR artifact"
status: in-progress
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: critical
horizon: s
complexity: S
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ir, codegen
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
parent: 3518
depends_on: [1586]
required_by: [3792]
related: [1586, 3518, 3792]
files:
  - src/ir/verify-alloc.ts
  - src/ir/integration.ts
  - tests/ir/alloc-provenance.test.ts
  - tests/issue-4113-ir-final-allocation-provenance.test.ts
loc-budget-allow:
  - src/ir/integration.ts
---

# #4113 — Require final allocation-provenance verification for every IR artifact

## Objective

Make allocation-provenance validation an unconditional final publication gate
for WasmGC IR artifacts. Keep `IR_VERIFY_ALLOC` as the opt-in switch for extra
checks at intermediate pass boundaries, but verify each final ordinary,
synthetic, and monomorphized function after all transforms and before lowering.

## Retirement risk

#1586 introduced allocation identities and a verifier, but its integration
calls are all disabled unless `IR_VERIFY_ALLOC` is set. A production build can
therefore publish a transformed IR function with missing, stale, dangling, or
kind-mismatched allocation provenance. That is unsafe for retiring direct
codegen because later IR-only optimizations depend on the final artifact's
allocation identity, including specialization-created allocation sites.

Running the verifier after every pass in every production build would multiply
the walk cost. This slice instead separates two policies:

- optional intermediate assertions remain controlled by `IR_VERIFY_ALLOC` and
  retain their pass-local diagnostic value; and
- one required final assertion runs for every function that will be lowered,
  after inlining, monomorphization, clone rewriting, and final hygiene.

The final walk must fail closed: an artifact that cannot be verified is not
published or lowered.

## Scope

1. Give `src/ir/verify-alloc.ts` distinct optional-intermediate and
   required-final assertion entry points without duplicating verification
   logic.
2. Route the WasmGC integration pipeline through one final-artifact verifier
   immediately before downstream analysis/lowering. Cover the complete final
   function collection, including synthetic helpers and monomorphized clones.
3. Add a negative integration control that injects invalid provenance after
   the last transform and proves compilation fails while `IR_VERIFY_ALLOC` is
   unset.
4. Add a positive focused compile control with the flag unset and retain unit
   coverage for optional intermediate checks.
5. Measure elapsed compile cost on a stable focused corpus with the final gate
   enabled and with a local diagnostic kill switch used only for measurement.
   Record the harness, commits/configurations, repetitions, and result.

The linear backend has a separate integration pipeline and registry. It does
not yet consume the same prepared artifact (#3518 R8), so this slice does not
pretend to close its retirement gate. When the shared prepared program lands,
its final backend boundary must consume the same required verification result.

## Optimization-retirement ledger classification

The current #3792 ledger schema inventories direct-path optimizations with a
direct owner and three parity evidence classes. This safeguard is an IR-native
correctness invariant, not a migrated direct optimization, so adding it as a
row would be inaccurate. #3792 v2 must classify always-on IR-native safeguards
and include this gate in its deletion-readiness result.

## Acceptance criteria

- [ ] `IR_VERIFY_ALLOC` continues to control optional checks at intermediate
      pass boundaries.
- [ ] Final allocation-provenance verification is unconditional and runs once
      for every final WasmGC IR artifact before analysis/lowering.
- [ ] Ordinary, synthetic, and monomorphized final functions cannot bypass the
      required gate.
- [ ] A focused injected final-stage defect fails with
      `allocation-provenance-failure` while `IR_VERIFY_ALLOC` is unset.
- [ ] A normal focused compile succeeds with the flag unset.
- [ ] Focused IR and type/format checks pass.
- [ ] Compile overhead is measured on a named stable corpus; the result is
      recorded without treating timing noise as zero cost.
- [ ] #3792 v2 follow-up classification is documented without inserting an
      incompatible ledger row.

## Out of scope

- Changing allocation identity, registry alias/retire semantics, or lowering.
- Enabling every intermediate assertion in production.
- Claiming full linear-backend or IR-only retirement readiness.
- Expanding the current #3792 ledger schema in this slice.

## Result

Pending implementation and measurement.
