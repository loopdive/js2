---
id: 7118
title: "IR: ambient intrinsics (`TypeError`, `Object`, `String`, …) as VALUES via the realm global object"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
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
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
loc-budget-allow:
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
- **Admission** (`isAmbientIntrinsicValue` in the selector), all of:
  - the name is on the allowlist in `src/ir/values/ambient-intrinsics.ts`:
    `Error` and its subclasses, `Object`, `Array`, `String`, `Number`,
    `Boolean`, `Symbol`, `Function`;
  - nothing in scope binds it;
  - it is not a module binding;
  - **every** declaration of the symbol is a lib declaration (new
    `isLibOnlyBinding`).

  The last rule is stricter than `isAmbientBinding`, which takes "some
  declaration": a script's `function Number() {}` merges with the lib
  `declare var Number`. The value is dynamic-shaped, so it flows wherever a
  dynamic value may.
- `globalThis` itself is deliberately not admitted: the checker synthesizes it
  with no lib declaration to vouch for.

## Found, not fixed

Legacy miscompiles a user function that shadows a builtin and is called by
name: `function Number() { return 7; } if (Number() !== 7) throw …` throws on
standalone (the call reaches the builtin). It reproduces identically on the
base; the IR leaves this case to legacy.

## Acceptance

`tests/issue-7118-ambient-intrinsic-values.test.ts`, every case checked against
node:
- `typeof Object/RangeError`, `TypeError.name`, `Error.name` and intrinsic
  identity claim `<module-init>` and run on standalone and gc;
- a failing check still throws;
- a module-level `function Error(a, b)` keeps its own binding: `Error.length`
  is 2.

On the #6833 stack, `assert.throws(TypeError, function () { … })` with a
capturing closure now passes the statement gate; its next blocker is the
closure's own plan. Also measured there: `Number.isNaN`, `String.fromCharCode`
and `String(5)` claim and evaluate; negated checks throw.
