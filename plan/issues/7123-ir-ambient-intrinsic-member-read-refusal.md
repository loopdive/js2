---
id: 7123
title: "IR: keep member reads off ambient intrinsics (`Error.prototype.x`, `TypeError.call`) on the legacy path — wrong code under #7118"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c-remote"
# 2026-10-22 (re-merge after #6829 landed): this PR stacks on #6846 (#7118), whose
# `dyn.intrinsic_value` growth was granted by the #7106 issue file while #6829 sat
# in the diff; restated here until #6846 lands (CLAUDE.md "stranded grants").
func-budget-allow:
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/select.ts::isPhase1Expr
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/from-ast.ts
  - src/ir/builder.ts
  - src/ir/runtime/verify.ts
  - src/ir/core/nodes.ts
  - src/ir/prepared-component-dependencies.ts
---

## Problem

[#7118](7118-ir-ambient-intrinsic-values.md) reads an ambient intrinsic
(`TypeError`, `Object`, …) in an IR body as
`dyn.member_get(dyn.global_object, "<Name>")`. A member read off that value
goes through the IR's generic `__extern_get` chain, and for several shapes it
answers differently from legacy and node (measured on standalone and on the
default gc lane, base `64e40372`):

| Expression (in `<module-init>`) | node | legacy | IR (#7118) |
| --- | --- | --- | --- |
| `typeof Error.prototype.toString` | `"function"` | `"function"` | `"undefined"` |
| `typeof Error.prototype.message` | `"string"` | `"string"` | `"undefined"` |
| `TypeError.prototype.constructor === TypeError` | `true` | `true` | `false` |
| `typeof Array.prototype.push` | `"function"` | `"function"` | wrong |
| `typeof Function.prototype` | `"function"` | `"function"` | `"object"` |
| `typeof TypeError.call` / `.apply` / `.bind` | `"function"` | `"function"` | wrong |
| `typeof Object.hasOwnProperty` | `"function"` | `"function"` | wrong |
| `Object.getPrototypeOf(TypeError.prototype) === Error.prototype` | `true` | `true` | `false` |

Root cause: legacy lowers `<Builtin>.prototype.<m>` (and the inherited
`Function.prototype` members) syntactically, so its pre-scan
`isProtoMemberValueUse` (`src/codegen/array-holes.ts`) treats
"object of a member access" as handled and seeds no runtime companion
(`protoMemberDirty` stays off — the `Error["prototype"]` spelling, which does
arm it, links ~577 more helpers and answers correctly). The IR reads the same
member dynamically and finds only the members that are present without the
companion (`name`). Inherited `Function.prototype` reads off an intrinsic
constructor (`TypeError.call`) are wrong even when the flag is armed, so
arming the flag from the IR is not a sufficient fix.

## Change

`isMemberReadReceiver` (`src/ir/values/ambient-intrinsics.ts`): the selector
refuses an ambient intrinsic that is the receiver of a property or element
access (through parentheses). The function falls back to legacy, which answers
every row above as node does. Opaque uses — a call argument
(`assert.throws(TypeError, fn)`, the shape #7118 was for), `typeof`, identity
comparison — still claim.

## Measured

- Each row in the table: IR body now refused, standalone and gc answer as node
  (`tests/issue-7118-ambient-intrinsic-values.test.ts`, `MEMBER_READS`).
- Census (`N=200 SEED=7`, standalone, `JS2WASM_IR_SHAPE_DIAG=1`), before → after:
  legacy units 1503 → 1315, compile ok 198 → 198, zero-legacy rows 1 → 1,
  `expr-ident-not-in-scope` units 264 → 282. The drop is `formatSimpleValue`
  (assert.js) claiming again in 187/200 files: under #7118, `Object` in
  `Object.prototype.toString.call(value)` counted as a dynamic value, which
  displaced the legacy-exact S1c `Object.prototype.toString.call` arm
  (`move-only[dyn]` → `param-type-not-resolvable`); with the receiver refused,
  that arm selects again. The +18 `expr-ident-not-in-scope` are the refused
  member reads.
- Conformance A/B (`runTest262File`, standalone, the first 40 changed files):
  31 pass → pass, 8 fail → fail, 1 compile_error → compile_error; no flips.

## Census of the remaining `expr-ident-not-in-scope` identifiers (the original rc-5 ask)

Base `64e40372`, 200 files: `assert` 154 files (149 as `<module-init>`, owned
by #6831), `verifyPrimordialProperty` 24 (propertyHelper, #6843/#6847),
`nonAtomicsFriendlyTypedArrayConstructors` 12, `Int32Array` 12,
`Float16Array` 12, `Reflect` 3, `$262` 2. Each is the first refusal in a
harness function that has further refusals, so admitting a name alone moves no
row to `ir_only_pass`.

Allowlist candidates measured (legacy `N === globalThis.N` + a typical use +
IR claim, standalone and gc, against node):

- **Legacy itself disagrees with node** (not admissible): every typed-array
  constructor, `SharedArrayBuffer`, `AggregateError`, `Atomics`, `WeakRef`,
  `FinalizationRegistry`. `Float16Array` is absent in node 22. `Intl` is a
  compile error on both lanes.
- **IR wrong where legacy is right**: `Math` (`Math.PI`, `Math.E`), `JSON`
  (`JSON.parse(..)` results). Legacy's own `globalThis.Math.PI` /
  `globalThis.JSON.parse` are wrong too, so the realm global object does not
  carry the real `Math`/`JSON` there.
- **Pass every measured opaque shape**: `Reflect`, `Map`, `Set`, `WeakMap`,
  `WeakSet`, `Promise`, `RegExp`, `Date`, `Proxy`, `ArrayBuffer`, `DataView`,
  `BigInt`. Not admitted here: with member reads refused, the census rows that
  name them (`Reflect.construct(...)` in `isConstructor`) stay refused anyway,
  so admitting them buys no row and adds exposure.

## Left

- Fix the dynamic read itself so member reads off intrinsics can return to the
  IR: seed the brand companion for an IR-claimed dynamic read of
  `<Builtin>.prototype`, and resolve inherited `Function.prototype` members on
  intrinsic constructor values in `__extern_get`.
- The same `__extern_get` gap is reachable from any IR-claimed function that
  reads an inherited member off a native constructor value it was handed as a
  dynamic parameter; not measured here.
- `NaN` / `Infinity` / `globalThis` / `$262` were not admitted.
