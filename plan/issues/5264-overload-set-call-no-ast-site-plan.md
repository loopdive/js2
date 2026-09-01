---
id: 5264
title: "Exported overload set: `direct call to \"increment\" has no exact AST-site plan in runCase` — IR-first skips the legacy body then cannot patch it (1 test skipped in issue-4267)"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: medium
horizon: s
complexity: S
feasibility: medium
reasoning_effort: medium
task_type: bug-fix
area: ir, codegen
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [4267, 4268, 3523]
---

# Exported overload set has no exact AST-site plan for its own call

## Problem

`tests/issue-4267-overload-inventory-owner.test.ts` →
`emits one runtime export for an exported overload set` fails on `main`:

```
ir/from-ast: direct call to "increment" has no exact AST-site plan in runCase [IR-FALLBACK]
IR-first (#2138): runCase failed after its legacy body was skipped:
  … [unpatched-slot; ir-unit:v1:…:root:top-level-function:0000000000000001]
IR outcome invariant [unpatched-slot] for runCase
```

The unit's legacy body is skipped on the promise that IR owns it, and then
`from-ast` has no AST-site plan for the call into the overload set — so the
slot is left unpatched. That is the #2138 compile-once inversion failing
closed, which is correct behaviour for a missing plan, but the missing plan
itself is the defect: an exported overload set is ordinary TypeScript.

## Evidence

Measured 2026-08-31 during #3523 gap 4, on pristine `origin/main` (test file
and compiler sources both from main): fails there identically, so it is not a
gap-4 regression. Skipped (`it.skip`) by gap 4 with the measurement recorded
inline, because gap 4 had to edit this file's outcome-row fixture and touching
a file pulls it into the required `quality` gate.

The sibling test in the same file (`runs an internal generic overload through
its body-bearing implementation`) passes, so the gap is specific to the
EXPORTED overload set, not overloads generally.

## Acceptance criteria

1. `from-ast` produces an exact AST-site plan for a call into an exported
   overload set, OR the selector declines the unit up front so its legacy body
   is never skipped (a typed `unsupported` demote, not an `unpatched-slot`
   invariant).
2. The skipped test is **un-skipped** and passes.
3. `pnpm run check:ir-fallbacks` shows no unintended bucket growth.
