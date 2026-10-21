---
id: 7109
title: "IR: `delete obj[name];` over dynamic parameters (propertyHelper's `isConfigurable`) — `dyn.delete_property`"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-21
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7109, #7106 S2d): one new IR instruction (`dyn.delete_property`,
# a new dialect kind) threaded through its node, verifier, builder, lowering,
# pre-registration and passes — the same shape as S1e/S3a — plus the selector's
# statement arm, the from-ast arm and one resolver hook (legacy's own
# `isStrictContext`). The wrappers live in a new
# src/codegen/ir-dynamic-delete.ts beside the S1c/S1e/S3a wrapper files; it
# imports legacy's guard/throw/late-import helpers, so it joins the SCC, and
# integration.ts gains two ir->codegen edges (the wrapper module and
# helpers/is-strict-function.ts).
flat-dir-budget-allow:
  - src/codegen/ir-dynamic-delete.ts # 2026-10-21 (#7109): the dyn.delete_property wrappers beside ir-arguments-length.ts / ir-dynamic-construct.ts
import-cycles-allow:
  - ir->codegen: 81 # 2026-10-21 (#7109): integration.ts pre-registers the delete wrappers and asks legacy's isStrictContext
  - largestSccSize: 725 # 2026-10-21 (#7109): codegen/ir-dynamic-delete.ts joins the SCC (it imports the legacy delete guard/throw helpers)
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/runtime/verify.ts
  - src/ir/lower-generic.ts
  - src/ir/builder.ts
  - src/ir/core/nodes.ts
  - src/ir/prepared-component-dependencies.ts
func-budget-allow:
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/from-ast.ts::lowerExprUnchecked
---

# IR: dynamic `delete obj[name];`

Parent: [#7106](7106-ir-test262-harness-units.md), census row "one-off
propertyHelper arms" — the `delete` arm of `isConfigurable`.

## Problem

`isConfigurable(obj, name)` starts with `try { delete obj[name]; } catch …`.
The selector refused it: `delete` counts as a mutating statement
(`expressionStatementMutatesAtTopLevel`), so both statement walkers rejected it
(`body-exprstmt-other` / `nontail-exprstmt-other`). The IR's only `delete`
lowering is the slice-11 stub, which evaluates the operand and returns `true`
without deleting anything. It is safe only because no dynamic receiver reaches
it.

## Measured legacy behaviour (standalone, 2026-10-21)

For `delete obj[name];` with two untyped/`{object}` parameters,
`compileDeleteExpression` takes its generic arm (`typeof-delete.ts`). That arm
does not apply when the key is a literal, when the receiver is `this` or
`arguments`, or when the receiver has a struct field. The generic arm:

1. Stashes the base and the key.
2. Runs `emitExternrefDestructureGuard` on the base. A null or undefined base
   throws TypeError (§13.5.1.2 step 5.b).
3. Calls `__delete_property(base, key)` and gets back an i32 boolean.
4. In strict code (`isStrictContext`), throws TypeError when the result is
   `false` (`emitStrictDeleteCheck`, step 6.b).

Pre-existing legacy gap, recorded but not fixed here: an object literal
`{ a: 1 }` whose fields are static struct fields, passed to an externref
parameter, is not really deleted by `__delete_property`.
`hasOwnProperty("a")` stays true. Objects built dynamically, arrays, and
`defineProperty` sidecar properties are deleted correctly. The IR reaches the
same runtime, so it behaves the same way.

## Fix

- **`dyn.delete_property{receiver, key, strict}`**: a new dialect kind with
  verdict `js`, two dynamic operands and an i32 result. It is side-effecting
  and kept live by DCE. It lowers to `__ir_delete_property` or
  `__ir_delete_property_strict` (`src/codegen/ir-dynamic-delete.ts`). Each
  wrapper body is legacy's generic tail exactly: guard, `__delete_property`,
  and the strict refusal throw. Both are built with legacy's own helpers.
  Capability: `native-dynamic-delete` (wasmgc, non-fast, standalone|wasi).
- **Selector** (`dynamicDeleteStatement`): admits only the STATEMENT
  `delete <dynParam>[<dynParam>];`. It goes through the shared
  mutating-statement gate, so both walkers accept it, and the move-only scan
  treats both carriers as moves. Every other `delete` shape keeps its current
  path. That covers a literal key, a named property, value use, `arguments`,
  and `this`.
- **from-ast** (`tryLowerDynamicDelete`): both operands must be
  dynamic-carrier bindings. Strictness comes from the new resolver hook
  `dynamicDeleteIsStrict`, which is legacy's `isStrictContext` for the site.

## Acceptance

- `tests/issue-7106-s2d-dynamic-delete.test.ts` compares each verdict with
  node running the same program as strict code:
  - an own configurable property is deleted (object and array receivers);
  - a missing key is a no-op;
  - a non-configurable property throws TypeError and the property is kept;
  - a `null` or `undefined` base throws TypeError;
  - literal-key, named, and value-use deletes stay on their current paths.
- The generated wrapper is instruction-for-instruction legacy's sequence
  (inspected in WAT).
- Harness census (`sta.js + assert.js + propertyHelper.js`, standalone):
  `isConfigurable`'s first blocker moves from
  `body-exprstmt-other «delete obj[name]»` to
  `expr-binary-op-instanceof «e instanceof TypeError»`, and then to
  `throw new Test262Error` (#7106 Stage 3c).
