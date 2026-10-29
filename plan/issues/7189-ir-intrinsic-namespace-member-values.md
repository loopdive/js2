---
id: 7189
title: "IR: admit exact static-method VALUE reads off ambient namespace intrinsics (`Array.isArray`, `Object.defineProperty`, …)"
status: in-progress
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7118, 7123, 7127]
assignee: "ttraenkler/js2-17"
---

## Problem

`summary.ir_only_pass` counts a hybrid-standalone test262 row only when no
unit is legacy. The last legacy unit is usually `<module-init>`. A 1/60 census
on main put `expr-ident-not-in-scope` on `Object`/`Array`/`Function` at
module-init in about 300 tests. #7123 refuses every member read off an
ambient intrinsic. #7127 re-admits only `<R>.prototype.<method>` values, and
only once the brand companion is seeded.

## Measured (2026-10-29, base `cb3ff519`)

### Census

Every 60th file of `test/built-ins` + `test/language`: 796 files, standalone,
harness assembled with `assembleOriginalHarness`. Each refused
`Object`/`Array`/`Function` identifier at top level was classified by the
member chain above it. Module-init outcome detail, by blocking identifier:
`Object` 160, `Array` 85, `Function` 68, `verifyProperty` 67, `Test262Error` 60.

| Shape at top level | files | where it comes from |
| --- | ---: | --- |
| `Array.isArray`, `Object.defineProperty`, `Object.getOwnPropertyDescriptor`, `Object.getOwnPropertyNames` as values | 68 | propertyHelper.js prelude (`var __isArray = Array.isArray;` …) |
| `Function.prototype.call.bind(<R>.prototype.<m>)` | 68 | the same prelude |
| `Object.getPrototypeOf(…)` call | 52 | mostly testTypedArray.js (`Object.getPrototypeOf(Int8Array)`) and Iterator tests |
| `Object.prototype.hasOwnProperty.call(…)` | 30 | class-elements bodies (these also include propertyHelper) |
| `Object.getOwnPropertyDescriptor(…)` call | 15 | bodies |
| `Object.defineProperties(…)` / `Object.create(…)` calls | 10 / 8 | bodies |
| every other shape | ≤ 3 each | |

No file had `Object`/`Array`/`Function` as its only module-init blocker, so
no single shape moves a row to `ir_only_pass` by itself.

### How legacy lowers these, and what the IR's dynamic route gives

The dynamic route is `dyn.member_get` off the #7118 realm value, then a
dynamic method call. Measured with the #7123 refusal lifted, standalone,
IR vs legacy vs node:

- **Static-method value** (`var f = Object.defineProperty`). Legacy reads a
  cached builtin closure (`builtin-static-globals.ts` /
  `builtin-value-read.ts`). Legacy's own `globalThis.<NS>.<m> === <NS>.<m>`
  holds for all 22 methods measured. Through the IR, typeof, `name`, `length`
  and identity across reads match node for 21 of them. The odd one out is
  `Object.create`: legacy answers `length` wrongly (IR = node ≠ legacy), so
  it stays refused.
- **`Object.getPrototypeOf(x)` call.** Legacy uses a static,
  checker-type-directed arm (`call-builtin-static.ts` ~2368, with class,
  iterator, generator, TypedArray and `arguments` sub-arms). The dynamic
  route answers `Object.getPrototypeOf(1 | "a" | true)` wrongly (IR throws
  where legacy and node pass). The IR has no seam that hands an AST
  sub-expression to legacy's arm. **Not admitted.**
- **`Array.isArray(x)` call.** For an externref operand legacy emits exactly
  `call __extern_is_array` on standalone. The dynamic route matches on the
  primitives the IR can express. In module-init, though, every array / null /
  object / function argument is refused for other reasons, so the call buys
  no claim. **Not admitted** (see Left).

## Implementation Plan

- **Module.** `src/shared/ambient-intrinsics.ts`, the one admission predicate
  that the selector and from-ast share. No selector, lowering or IR-node
  change: the read lowers through the existing #7118 path,
  `dyn.member_get(dyn.member_get(dyn.global_object, "<NS>"), "<m>")`.
- **Change.**
  - Add `isExactStaticMethodValueRead(node)` as a third branch of
    `isAmbientIntrinsicValueUse`.
  - The intrinsic itself, never an alias, must be the receiver of
    `<NS>.<m>`, where `<m>` is in a measured `STATIC_METHOD_NAMES` table:
    `Array` {isArray, from, of}, and `Object` with 18 methods.
  - The read must be a plain value: not called, not read further, and not a
    write, `delete` or update target.
- **Reuse / duplicate removed.** #7127's `isExactProtoMethodValueRead` ends in
  the same plain-value check. That tail moves into one `isPlainMethodValue`
  helper, used by both arms, so the two cannot drift.
- **Fail-closed.** Calls keep legacy's static arms. So do further reads
  (`Object.keys.length`), unlisted or absent members (`Object.groupBy`,
  `Object.nope`), writes, alias receivers (`var O = Object; O.keys`) and
  `Object.create`.
- **Acceptance.**
  - Correctness: every listed method claims `<module-init>` with no post-claim
    error. The same source answers the same in IR (standalone), in legacy
    (standalone, IR off), on gc and in node. Every refused shape stays legacy
    and answers as node.
  - Neighbour suites (#7106, #7118, #7123, #7127): no new failures,
    base vs head.
  - Scoped standalone test262 A/B: 0 pass→fail.
  - Code quality: one new table and one predicate, beside #7127's siblings
    and in the same shape; the shared plain-value tail replaces the
    duplicated one; no new IR node, lowering arm or selector branch.

## Found, not fixed

`var __getOwnPropertyDescriptor = 1;` (and the same for
`__getOwnPropertyNames`) fails the module-init build on main with
`declaration '<name>' no longer resolves to the direct top-level binding
selected for this unit`. This is a selector/preparation mismatch (an
invariant error, so a compile error rather than a demotion). These globals
share their names with object-runtime helpers (`src/stdlib/object-runtime.ts`).
The propertyHelper.js prelude declares both, so it hits the same mismatch once
its other lines claim. That does not happen today:
`Function.prototype.call.bind(…)` still refuses the unit before build.
Owner: the #7106 propertyHelper lane.

## Left

- `Function.prototype.call.bind(<R>.prototype.<m>)` (68 files, the other half
  of the propertyHelper prelude): a call off `Function.prototype.call`, which
  #7127 measured inexact.
- `Object.getPrototypeOf(x)` (52) and `Object.getOwnPropertyDescriptor(x, k)`
  (15) calls: both need an exact producer for legacy's type-directed static
  arm.
- `Array.isArray(x)` over a dynamic operand: `__extern_is_array` is exact, but
  it is worth admitting only once module-init can express array / object
  arguments.
