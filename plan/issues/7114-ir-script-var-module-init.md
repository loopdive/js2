---
id: 7114
title: "IR <module-init>: claim a SCRIPT's top-level var declarations (gate, redeclaration, externref dynamic home)"
status: done
sprint: current
created: 2026-10-21
updated: 2026-10-21
completed: 2026-10-21
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c"
# 2026-10-21: the second codegen predicate (`scriptVarSlotIsDynamicHome`) is
# one resolver-option line at each of the two construction sites
# (`planIrOverlay`, `compileIrPathFunctions`), next to #7105's `admitScriptVar`.
# The resolver/select/from-ast growth is the three arms below; the new logic
# sits in small helpers (`isScriptDynamicHome`, `isJsExpandoTarget`,
# `isDirectTopLevelVariableDeclaration`, `isRedeclaredModuleVar`,
# `boxForDynamicModuleStorage`) so no function crosses its ceiling.
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
---

## Problem

`ir_only_pass` counts a test262 row only when every unit, `<module-init>`
included, ships an IR body. Every test262 body is a **script**, and the
module-init selector refused any top-level `var` statement (`vardecl-var-kind`)
unless the source had an update-retyped dynamic binding (#4208 S2). So the
first `var x = 1;` of a test body demoted the whole `<module-init>`.

Census on 2026-10-21: 300 sampled tests, harness statements skipped, main plus
this change. Script `var` storage is the most common **first** body blocker
(54 tests) and appears in 68. `var x;` without an initializer adds 11–13 more.
By initializer: object literal 22, `new C` 17, none 17, `new Date` 13, array
literal 13, string 6.

## Change

1. **Gate.** `assessModuleInit` opens the module-init `var` gate for every
   script, not only for sources with dynamic updates. The binding resolver,
   together with codegen's #7105 `admitScriptVar` predicate, still refuses each
   declaration it cannot place, as `vardecl-module-storage-unrepresentable`.
2. **Redeclaration.** A repeated script `var x` is one binding with one legacy
   slot. The first declaration is the canonical identity
   (`uniqueTopLevelVariableDeclaration(…, allowRedeclaredVar)`). A later
   declaration with an initializer lowers as a slot write; a bare one is a
   no-op. A same-named function or class declaration still rejects. A JS
   expando target (`o` in `o.p = 1`, which TypeScript records as a
   declaration of `o`) is not a second binding.
3. **Externref dynamic home.** `scriptVarSlotIsDynamicHome` is #7105's
   sole-home predicate for a slot legacy allocated as `externref`. That covers
   `var o = undefined`, a `var` retyped by heterogeneous redeclaration, and a
   widened slot. Off fast mode `externref` is exactly
   `resolveIrDynamicCarrierType`, so the IR binds such a `var` as a `dynamic`
   module binding whatever its checker type. Writes to a dynamic module slot
   box the concrete value (`boxForDynamicModuleStorage`).
4. **Bare `var x;`.** A first declaration without an initializer is a no-op
   that brings the prologue-seeded slot into scope
   (`bindUninitializedModuleVar`).

## Merge order

Stacked on #6837 (`claude/7106-module-init-gdi-prologue`). An IR-claimed
`<module-init>` used to replace legacy's whole body, including the
GlobalDeclarationInstantiation prologue: `var` `undefined` seeds and the
realm-object publication of script functions and vars. #6837 runs that
prologue before the IR statements. This slice relies on it twice: a read
before the declaration sees the seeded `undefined`, and a bare `var x;` is a
no-op at its position.

#6837 also retires the live-function-binding refusal. That exposed a merged
`var g` / `function g`: under the checker the script `var` has its own symbol,
but the binding and its slot belong to the function. Codegen's
sole-home predicate now refuses a name that is also a function binding, or a
slot that is not legacy's `__mod_<name>`.

## Not in this slice

- Object-, array-, class- and `Date`-typed script vars. Legacy gives these a
  typed struct slot, not `externref`, and the IR has no module-binding kind for
  reference structs yet (the same gap blocks `let`/`const`).
- Top-level `for (var i …)` (`for-init-var-kind`).

## Acceptance

`tests/issue-7106-script-var.test.ts`: unique, redeclared, read-by-function,
heterogeneous, dynamic-write, uninitialized and read-before-declaration vars
claim `<module-init>` and run on
standalone and gc, and a failing check still throws. A `var` merged with a
function declaration compiles and stays legacy. `check:ir-fallbacks` OK. Neighbour suites
(#2949, #3142, #3523, #4208, #4489, #4491, #5289, #6894, #6937, #7105, #7106):
no new failures. All 48 failures there reproduce identically on unmodified
`src`.
