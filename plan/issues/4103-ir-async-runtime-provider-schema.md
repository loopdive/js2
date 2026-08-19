---
id: 4103
title: "IR async runtime provider and host-capability schema"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, runtime
language_feature: compiler-internals
goal: ir-full-coverage
lane: ir-retirement-r6
parent: 3526
related: [1042, 1373b, 3527]
origin: "#3526 async schema slice after the pure-Math runtime manifest landed"
files:
  - src/ir/runtime-manifest.ts
  - src/ir/async-plan.ts
  - src/ir/async-runtime-providers.ts
  - tests/issue-4103-ir-async-runtime-providers.test.ts
  - tests/ir/issue-1373b-async-plan.test.ts
  - plan/issues/4103-ir-async-runtime-provider-schema.md
---

# #4103 — IR async runtime provider and host-capability schema

## Problem

`IrAsyncPlan` already records seven semantic Promise and scheduling intents,
but that vocabulary is duplicated inside the plan verifier and has no runtime
provider catalogue. The frozen runtime manifest covers only deterministic
Math, so an async producer cannot request its full runtime closure before
lowering. The existing host async frame engine separately consumes six imports,
but their concrete spellings must not leak upward into prepared plans or the
semantic capability set.

## Scope

- Define one closed seven-entry async `RuntimeFeature` vocabulary shared by
  `IrAsyncPlan` and the runtime manifest.
- Model Promise requirements as host-capability providers and scheduler
  enqueue/drain as host-managed Promise-job-queue providers.
- Close and deduplicate those providers to six typed semantic host-capability
  IDs in deterministic order.
- Keep the exact current host adapter module, field, and signature records in a
  separate six-entry catalogue for the later `ImportIntent` projection.
- Reject unknown or late requests, unavailable target policies, and missing
  backend adapters without adding a fallback.
- Preserve the existing pure-Math provider catalogue and behavior.

Production async-plan routing, `ImportIntent` materialization, Program ABI
allocation, and backend integration are explicitly outside this slice.

## Acceptance criteria

- Reversing async requirement and provider traversal produces the same frozen
  manifest.
- The seven async requirements close to exactly six semantic capabilities;
  scheduler providers add no import capability.
- The separate adapter catalogue exactly matches `HostAsyncImports` names and
  signatures while neither `IrAsyncPlan` nor `FrozenRuntimeManifest` carries a
  concrete module or import field.
- Host/WasmGC succeeds; strict-no-host and missing backend adapters fail with
  typed manifest invariants.
- Requests after freeze and unplanned provider/capability lookups fail closed.
- Focused manifest and async-plan tests, typecheck, formatting, and source
  budget gates pass.

## Handoff

The next slice connects prepared async plans to `requestFeature`, projects the
frozen semantic capability IDs through the adapter catalogue, and allocates the
resulting imports through the final Program ABI before lowering.

## Validation

- The focused runtime-manifest and async-plan suite passes: 23 tests across
  `#3526`, `#1373b`, and this issue.
- TypeScript typechecking and Prettier checks pass.
- Source LOC and function-budget gates pass; the accepted source change is a
  net 231 lines across the three touched `src` files.
- The IR fallback ratchet passes with the four async blockers unchanged. This
  slice defines their runtime closure but does not claim an async body.
