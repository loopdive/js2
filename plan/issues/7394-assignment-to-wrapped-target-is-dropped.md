---
id: 7394
title: "An assignment to a wrapped target (`(x) += 1`, `(x!) = 5`, `(x!)++`) compiles to nothing"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7360]
---

# #7394 — an assignment whose target sits in parentheses or a type-erased wrapper is dropped

## Problem

Found while fixing #7360 (RV7307). A target wrapped in parentheses or a TypeScript wrapper that emits
nothing (`!`, `as`, `satisfies`, `<T>`) is a valid simple assignment target (§13.15.1: the parenthesised
form is a simple target, and TypeScript erases the type wrappers). Several assignment forms on such a
target compile without an error, but the target keeps its old value:

```ts
let x: number = 2;
(x) += 5;   // node: x === 7; we leave x === 2
(x!) = 5;   // node: x === 5; we leave x === 2
```

Measured on `origin/main` 89e4748241 (2026-11-19), default and `--target standalone` alike. Targets: a local,
a class field, an array element, a module global. All four targets behave the same in every row.

| form | `(t)` / `((t))` | `(t!)` | `(t as number)` / `(t satisfies number)` |
| --- | --- | --- | --- |
| `=` | correct | **dropped** (keeps old value) | compile error "Invalid left-hand side in assignment" |
| `+=` `-=` `*=` `\|=` (every compound operator) | **dropped** | **dropped** | compile error |
| `??=` `\|\|=` `&&=` | **dropped** (`&&=` shows it; `??=`/`\|\|=` on a set value are no-ops anyway) | **dropped** | compile error |
| `t++` / `++t` | correct | **dropped** | not measured |
| value of `((x) += 1)` | the old value, and `x` unchanged | | |

The logical row is fixed on #7307's branch (`compileLogicalAssignment` now dispatches on the peeled target,
RV7307 round 2). Every other bold cell still fails there.

### Separate row — `(x as number) ??= 7` (and every `as` / `satisfies` target)

These are refused by the early-error pass (`src/compiler/early-errors/node-checks.ts`,
`isInvalidAssignmentTarget`), which does not look through `as` / `satisfies` / `<T>`. TypeScript accepts
them and erases the wrapper, so the refusal is wrong but loud: a compile error, never a wrong answer.

### Why it is silent

`compileCompoundAssignment` reaches `reportError(... "Compound assignment only supported for simple
identifiers")` for a parenthesised target (traced), yet `compile()` returns `success: true` with no
diagnostic, and the statement emits `f64.const 0; drop`. Some caller discards the diagnostic; the plan below
finds which.

## Implementation Plan

Legacy codegen only (no `src/ir/` change). Stacked on #7307 (same file, same peel).

- **One peel, at each assignment entry.** `skipTransparentExpressions` (`src/shared/transparent-expressions.ts`)
  is the existing helper, already used by `compileLogicalAssignment` on #7307. Apply it once at the top of
  `compileCompoundAssignment` and of `compileAssignment` (which today peels only parentheses with its own
  loop), and in the `++`/`--` target dispatch; dispatch on the peeled target. No second peel helper.
- **Early errors.** `isInvalidAssignmentTarget` looks through the type-erased wrappers
  (`unwrapTypeErasedExpression`) as it already does through parentheses, so `(x as number) += 1` and
  `(x as number) ??= 7` compile.
- **The dropped diagnostic.** Find where the `reportError` from an unsupported target is discarded and say
  in the PR whether it is fixed here or filed separately. A target codegen cannot lower must fail the compile,
  not ship `f64.const 0`.
- **Quality criterion.** One peel per entry point through the shared helper; the parenthesis-only loop in
  `compileAssignment` goes away; no new predicate.
