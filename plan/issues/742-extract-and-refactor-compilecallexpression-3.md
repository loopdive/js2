---
id: 742
title: "Extract and refactor compileCallExpression (3,350 lines)"
status: ready
created: 2026-03-17
updated: 2026-06-12
priority: medium
feasibility: medium
goal: maintainability
sprint: 63
depends_on: [688]
files:
  src/codegen/expressions.ts:
    breaking:
      - "extract compileCallExpression (3,350 lines) into calls.ts"
      - "convert dispatch to table-driven pattern"
---
# #742 — Extract and refactor compileCallExpression (3,350 lines)

## Status: open

## Problem

`compileCallExpression` is 3,350 lines — the largest single function in the codebase. It's a massive if/else chain dispatching on callee type, method name, and receiver type. Previous extraction attempt (#688 step 9) was reverted due to a bug.

## Approach

1. Extract into `src/codegen/calls.ts` (retry of #688 step 9)
2. Must work on the current expressions.ts (14,314 lines) which already has 8 extractions
3. Careful dependency analysis — many functions were moved to other modules
4. Convert the dispatch chain to a table: `Map<string, CompileHandler>`

## What to extract
- `compileCallExpression` (3,350 lines)
- `compileNewExpression` (777 lines)
- `compileClosureCall`, `compileCallablePropertyCall`
- `compileSuperMethodCall`, `compileSuperElementMethodCall`
- `compileExternMethodCall`
- `compileOptionalCallExpression`, `compileOptionalDirectCall`
- Builtins: `compileMathCall` (355), `compileDateMethodCall` (267), `compileConsoleCall`, `compileConsoleCallWasi`
- IIFE handling, spread args

## Previous attempt failure
The agent branched before other extractions, so imports pointed to wrong modules. Must branch from current main.

## Complexity: L

## Unblocked + re-scope note (2026-06-12)

Blocker #688 is long done — flipped to `ready`. Content is stale on every fact (compileCallExpression is now ~9,082 lines, was 3,350; the expressions/ split happened). Re-scope before dispatch: (a) table-driven callee dispatch registry, (b) builtin lowerings migrate into #2088's per-builtin scaffold. Bug density in calls.ts is LOW (0.9/KLOC) — this is maintainability work, not a correctness lever.
