---
id: 742
title: "Extract and refactor compileCallExpression (3,350 lines)"
status: in-progress
assignee: ttraenkler/cs-1931
created: 2026-03-17
updated: 2026-06-17
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

## Progress — incremental step 1 (2026-06-17, PR by cs-1931)

Started the decomposition with the **self-contained early-guard prelude** of
`compileCallExpression`, the lowest-risk slice (the prior attempt was reverted
for doing too much at once / branching wrong, so this proceeds incrementally
off current `origin/main`).

Extracted into a new `src/codegen/expressions/calls-guards.ts`, each as a
`(ctx, fctx, expr) => InnerResult | undefined` handler (undefined = not-my-case,
caller continues dispatch):

- `tryNamespaceNonCallable` — `Math()/JSON()/Reflect()/Atomics()/Proxy()` as a
  function throw TypeError (#1732/#2180).
- `tryJsxRuntimeCall` — `_jsx/_jsxs/_jsxDEV` runtime intercept (#1540).
- `tryRegExpConstructorCall` — `RegExp(p, f)` without `new`.
- `tryObjectCoercionCall` — `Object(x)` ToObject coercion (#1129/#1568).

`compileCallExpression`: 9,437 → 9,242 lines. **Behaviour-preserving** — a
WAT-hash oracle over 25 call-heavy programs is byte-identical before/after.
Tests: `tests/issue-742.test.ts` (wasm≡JS for the extracted guards).

**Remaining** (future PRs, same incremental pattern + WAT oracle): continue
pulling self-contained guard/dispatch blocks out of the prelude; then tackle the
method-dispatch core; finally the table-driven callee registry (re-scope item a).
Builtin lowerings stay deferred to #2088's per-builtin scaffold (re-scope item b).
Issue stays `in-progress`.
