---
id: 4435
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
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations/object-shape-widening.ts::collectEmptyObjectWidening
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
oracle-ratchet-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/literals.ts
coercion-sites-allow:
  - src/codegen/index.ts
---

# #4435 — Marked upstream host-runtime compatibility

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

The generic method-trampoline fix also removes a separate regression in the
iterator-protocol equivalence test: methods that never read `this` now retain a
nullable receiver instead of being narrowed with `ref.as_non_null`. The
iterator, class-method, and related closure tests pass locally (`17/17`), and
typecheck plus formatting pass. Marked's upstream hooks remain `0/15` until
mixed-arity receiver dispatch (`br`/`del`) is implemented; this checkpoint does
not claim upstream runtime compatibility.

## 2026-08-15 checkpoint

PR [#4507](https://github.com/loopdive/js2wasm/pull/4507) remains deliberately
draft. The branch is synchronized with current `main`; the earlier CI quality
failure was the equivalence baseline ratchet, not a compile or validation
failure in this change.

The watchdog now compiles the selected Hooks module with WAT emission disabled
(the binary is the artifact under test), then runs the unchanged upstream
callbacks in a killable worker. The current local result is `1/1` module
compiled, `1/1` validated, `4,549,831` bytes, and `0/15` admitted synchronous
tests in Wasm (`br is not a function`). The vector bridge export table is now
finalized from allocator-owned function objects after dead-import elimination,
so the runner reports the real method failure instead of an empty marshaled
status vector.

The remaining runtime work is to make Marked's mixed-arity class-method and
renderer initialization path callable without allowing the method-cache arm to
select a closure with the wrong ABI. No passing upstream-runtime claim is made
until that path is covered by the unchanged Hooks suite.

## 2026-08-15 handoff

The follow-up implementation added a real host bridge for ordinary compiled
class methods, including method-arity dispatch, JavaScript under-application
padding, and a vector adapter for rest parameters. The generated module now
validates and instantiates; a focused generic rest-method probe passes. The
regression coverage is in `tests/issue-4507-class-method-dispatch.test.ts`.

The remaining Marked-specific failure is narrower than the old validation
failure: `new Marked()` succeeds, but the dynamic `any` call `marked.use()`
still throws `TypeError: Cannot convert object to primitive value` inside the
compiled `use(...extensions)` body. The unchanged upstream Hooks suite
therefore remains `0/15` in Wasm. This is a semantic receiver/closure capture
problem in the `use` callback path, not a compiler watchdog or Wasm validation
problem. Continue from the current branch/PR with the existing probes removed;
do not report the bridge as upstream-runtime complete until the Hooks suite
passes.
