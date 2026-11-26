---
id: 7480
title: "A function declaration overwritten by a same-named `var` declarator is not seen as reassigned"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
task_type: bugfix
area: ir
goal: core-semantics
sprint: Backlog
related: [7455, 7457]
---

# #7480 — `function f(){} var f = 6;` is not seen as reassigned

## Problem

Found while running the #7457 differential (2026-11-26, branch `claude/7457-planner-write-index`). In
`function f() { return 1; } var f = 6; f();` the `var` initializer overwrites the function binding at run time:
declaration instantiation creates `f` as the function (§16.1.7 for a script, §10.2.11 in a function body), then the declarator stores 6. So the call throws a `TypeError`.

The TypeScript checker gives the declarator `f` its own symbol, separate from the function declaration's. This
holds in `.ts` and `.js`, as measured with `getSymbolAtLocation` on both names. As a result:

- the call planner's `reassigned` set in `src/ir/imported-functions.ts` misses the write, and
  `resolveTopLevelFunctionValue` resolves `f()` to the function's cached funcref;
- the binding-write index (`bindingWrites`, #7455) files the write under the declarator's symbol, not the
  function's.

Both agree, so #7457's fold keeps today's (wrong) answer and stays byte-identical. This issue is the fix.

## Acceptance criteria

- A function declaration and a same-named `var` declarator in the same scope count as one binding for the write
  question. The declarator's initializer is a write of the function's binding.
- `function f(){return 1;} var f = 6; f();` compiles to a call that throws `TypeError`, on the ordinary
  pipeline and on the Prepared path. The same holds for the `for (var f in o)` and `var f = …` forms inside the
  function's own scope.
- Every changed output in the equivalence corpus and the shared 411-row sample is listed and classified.
