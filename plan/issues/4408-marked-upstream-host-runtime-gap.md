---
id: 4408
title: "Marked upstream suite host-method and object-spread compatibility"
status: in-review
sprint: current
created: 2026-08-14
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closures/method-trampolines.ts
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
oracle-ratchet-allow:
  - src/codegen/literals.ts
---

# #4408 — Marked upstream host-runtime compatibility

## Problem

Marked's original upstream hook tests compile to valid Wasm after the class
identity, closure receiver, and object-spread fixes, but the admitted runtime
tests still fail because dynamic calls such as `del` do not yet resolve the
compiled class method through the JS host bridge. The watchdog also needs to
bound synchronous compiler work so a pathological upstream file cannot wedge
the compatibility workflow.

## Scope of this draft

- preserve class static/instance identities and method ABI keys;
- preserve callable receivers when method trampolines cross object shapes;
- materialize open spread sources before they enter a closed object field;
- run each upstream compilation in a killable child process with a hard
  deadline;
- retain the exact upstream tests and report compile, validation, and runtime
  results separately.

## Current measurement

`test/unit/Hooks.test.js` compiles and validates (`4,510,972` bytes in about
10.3 seconds). The 15 admitted synchronous tests currently run `0/15` in Wasm
with `br is not a function`; the remaining method-dispatch bridge is therefore
explicitly left for follow-up rather than presented as a passing fix.
