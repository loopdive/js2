---
id: 4393
title: "Annex B function-scope if/switch declarations skip outer-binding lifecycle"
status: done
sprint: current
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: annex-b, function-declarations, hoisting
goal: es5
assignee: ttraenkler/codex-es5-annexb-function
related: [1518, 2200, 2552, 4166]
files:
  - src/codegen/annexb-cancel.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/nested-declarations.ts
  - tests/issue-4393-annexb-if-switch-lifecycle.test.ts
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
---

# #4393 — Annex B function-scope if/switch outer-binding lifecycle

## Problem

Annex B B.3.3 gives a sloppy function declaration in a statement position a
second, var-scoped binding in the enclosing function. That outer binding must
exist as `undefined` when the function activation begins, remain mutable, and
receive the function value only when control evaluates the declaration.

The current Phase-2 allocator in
`src/codegen/statements/nested-declarations.ts` recognizes only a declaration
whose direct parent is an explicit `Block`. It therefore misses the other two
statement-position shapes already recognized by the canonical
`annexBDeclaringRange` helper: an Annex B `if` arm and a `switch` case/default
clause. Those declarations follow ordinary eager function hoisting instead, so
a read before their statement evaluates observes the function object rather
than `undefined`.

## Fresh standalone evidence

Baseline: `origin/main` `a28c6bfcb3df2e61dcfd63a7baddfb0d5d33c711`,
published standalone oracle v13 fetched 2026-08-12. The complete maintained
ES5 failure population in the assigned directories is 77 rows: 47 under
`language/statements/function` and 30 under
`annexB/language/function-code`.

The precise root-cause family is eight `*-func-init.js` rows:

- `block-decl-func-init.js`;
- five `if-*` declaration-position variants;
- `switch-case-func-init.js`;
- `switch-dflt-func-init.js`.

The baseline JSONL grouped `block-decl-func-init.js` by its first assertion, but
execution exposed the same assignment-lifecycle failure at its second
assertion. All eight therefore share one implementation root. The originally
claimed seven `if`/`switch` rows fail before the declaration is evaluated: the
five `if` rows report `Expected SameValue(function, undefined)` and the two
switch rows report `ReferenceError: f is not defined`.

## Implementation boundary

Use `annexBDeclaringRange` as the single definition of an eligible Annex B
statement position, preserving the existing cancellation, observation,
reassignment, lexical-binder, and same-name-var guards. Recursively collect
direct `if`-arm declarations, mark ordinary assignments as writes to the
synthetic outer binding, and prevent function-local Annex B bindings from
escaping their owning activation. Do not add test-name or path-specific
handling.

These generated tests execute inside a top-level synthesized IIFE. Today that
IIFE and its lifted declaration bodies are created before a source-function
body can be claimed by the function IR pipeline, so this is an AST
hoist/lifecycle boundary rather than an IR lowering site. When synthesized
IIFEs and Annex B binding instantiation become IR-owned, the lifecycle operation
must move with them; this issue must not create a second IR-invisible semantic
implementation.

## Acceptance criteria

- [x] All seven maintained ES5 `if`/`switch` `*-func-init.js` rows pass in the
      standalone lane.
- [x] The explicit-block lifecycle twin passes its complete lifecycle, including
      the assignment assertion hidden by the baseline's first-error grouping.
- [x] The affected declarations read as `undefined` before evaluation, accept
      an ordinary assignment, and receive the function value only at the
      declaration site.
- [x] A same-SHA standalone comparison of the full 159-file Annex B
      function-code directory has zero pass-to-nonpass regressions.
- [x] Focused host and standalone tests prove the three declaration positions
      without host imports in the standalone artifacts.

## Result

On the implementation SHA, the focused regression is 18/18: the eight
lifecycle files pass in both host and standalone lanes, and a representative
existing-direct-function case remains passing in both lanes. The fresh
same-base standalone comparison over all 159 Annex B function-code files moves
from 128 to 146 passes: 18 non-pass-to-pass transitions and zero
pass-to-nonpass regressions.
