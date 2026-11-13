---
id: 7125
title: "IR <module-init>: a string-typed SCRIPT var in its native-string slot binds as a `string` module binding"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c-remote"
# 2026-10-22: one more codegen slot predicate (`scriptVarSlotIsStringHome`)
# beside #7105/#7106's two, wired at the same two resolver construction
# sites; the resolver arm is two small helpers (`isScriptStringHome`,
# `moduleStringStorageAdmitted`). Restated here (not only in #7114's file) so
# the grant is not stranded when this PR is measured against main.
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
---

# IR `<module-init>`: string-typed script `var` (#7125)

Stacks on #7114 (PR #6835, the script `var` gate).

## Problem

#7105/#7106 admit a SCRIPT's top-level `var` when codegen confirms its
`__mod_<name>` slot is the binding's sole home — but only for a number/boolean
slot or the `externref` dynamic home. On a native-string lane (standalone,
WASI) legacy allocates `var data = "data"` as `(mut (ref null $AnyString))`,
which is neither, so the resolver answered `undefined` and the selector
refused the whole `<module-init>` as `vardecl-module-storage-unrepresentable`.

## Change

- `scriptVarSlotIsStringHome` (`src/codegen/index.ts`): the same sole-home slot
  (eval stand-down, implicit-global and merged-function exclusions all
  inherited from `scriptVarHomeSlot`), typed exactly
  `(ref null $AnyString)` on a `nativeStrings` lane.
- `src/ir/module-bindings.ts`: a script `var` whose checker type is string and
  whose slot passes that predicate is direct (`directTopLevelDeclaration`) and
  resolves to the existing `string` value kind (`moduleStringStorageAdmitted`).
  That is the storage `resolveModuleBindingGlobal`'s `string` arm names, so its
  agreement check is a real test, never a hard ABI invariant. The R4-M1
  `let`/`const`-only rule stays for every other `var`: the widening it guards
  against goes to `externref`, which this predicate refuses.
- Host-string lanes are unchanged: there a string slot is `externref`, i.e.
  the #7106 dynamic home.

Consumers follow the existing `string` module-binding rules (value, call
argument, return, `=== null`); comparisons and `+` on the binding stay
`expr-module-extern-consumer` refusals, as for `let` strings.

## Measured

All-statement census (local diagnostic: every refused `<module-init>`
statement, not just the first) on 200 bodies, seed 7, on #6835 + #6829 +
#6833: see the PR body for the before/after counts.

## Residual

- A string `var` read before its declaration reads the slot's `null` (legacy
  does the same — the slot cannot hold `undefined`; #4489's residual). The IR
  shares the slot, so it agrees with legacy, not with the spec.
- Comparisons / concatenation on a `string` module binding (shared with
  `let` strings).
- Bigger script-`var` shapes left: class-instance slots (`var c = new C()`,
  `(ref null $C)`), array slots (`var arr = []`, the `testTypedArray.js`
  constructor arrays), and top-level `for (var i = …)` (the header `var` is not
  a direct declaration for the resolver or `buildModuleBindingsMap`; 1041
  corpus files have one).
