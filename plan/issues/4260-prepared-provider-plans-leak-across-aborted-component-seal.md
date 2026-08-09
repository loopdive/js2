---
id: 4260
title: "Prepared callable-provider plans leak across an aborted component seal"
status: ready
sprint: Backlog
created: 2026-08-09
updated: 2026-08-09
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir, program-abi
language_feature: compiler-internals
es_edition: n/a
goal: full-conformance
parent: 3521
related: [3520, 3521, 3522, 4259]
origin: "2026-08-09 #4259 injected prepared-component seal failure: a TDZ setter plans __new_ReferenceError before its component transaction, then abort cannot retract that provider/import publication"
---

# #4260 — Make prepared provider planning transactional with component sealing

## Root cause

#4259 added an injected failure immediately before a prepared class-accessor
component seals. With a `let` writeback, the IR TDZ guard depends on
`__new_ReferenceError`. The focused failure revealed that
`planBlockingCallableProviders` publishes the provider and its import/in-module
implementation through global `planPrepared` state **before** the component
opens and seals its scoped Program-ABI transaction.

If that component later aborts, `scope.abort()` retracts only the component's
borrowed bindings. It cannot retract the already-published provider plan. The
fallback path then observes one of two invalid states:

- host/GC: dead-code cleanup removes a provider that the sealed registry still
  considers published (`removed after ABI scope sealed`); or
- standalone: direct fallback rematerializes the dependency after the failed
  prepared plan and reports the provider as unplanned.

This is not an accessor or `ReferenceError` special case. Any blocking runtime
callable provider discovered solely by a component that later aborts can leak
the same global reservation. Retaining an unused host import or suppressing the
registry invariant would hide the split rather than restore transactionality.

## Implementation boundary

1. Stage callable-provider and corresponding import/in-module provider plans in
   the same provisional component transaction as their consumer bindings.
2. Publish those plans only when the component seal succeeds. On abort, publish
   none of them and leave the transitional direct path free to plan its own
   actual dependencies.
3. Preserve deduplication when multiple components request the same provider:
   one failed consumer must not retract a provider already committed by a
   healthy component, and one healthy consumer must not make a failed
   component appear sealed.
4. Keep host imports and standalone/WASI in-module constructors behind the same
   Program-ABI provider identity. Do not add a `__new_ReferenceError`-specific
   cleanup path.

## Acceptance criteria

- [ ] An injected pre-seal failure over a TDZ-writing prepared component records
      typed Unsupported and executes only direct codegen (`direct=1, IR=0`) in
      GC and standalone, without stale-provider, unplanned-provider, or
      post-claim errors.
- [ ] The aborted host component leaves no unused `__new_ReferenceError` import;
      the aborted standalone component leaves no orphan in-module constructor.
- [ ] A two-component control where both request the same provider and only one
      aborts proves that the healthy component remains sealed/emitted and owns
      the single committed provider plan.
- [ ] Provider/import planning, prepared-component dependency, Program-ABI
      transaction, direct-fallback, typecheck, and IR fallback suites pass.

## Relationship to #4259

#4259 keeps its seal-failure regression focused on compile-once body ownership
with a `var` writeback, while a separate TDZ test proves the successfully sealed
`ReferenceError` path. This issue owns the newly exposed cross-transaction
provider leak; #4259 must not claim that leak as fixed.
