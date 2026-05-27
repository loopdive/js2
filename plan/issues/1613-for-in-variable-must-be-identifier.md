---
id: 1613
title: "codegen: for-in head with binding pattern / non-identifier rejected ('for-in variable must be an identifier')"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: low
feasibility: medium
task_type: bugfix
area: codegen
language_feature: for-in, destructuring
goal: compiler-correctness
sprint: Backlog
es_edition: multi
test262_count: 10
---
# #1613 — for-in head non-identifier targets rejected

## Problem

10 test262 tests fail at compile time on the for-in head:

```
for-in variable must be an identifier            (7)
for-in requires a variable declaration or identifier (3)
```

These are `language/statements/for-in` scope and bound-name tests where the
for-in head is a `var`/`let` declaration with multiple bound names, a binding
pattern, or a member-expression target rather than a bare identifier.

## Failing test examples

- `test/language/statements/for-in/head-var-bound-names-dup.js`
- `test/language/statements/for-in/scope-body-lex-close.js`
- `test/language/statements/for-in/scope-body-var-none.js`

## Root-cause hypothesis

The for-in statement codegen in `src/codegen/statements.ts` only accepts a
single `Identifier` (or single-declaration) head and throws otherwise. It
should accept the full ForBinding grammar: a binding declaration with its
bound names, a destructuring binding pattern, or an assignment-target
member expression — assigning the enumerated key to the target per iteration.
Extend the head handling to cover these LHS forms.

## Acceptance criteria

- for-in over the declaration/pattern head forms compiles.
- >=7 of the 10 tests move off `compile_error`.

## Resolution (2026-05-27)

`compileForInStatement` in `src/codegen/statements/loops.ts` now accepts an
`ObjectBindingPattern`/`ArrayBindingPattern` head. The enumerated key (a string
externref) is destructured into the pattern's bound names at the top of each
loop iteration by delegating to `compileForOfDestructuring` — array-pattern
destructuring of a string iterates its characters, which is the correct JS
semantics (`for (var [x, x] in { ab: 1 })` binds `x = 'b'`).

### Test Results

Measured against `test262/test/language/statements/for-in/` (binding-pattern /
bound-names / scope-body / head candidates, 20 files) via the vitest test262
runner:

- Baseline (main): 10 pass / 10 fail
- This branch: 12 pass / 8 fail — **net +2**, no regressions (all 10 baseline
  passes preserved).
- Newly passing: `head-var-bound-names-dup.js`, `head-let-destructuring.js`.

The remaining 8 fails are unrelated deeper issues (fresh-binding-per-iteration
lexical scoping, TDZ closure capture, default-on-exhausted-iterator) — out of
scope for the "head rejected at compile time" fix. Member-expression
assignment-target heads (`for (x.y in obj)`) are not in the test262 set and
remain a follow-up.

Unit coverage: `tests/issue-1613.test.ts`.
