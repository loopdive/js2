---
id: 7627
title: "A namespace read of a reassigned function export (`d.f()` after `f = …`) returns the original body"
status: blocked
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
parent: 7620
depends_on: [7530, 7625]
blocked_by: 7530
related: [7620, 7530, 7622]
---

# #7627 — namespace member read of a reassigned function

Child A2 of #7620. It is **blocked on #7530**, and it is re-planned once #7530's plan is approved (PRV-7620 finding 17):
the read below consumes #7530's API, whose final shape is not settled.

## Problem

dep is `export function f() { return 3; } export function swap() { f = function () { return 4; }; }`.

Measured on 2026-11-28 with node v22.23.5, on `ada18e6bb6` and on origin/main `01c9284f78`. Both bases and standalone
and gc agree. Probe: `.tmp/p7620/cases10.mjs` in the c8-7620 worktree.

| row | entry | node | IR on | IR off |
| --- | --- | --- | --- | --- |
| N0: no collision | `import * as d; d.swap(); return d.f();` | 4 | 3 | throws |
| N(b): entry declares its own `f` (returns 1) | `d.swap(); return f() * 10 + d.f();` | 14 | 43 | throws |
| N(a): a third file declares its own `f`; entry reads it through `c.h()` | `d.swap(); return h() * 10 + d.f();` | 14 | 43 | throws |
| through a value | `d.swap(); const k = d.f; return k();` | 4 | throws | throws |
| by name (guard) | `import { f, swap }; swap(); return f();` | 4 | 4 | 4 |
| no reassignment (guard) | `swap` writes a `let k` that `f` returns | 4 | 4 | throws |

- In N(a)/N(b), the "4" digit (the other module's own `f` returns 4) is #7530's shared `__mod_f`. The "3" digit
  (`d.f()` is stale) is this issue.
- The IR-off "throws" cells are #7622.

### Cause

1. `tryRuntimeNamespaceMemberCall` (`src/codegen/expressions/calls.ts:2800`) lowers `d.f()` to a direct call of `f`'s
   declaration and never asks `ctx.reassignedFunctionDeclarations`. `exactImportedTopLevelFunction`
   (`identifiers.ts:878`) does ask, which is why the by-name row is right.
2. `moduleSymbolNamespaceExports` (`module-namespace-value.ts:486-497`) declines the whole namespace object when an
   export is a reassigned function, so `const k = d.f` throws.

## Direction, to be re-planned after #7530's plan is approved

- `tryRuntimeNamespaceMemberCall` declines for a reassigned declaration. That test moves into one predicate shared
  with `exactImportedTopLevelFunction`, defined outside `identifiers.ts`, so that file does not grow.
- `moduleSymbolNamespaceExports` gets a `live` arm for a reassigned function. It reads the function's live binding
  record from #7470's table through #7530's API (`markLiveFunctionBinding` / `liveFunctionBindings`, read-only), in
  the same shape as the `var`/`let` arm (`:468`).
  - The getter reads the record's `GlobalDef` directly, never by name.
  - **Coordination point with #7530:** `withDirectRuntimeModuleBindings` (`declarations.ts:1738`) hides liveness while
    namespace bodies compile.
- It builds on #7625's `moduleNamespaceSourceOf`, hence `depends_on: [7530, 7625]`.

## Acceptance criteria

- **Pin test (red → green).** A new `tests/issue-7627-*.test.ts` holds every row above, × standalone/gc ×
  `experimentalIR` on/off, compared with node.
  - It is red on the base for N0, N(a), N(b) and through-a-value, with IR on.
  - The IR-off cells carry a comment naming #7622.
  - The guard rows stay green.
- **Code quality.**
  - No edits to #7530's regions (`module-binding-table.ts`, `source-binding-projection.ts`, `registerModuleGlobal`'s
    tail, `registerLiveFunctionGlobal`, `module-init-prologue.ts`'s seed loop).
  - One shared immutable-function predicate.
  - `identifiers.ts` does not grow.
  - An adversarial review verdict goes in the PR body.
- **No test262 regression** in the scoped `language/module-code|language/import|language/export` diff on standalone.
