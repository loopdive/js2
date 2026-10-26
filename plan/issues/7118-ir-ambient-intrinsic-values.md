---
id: 7118
title: "IR: ambient intrinsics (`TypeError`, `Object`, `String`, …) as VALUES via the realm global object"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-24
completed: 2026-10-22
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c"
# 2026-10-22: the lowering resolver gains one forwarding method
# (`isLibOnlyBinding`, beside `isAmbientBinding`), and module-bindings.ts the
# lib-only predicate those two resolvers expose.
# 2026-10-22 (after #6829 landed): the growth below was granted by the #7106
# issue file while #6829 sat in this PR's diff; with #6829 on main that file
# left the diff, so the grants are restated here (CLAUDE.md "stranded grants").
# `dyn.global_object` is one more dialect kind threaded through node,
# verifier, builder, lowering, pre-registration and the selector/from-ast arms.
func-budget-allow:
  # 2026-10-25 (#7118 refresh on main): merging main (#6848 dyn.instanceof arm) carries
  # lowerExprUnchecked over 300 (302, +2) in this change-set; the growth is #6848's, granted
  # under #7106, restated here because the gate reads only files this PR modifies.
  - src/ir/from-ast.ts::lowerExprUnchecked
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
  - src/ir/select.ts::isPhase1Expr
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/integration.ts::makeFromAstResolver
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/from-ast.ts
  - src/ir/builder.ts
  - src/ir/runtime/verify.ts
  - src/ir/core/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/module-bindings.ts
---

## Problem

`ir_only_pass` counts a test262 row only when every unit ships an IR body. An
ambient intrinsic read as a value (`TypeError` in
`assert.throws(TypeError, fn)`, `Object` in `Object.prototype…`) was
`expr-ident-not-in-scope`.

Census 2026-10-22: 200 random scripts on the #6829 → #6831 → #6833 stack,
harness statements skipped. A builtin identifier is a body blocker in about a
third of tests. The biggest names:

| identifier | tests |
|---|---:|
| `TypeError` | 21 |
| `Object` | 17 |
| `Array` | 5 |
| `String` | 2 |
| `RangeError` | 2 |
| `ReferenceError` | 2 |

`assert.throws(<ErrorCtor>, fn)` is the single most common shape. It was
accepted only when the closure was a narrow inline shape. With a closure that
captures an outer `var`, or a function reference, `TypeError` rejected.

## Change

- **New instruction `dyn.global_object`.** No operands, result `dynamic`. It
  lowers to a call to `__ir_global_object`: legacy's own `globalThis` read
  (`emitGlobalObjectAsThis`) wrapped once per module, the same pattern as S3c's
  `__ir_current_this_*`. It reuses the `native-current-this` lanes
  (standalone/WASI, not fast).
- **Intrinsic read.** An ambient intrinsic identifier is a named read off that
  object: `dyn.member_get(dyn.global_object, "<Name>")`. Every intrinsic is a
  property of the global object (§19.1, §19.3). Measured on legacy standalone:
  `globalThis.TypeError === TypeError`, and likewise for `Object`, `Array` and
  `RangeError`.
- **Admission** — ONE predicate, `isAmbientIntrinsicValueUse` in
  `src/ir/values/ambient-intrinsics.ts`, consumed by both the selector
  (`isAmbientIntrinsicValue`, which adds the lane checks and "not a module
  binding") and the from-ast identifier arm (which demotes when it says no),
  so the two cannot drift. All of:
  - the name is on the allowlist: `Error` and its subclasses, `Object`,
    `Array`, `String`, `Number`, `Boolean`, `Symbol`, `Function`;
  - **every** declaration of the symbol is a lib declaration
    (`isLibOnlyBinding`, i.e. `makeIrAmbientBindingPredicate(checker,
    "every")`), and nothing in the same file declares the name — for a
    script's top-level `function Error() {}` the checker reports the lib
    declarations alone;
  - the value reaches only **opaque** uses (#7123): `typeof`, `!`, equality,
    a truthiness test, an argument to a member callee. A member read off the
    intrinsic — or off any local or same-file-function parameter it flows
    into, transitively — refuses the unit: `var C = TypeError;
    C.prototype.constructor` goes through the same `dyn.member_get` chain
    #7123 measured wrong. `return TypeError`, `[TypeError]` and a call of the
    value are refused rather than reasoned about.

  The lib-only rule is stricter than `isAmbientBinding`, which takes "some"
  declaration: a module's `function Number() {}` merges with the lib
  `declare var Number`.
- `globalThis` itself is deliberately not admitted: the checker synthesizes it
  with no lib declaration to vouch for.

## Found, not fixed

Legacy miscompiles a user function that shadows a builtin and is called by
name: `function Number() { return 7; } if (Number() !== 7) throw …` throws on
standalone (the call reaches the builtin). It reproduces identically on the
base; the IR leaves this case to legacy.

## Acceptance

`tests/issue-7118-ambient-intrinsic-values.test.ts`, every case checked against
node, on standalone and gc:
- intrinsic identity (all 13 claiming names), an alias or parameter that is
  only `typeof`-ed or compared, and a conditional branch claim `<module-init>`
  and run;
- a failing check still throws;
- `TypeError.name`, `Error.prototype.toString`, `TypeError.call`,
  `Function.prototype` and the alias shapes (`var C = TypeError;
  C.prototype.constructor`, `typeof C.call`, `var C = Object;
  typeof C.hasOwnProperty`, `var A = Array; typeof A.prototype.push`, a
  re-alias, a conditional receiver) stay legacy and answer as node does
  (#7123);
- a module-level `function Error(a, b)` keeps its own binding through a value
  use (`var c = Error; c.length` is 2, `probe` legacy); the predicate itself is
  unit-tested against a real checker (lib-only admit, script shadow refuse,
  member read direct and through an alias refuse).

On the #6833 stack, `assert.throws(TypeError, function () { … })` with a
capturing closure now passes the statement gate; its next blocker is the
closure's own plan. Also measured there: `Number.isNaN`, `String.fromCharCode`
and `String(5)` claim and evaluate; negated checks throw.
