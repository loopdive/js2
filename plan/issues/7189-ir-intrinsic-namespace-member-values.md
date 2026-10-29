---
id: 7189
title: "IR: admit exact static-method VALUE reads off ambient namespace intrinsics (`Array.isArray`, `Object.defineProperty`, …)"
status: done
sprint: current
created: 2026-10-29
updated: 2026-10-29
completed: 2026-10-29
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
# 2026-10-29: +1 line in `scriptVarHomeSlot`. A script `var` named like an
# object-runtime helper (`var __getOwnPropertyDescriptor = …`, propertyHelper.js)
# is no longer mistaken for a merged `function` once that helper registers into
# `funcMap` between selection and build. That mismatch failed the build
# (`selection-preparation-mismatch`). The predicate is shared by selection and
# build, so the check cannot move to a smaller file without splitting it.
loc-budget-allow:
  - src/codegen/index.ts
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
  - The read must sit in a measured value position: a `var` initializer, the
    right side of `=`, a `typeof` or `!` operand, or an equality operand.
    Every other position is refused, including calls, further reads, writes,
    destructuring, `delete` and coercions such as `"" + f`.
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

## Adversarial review (fresh context, 2026-10-29)

First pass: **NOT MET**. Findings and what was done about them:

1. **Fixed.** `isPlainMethodValue` re-implemented the write-target test and
   missed destructuring targets (`[Array.isArray] = xs`,
   `({ a: Object.keys } = o)`, `for ([Array.of] of xs)`).
   - First fixed by calling a shared `isWriteTarget` extracted from
     `src/shared/binding-writes.ts`.
   - That was superseded by the second review's position allowlist (below).
     No write position is admitted, and `binding-writes.ts` is back to
     main's version.
   - The four hand-rolled branches (assignment, postfix, update, for-in/of
     head) are gone either way, and #7127's arm gains the same coverage.
2. **Fixed.** Two parenthesis climbs became one `outermostParenthesized`.
3. **Fixed.** Both arms now end in plain `&&` instead of `cond ? … : false`.
   The new arm checks its receiver table before it walks the AST, as the
   #7127 sibling does.
4. **Rebutted.** `STATIC_METHOD_NAMES` repeats names from codegen's
   `BUILTIN_STATIC_METHOD_ARITY`, but `src/shared` cannot import codegen. The
   table is also deliberately a measured subset (`Object.create` is left out).
5. **Rebutted.** The test's arity map copies codegen's values. The "node
   agrees" cases are the independent oracle, which is the point of writing
   the values out by hand.
6. **Fixed for #7118/#7189; rest left (see Left).** The module-init `run` and
   the predicate probe are now one `tests/helpers/ambient-intrinsic-probe.ts`,
   shared by both test files.
7. **Fixed.** The gc lane now asserts `claimed` as well. gc is the native-first
   lane, projected as standalone (#7118 claims there too), and IR = legacy =
   node holds on it.
8. **Fixed.** Direct predicate tests now cover a call, a further read, an
   unlisted member, an assignment, array and object destructuring, a for-of
   head, `delete` and a numeric unary.

## Fixed along the way: helper-named script vars

`var __getOwnPropertyDescriptor = 1;` (and the same for
`__getOwnPropertyNames`) failed the module-init build on main with
`declaration '<name>' no longer resolves to the direct top-level binding
selected for this unit`. That is a `selection-preparation-mismatch` invariant,
so a compile error, not a demotion.

- **Cause.** `scriptVarHomeSlot` (`src/codegen/index.ts`) treats a `funcMap`
  entry of the same name as a `function` merged with the `var`. The
  object-runtime helper `__getOwnPropertyDescriptor` registers into `funcMap`
  only when the IR body needs the runtime (`preregisterDynamicSupport`), which
  happens after selection. So selection saw the slot and the build did not.
- **Why it became urgent.** This PR's first commit made the propertyHelper
  static lines claimable, so `var __getOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;` alone went from compiling (legacy) to a
  compile error. The second review caught this.
- **Fix.** A `funcMap` entry that is only an object-runtime helper
  (`OBJECT_RUNTIME_HELPER_NAMES`, not a source `function`) no longer counts as
  that merged function. Selection and build now agree, and these vars claim
  and run.
- **Rejected alternative.** Refusing every helper-named var broke
  `issue-7106-prophelper-dyn-delete` (`var __hasOwnProperty = …`, also a
  helper name, with a claim-then-withdraw on `hasK`), so it was dropped.

## Second review (2026-10-29, REQUEST CHANGES on `a3c9d055`)

1. **Fixed.** The new compile errors above.
2. **Fixed.** `("" + Object.is).indexOf(…)` was claimed and then withdrawn
   (`operand-coercion-unsupported`). `isPlainMethodValue` now admits only the
   measured positions. Because the check is shared, #7127's proto arm gets the
   same limit, and the #7118 tests still pass. The shared test runner now
   asserts that `irPostClaimErrors` is empty on every run. This also removed
   the need for the `isWriteTarget` extraction from the first review: an
   allowlist has no write position.
3. **Fixed.** `status: done`.
4. **Stated in the PR body.** gc output changes for these reads, because the
   native-first gc lane now claims them.

## Left

- `Function.prototype.call.bind(<R>.prototype.<m>)` (68 files, the other half
  of the propertyHelper prelude): a call off `Function.prototype.call`, which
  #7127 measured inexact.
- `Object.getPrototypeOf(x)` (52) and `Object.getOwnPropertyDescriptor(x, k)`
  (15) calls: both need an exact producer for legacy's type-directed static
  arm.
- Test-harness duplication (review finding 6): at least seven more
  `tests/issue-71*` files carry their own module-init `run` copy, for example
  `issue-7106-ir-number-conversion`, `issue-7117-*`, `issue-7122-*` and
  `issue-7125-*`. They can move onto `tests/helpers/ambient-intrinsic-probe.ts`.
  This needs its own cleanup issue; the id could not be allocated from this
  container (`claim-issue --allocate`: the open-PR scan is unavailable without
  `gh` auth).
- `Array.isArray(x)` over a dynamic operand: `__extern_is_array` is exact, but
  it is worth admitting only once module-init can express array / object
  arguments.
