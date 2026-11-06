---
id: 7283
title: "IR: propertyHelper verifyProperty (and the other 130-file harness units) on the IR path"
status: done
completed: 2026-11-06
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
related: [7269, 7272, 7266, 2949, 7106, 7127]
depends_on: [7127]
assignee: "ttraenkler/c-r11"
---

# IR: propertyHelper verifyProperty on the IR path

## Problem

After #7272, every propertyHelper includer still compiles seven harness
units legacy. That keeps the whole ~130-file block (wrapped stride 40) out of
`ir_only_pass`. The seven are `verifyProperty`, `verifyCallableProperty`,
`verifyAccessorProperty`, `verifyEqualTo`, the two `verifyPrimordial*` units
and `<module-init>`. verifyProperty is the unit every includer calls.

## Measurement: stopped at two contract questions

Base: `issue-7272-ir-iswritable-first-statement` @ `8926791e` (#7272 on
#7269 `aad8abd8`). Measured on `built-ins/Boolean/prop-desc.js`, wrapped
standalone, `JS2WASM_IR_SHAPE_DIAG=1`. For verifyProperty's chain I used an
inline copy of propertyHelper (`.tmp/vp.py`), stubbing each refusal in turn.

### First refusal of each legacy unit (real harness)

| unit | first refusal |
| --- | --- |
| verifyProperty | `vardecl-module-binding-alias` on `__getOwnPropertyNames(desc)` |
| verifyCallableProperty | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` (a function value as a logical operand) |
| verifyAccessorProperty | `param-type-unresolved(desc)` |
| verifyEqualTo | `param-dynamic-carrier-diverges-from-legacy(value)` (was `abi-signature-parity` before the #7265@418467f9 merge) |
| verifyPrimordialCallableProperty | `param-dynamic-carrier-diverges-from-legacy(options)` |
| verifyPrimordialAccessorProperty | `param-dynamic-carrier-diverges-from-legacy(desc)` |
| `<module-init>` | `expr-ident-not-in-scope` on `Function` |

### verifyProperty's chain, peeled in order

| # | construct | refusal | kind of fix |
| --- | --- | --- | --- |
| 1 | `var names = __getOwnPropertyNames(desc)` + `names.length` / `names[i]` loop | `vardecl-module-binding-alias` | new stored static (`Object.getOwnPropertyNames` → dynamic array) plus a loop over a dynamic array-like. Bounded, but its own slice. |
| 2 | `assert.sameValue(originalDesc, undefined, label + "…")` as a statement | `move-only[concrete]` | **admission (g):** the scan admits a function-object member call (`assert.sameValue`) only in dyn position. A statement drops the result, like the existing statement-position direct-call rule. Measured, ~2 lines. |
| 3 | `assert(__hasOwnProperty(obj, name), …)` | `move-only[dyn]` | **admission (h):** a certified boolean alias call is a concrete operand `boxConcreteToDynamic` boxes, like a comparison (`concreteDynamicAssignmentOperandIsBuildable`). Measured. |
| 4 | `assert.notSameValue(desc, null, "…")` | `move-only[dyn]` (a `null` argument into a dynamic carrier) | **contract: stop.** IR has no producer for a dynamic `null`. `lowerExpr(null, dynamic)` refuses (`nullValueAdmissible`), there is no `dyn.null` op, and `IrDynamicLowering` has `emitUndefined` but no null. Adding one decides how JS null is represented on each lane's carrier. |
| 5 | `__push(failures, label + "…" + String(desc.value))`, `__join(failures, '; ')` | (stubbed) | uncurried `Array.prototype.push` / `join` aliases on a local array, plus a dynamic string concat. Not measured further. |
| 6 | `if (__hasOwnProperty(desc, 'value'))` | `condition-module-value-nonbool` | **admission (i):** a certified boolean alias call through the module binding (not a shadowing local, no module-value argument) is exactly boolean in `trackedModuleInfluenceIsBoolean`. This is the call-result arm only; #7266's value arms are untouched. Measured. |
| 7 | `__hasOwnProperty(desc, 'enumerable') && desc.enumerable !== undefined` | `move-only[concrete]` on `desc.enumerable !== undefined` | **contract: stop.** `dynamicMemberEqualityOperandIsBuildable` refuses a dynamic member read as an equality operand in any value-used function (the callback-boundary carrier seam: legacy array HOFs pass the direct array carrier). verifyProperty is value-used (`var verifyPrimordialProperty = verifyProperty`; `options && options.verifyProperty \|\| verifyProperty`). Narrowing that rule changes the seam's safety contract. |

## What this PR ships (lead decision, 2026-11-06)

Every measured slice that stays under the existing contract ships, even
though Boolean/prop-desc stays at 7/25. Each peeled step shortens the chain
the next lane inherits.

- **(1) `__getOwnPropertyNames`:** `Object.getOwnPropertyNames` joins
  `STORED_STATICS` (arity 1, dynamic result, provider `__getOwnPropertyNames`,
  exactly legacy's `emitStoredObjectIntrospectionCall`). `names.length` and
  `names[i]` in a counted loop then go through the existing dynamic
  member-read and relational arms.
- **(g)** A statement-position member call on a stable function object
  (`assert.sameValue(desc, undefined, msg)`): the move-only scan already
  admits it in dyn position, and a statement drops the result. This mirrors
  the statement-position direct-call rule.
- **(h)** A certified boolean alias call through the module binding
  (`isModuleBooleanAliasCall`) is a concrete operand that
  `boxConcreteToDynamic` boxes like a comparison: `assert(__hasOwnProperty(o, k), …)`.
- **(i)** The same call is exactly boolean in `trackedModuleInfluenceIsBoolean`:
  `if (__hasOwnProperty(desc, 'value'))`. This is the call-result arm only;
  #7266's value arms are untouched.
- **(j)** A local call's boolean result as a strict-equality operand
  (`desc.writable !== isWritable(obj, name)`). This reuses #7265's
  local-bool-call test, now one helper (`isLocalBoolCall`) shared by both
  sites.

With the stubs for the remaining blockers below, verifyProperty becomes a
whole IR unit. The inline harness copy passes on gc and standalone, and so do
mutated-failure copies (wrong value or writable, a missing property), which
each throw Test262Error.

## What still blocks verifyProperty

| # | construct | owner |
| --- | --- | --- |
| 4 | `assert.notSameValue(desc, null, …)`: a `null` argument into a dynamic carrier | depends on **#7127** (dynamic-null lowering, another lane) |
| 5 | `__push(failures, …)` / `__join(failures, '; ')`: uncurried `Array.prototype` aliases on a local array | next slice |
| 7 | `desc.enumerable !== undefined` and `names[i] === "value"`: dynamic member reads as equality operands in a value-used function | **#2949** contract question (the lead's proposal on #6583: module-var aliases that are only read, never called through the carrier, should not make the function value-used) |
| 8 | `__defineProperty(obj, name, originalDesc)` (`options.restore`): the stored `Object.defineProperty` alias | next slice |

## Decisions (recorded)

1. **Dynamic `null`:** not re-implemented here. It depends on #7127 (null
   literals use the existing null reference, boxed only for proven externref
   dynamic consumers).
2. **The value-used seam:** a #2949 contract question. The lead posted the
   proposal on #6583.
