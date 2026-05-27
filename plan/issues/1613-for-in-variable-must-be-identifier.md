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

## Implementation (2026-05-27)

`compileForInStatement` (`src/codegen/statements/loops.ts`) previously accepted
only a bare identifier or single-identifier var/let declaration and called
`reportError` on every other head form. Extended to handle the full
ForBinding/LeftHandSideExpression grammar:

1. **Member-expression target** (`for (x.y in obj)` / `for (x[k] in obj)`):
   the enumerated key is materialised in a temp externref local, then written
   to the reference each iteration via a new `emitForInMemberTargetWrite`
   helper (`__extern_set(receiver, key, value)`, mirroring the for-of
   member-target path at loops.ts ~1985).
2. **Binding-pattern head** (`for (var/let [a] in obj)` /
   `for (var {a} in obj)`): the key (a string) is destructured each iteration
   by reusing `compileExternrefArrayDestructuringDecl` /
   `compileExternrefObjectDestructuringDecl`. Array patterns iterate the
   string's code units (so `for (var [x, x] in {ab:null})` ends with `x === "b"`).

Early-error parity (`src/compiler/validation.ts`): lexical for-in heads with
duplicate bound names (`for (let [x, x] in {})` / `for (const [x, x] in {})`)
now raise a parse-phase SyntaxError, mirroring the existing for-of check.

## Test Results

- `tests/issue-1613.test.ts` — 7/7 pass (member target value, string-key
  array-destructure last-wins, lexical pattern iteration, both dup-bound-names
  SyntaxError cases, plain-identifier no-regression).
- The 2 failures in `tests/equivalence/new-non-constructor.test.ts` are
  pre-existing on main (#432 stack-underflow), unrelated to this change.
