---
id: 4104
title: "IR async plan runtime-manifest and Program ABI consumer"
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
depends_on: [4103]
related: [1042, 1373b, 3527]
files:
  - src/ir/nodes.ts
  - src/ir/intrinsic-support.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/ir-async-runtime-adapters.ts
  - src/ir/integration.ts
  - tests/issue-4104-ir-async-plan-runtime-consumer.test.ts
  - plan/issues/4104-ir-async-plan-runtime-consumer.md
loc-budget-allow:
  - src/ir/integration.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
---

# #4104 — IR async plan runtime-manifest and Program ABI consumer

## Problem

`IrAsyncPlan` records the complete semantic Promise and scheduler requirement
set, and #4103 maps that set to six host capabilities, but production
preparation does not consume either contract. The existing async frame engine
still obtains its concrete imports from an AST prepass. Moving a genuinely
suspending function such as playground `fetchUser` to Prepared IR before this
seam exists would either discover imports from source syntax again or mutate
the function index space during lowering.

## Scope

- Attach a target-neutral `IrAsyncPlan` to its exact `IrFunction` owner.
- Validate the owner, function kind, plan graph, and canonical Promise ABI
  while preparing the frozen runtime manifest.
- Request every plan runtime intent through `RuntimeManifestBuilder` and attach
  the selected host/WasmGC adapter references only after the manifest freezes.
- Materialize the exact six existing host adapter signatures before Program
  ABI component sealing; reuse and validate imports already registered by the
  transitional AST collector.
- Make every attached adapter an explicit prepared-component callable
  dependency so Program ABI allocation, not `funcMap` text lookup, owns its
  final index.
- Preserve the semantic boundary: neither `IrAsyncPlan` nor
  `FrozenRuntimeManifest` contains concrete module/field names or indices.

Producing an async plan from `fetchUser` and adapting the frame emitter to
consume state bodies are the immediately following slice. This issue does not
claim an async body or change its observable runtime behavior.

## Acceptance criteria

- A prepared plan with all seven intents closes to the exact six host adapter
  dependencies in deterministic order.
- Existing matching imports are reused; missing imports are registered with
  the catalogue signatures; signature or owner drift fails before lowering.
- The six imports acquire Program ABI identities through dependency-complete
  component sealing.
- Host/WasmGC succeeds; strict-no-host and non-WasmGC policies keep their typed
  manifest failures.
- Focused tests, typecheck, formatting, source/function budgets, and the IR
  fallback ratchet pass with the four async blockers unchanged.

## Validation

- The focused #4104/#4103/#1373b suite passes 20 tests, including canonical
  semantic closure, post-freeze intrinsic attachment, six exact adapter
  imports, Program ABI identities, owner drift, signature drift, and target
  policy failures.
- The prepared-component, Math-runtime, callable-import ABI, and async-frame
  regression suites pass 41 tests.
- Typecheck, formatting, LOC/function budgets, and the IR fallback ratchet
  pass. The bounded census remains four typed blockers: `fetchUser`/`main`
  (`async-function`), `fetchAllSequential` (`call-graph-closure`), and
  `fetchAllParallel` (`body-shape-rejected`).

## Handoff

The next slice produces an `IrAsyncPlan` from the exact linear `fetchUser`
shape and makes the existing frame emitter consume its prepared state bodies.
It must retain one frame engine and the canonical Promise-only ABI; it must not
reintroduce AST-driven import discovery or a second suspension machine.
