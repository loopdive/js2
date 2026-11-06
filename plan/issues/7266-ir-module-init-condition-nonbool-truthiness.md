---
id: 7266
title: "IR module-init: admit truthiness tests of non-boolean module values"
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
related: [4512, 7240, 7124]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-06 (#7266): select.ts +24 — the one truthiness predicate and its
  # two composed condition/`!` helpers (+18 incl. doc), the updated
  # isPhase1ConditionExpr doc (+1). They read select.ts's per-run selector
  # state (`moduleBinding`, `currentDynamicRuntimeBuildable`), the same state
  # their siblings (`isDirectBooleanModuleBinding`, `trackedModuleInfluenceIsBoolean`)
  # read, so they cannot move to a stateless module without threading it.
  - src/ir/select.ts
---

# #7266 — IR module-init: admit truthiness tests of non-boolean module values

## Problem

`isPhase1ConditionExpr` (`src/ir/select.ts`) refuses every condition whose
truthiness operand is a module value with a non-boolean representation
(`condition-module-value-nonbool`, `-truthiness`, `-extern-truthiness`). The IR
already owns a canonical §7.1.2 ToBoolean per carrier
(`lowerToBooleanForCondition`, #4512), so for carriers it can lower host-free
the refusal is stale.

## Measurements (main `9129f7e1`, 2026-11-06)

Wrapped stride-40 standalone census, unmasked:
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json .tmp/base-files.json`
(1296 files, 14448 units). The plain `JS2WASM_IR_SHAPE_DIAG=1` run shows **no**
condition parts at all: `shapeNo` is first-wins and the module-init walk stops
at its first rejected statement, so these parts are visible only with
`MODULE_INIT_ALL_REJECTS` (#7124).

251 `condition-module-*` parts in 50 `<module-init>` units, all
`condition-module-value-nonbool` (no `-truthiness` / `-extern-truthiness`
parts in this sample):

| Statement | Source | Operand representation | Files | Sole blocker |
| --- | --- | --- | ---: | ---: |
| `if (makeIterable) …push(makeIterable)` | `harness/testTypedArray.js:168` | `dynamic` (bare `var`, function assigned in a branch) | 48 | 0 |
| `if (makeResizableArrayBuffer) …` | `harness/testTypedArray.js:170` | `dynamic` | 48 | 0 |
| `if (makeGrownArrayBuffer) …` | `harness/testTypedArray.js:171` | `dynamic` | 48 | 0 |
| `if (makeShrunkArrayBuffer) …` | `harness/testTypedArray.js:172` | `dynamic` | 48 | 0 |
| `if (makeImmutableArrayBuffer) …` | `harness/testTypedArray.js:173` | `dynamic` | 48 | 0 |
| `if (!thrown)` | `test/harness/assertRelativeDateMs.js:28` | `dynamic` (`null` / catch binding) | 1 | 0 |
| `if (!(__str__instance.hasOwnProperty("length")))` | `test/built-ins/String/S15.5.5.1_A4_T1.js:15` | call on a dynamic module value | 1 | 0 |

No part is a unit's only refusal: the 50 module-inits carry 6–33 other
refusals each (27 of them exactly 17: module array storage, `Float16Array` /
`BigInt64Array` / `ArrayBuffer` / `Object` not in scope,
`typeof Symbol … && Symbol.iterator` as a value, …). So this admission removes
a blocker class but cannot move the zero-legacy count by itself.

## Implementation Plan

- **Module.** `src/ir/select.ts` only, next to `isDirectBooleanModuleBinding`.
  No from-ast change: `lowerToBooleanForCondition` (#4512) already lowers each
  admitted read type host-free — f64 `abs(x) > 0`, dynamic `dyn.truthy`
  (the canonical ToBoolean engine legacy also calls), i32 pass-through.
- **One predicate.** `isTruthinessTestableModuleBinding(expr)`: a direct module
  binding whose value kind is boolean i32, `f64`, or `dynamic` where the lane
  builds the dynamic runtime (`currentDynamicRuntimeBuildable`, the gate the
  dynamic `||` / `&&` arm already uses). It is read by all three sites that
  decide a module value's truthiness: the two condition checks in
  `isPhase1ConditionExpr` and the `!` arm of `isPhase1Expr`.
  `moduleInfluenceIsTruthinessTestable` = boolean influence OR that predicate.
- **Deliberately not admitted.** `string`, `class-instance`, `extern`,
  `capability-extern`, `native-map`: their slots are nullable, and the IR read
  types (`string` → length, `class` → constant `true`) or the host-only extern
  truthiness would be wrong or need a host. Compound operands (`!n && m`,
  `n ? 0 : m`) keep their value-family refusal. The `__str__instance` call
  stays refused (module-rooted call, no result proof).
- **Quality criterion.** One new predicate + one composed helper, no new arm
  shape, no duplicated truthiness table; the lowering stays the single
  `lowerToBooleanForCondition`.

## Results (head vs base, same census)

- `condition-module-value-nonbool` parts 251 → 1; newly visible behind them:
  +5 `expr-new-error-constructor` (`throw new Error` in the guarded arms).
- compileOk unchanged, invariants 0 → 0, route-changed files 0, zero-legacy
  files 32 → 32, unit routes identical (ir 1137 / both 8561 / legacy 4750).
- Playground corpus (13 files × gc / standalone / wasi): byte-identical.
- test262 A/B (the 50 affected files + 300 seeded-random, standalone + gc):
  see the PR body.

## Follow-ups found (pre-existing on main, not caused here)

Both are claim-then-demote mismatches (selector admits, from-ast demotes at
build with an `unsupported` code, legacy body kept, output correct):

- `throw 1` in a script module-init → `throw-value-unsupported`
  ("throw val not in slice 9").
- `t = null` into a dynamic script `var` → `nullish-value-unsupported`
  ("bare 'null' in non-reference context (dynamic)").

## Acceptance criteria

- [x] f64 / dynamic direct module bindings admitted in `if`, ternary
  condition and `!`; string / class-instance / extern stay refused.
- [x] ToBoolean edge values (`0`, `-0`, `NaN`, `""`, `"0"`, `true`, `7`) match
  JS on standalone, WASI and gc (`tests/issue-7266-*.test.ts`;
  fails 8/18 on main, passes 18/18 on head).
- [x] Ledger invariants 0, no route regressions; corpus byte-identical.
- [x] Quality: one shared predicate, no new lowering arm.
