---
id: 7053
title: "standalone: a binding holding `C.prototype` (`const prototype = this.prototype` in a static method) gets the instance-struct `$C` slot and is guard-cast to null — axios `AxiosHeaders.accessor([...])` throws at module init"
status: done
sprint: current
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: classes, prototypes
goal: standalone-gap
related: [7019, 6767, 3976]
# 2026-10-17 — the slot-typers that must agree are the statement cascade
# (variables.ts), the let/const and var pre-hoisters (index.ts) and the
# module-global typer (declarations.ts). Each gets ONE call to the shared
# predicate in class-proto-object.ts; the predicate itself lives there.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
---

# Bindings that hold a class prototype are typed as instances

Split out of [#7019](./7019-standalone-module-init-traps-cjs-graphs.md).

## Problem

`C.prototype` has the checker type `C` (the INSTANCE type), but on
`--target standalone` its value is a `$Object` (#3976). Any slot typed from the
checker is `$C`, and storing the prototype guard-casts it to `ref.null $C`.
[#6767](./6767-es2015-standalone-class-definition-reflective-residue.md) withdrew that narrowing for a
call-site-inferred parameter spelled `C.prototype`. Still lossy:

- `this.prototype` inside a STATIC method (the receiver is `this`, not `C`);
- a local / module binding initialised from it (`const p = C.prototype`);
- a parameter whose only call-site argument is such a binding.

axios `core/AxiosHeaders.js` runs `AxiosHeaders.accessor([...])` at module
init: `const prototype = this.prototype; … buildAccessors(prototype, h)` →
`Object.defineProperty(null, …)` → "Object method called on null or
undefined". Every axios unit file importing `AxiosError`/`AxiosHeaders`
(`isCancel`, `canceledError`, `settle`, `validator`, `isAxiosError`) failed
before its first test.

## Implementation Plan

1. `isStandaloneClassProtoObjectExpression` (class-proto-object.ts): also
   accept `this.prototype` whose `this` is a static class element's (walk
   through arrow functions), and an identifier bound (one hop, unannotated) to
   such an expression.
2. New `bindingHoldsStandaloneClassProto(ctx, decl)`; every slot-typer forces
   `externref` for it: `localTypeForDeclaration` (statement cascade), the
   let/const pre-hoister and the var hoister (`carrierForcesExternref` /
   `hardForcesExternref`, index.ts), and `moduleGlobalWasmType`
   (declarations.ts) — they must agree, or a hoisted slot and its declaration
   diverge.

A false match only keeps a slot on `externref`, which carries every value.
Standalone-only (`ctx.standalone` gate in the predicate).

## Resolution

Implemented as planned. Test `tests/issue-7053-standalone-class-proto-binding.test.ts`
(module init, `this.prototype` argument, local binding, null-check of the
local; control for an absent method). gc binaries byte-identical.

Out of scope, filed as [#7061](./7061-standalone-instance-misses-runtime-proto-methods.md):
an instance created from `C` does not see methods later installed on
`C.prototype` with `Object.defineProperty`.
