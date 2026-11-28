---
id: 7425
title: "yield* over a user iterator (class or object literal) throws a WebAssembly.Exception on gc, standalone and wasi"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 7414]
---

# #7425: `yield*` over a user iterator throws

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242. The probe encodes the argument as undefined→1, null→2, other→3, plus `10 * arguments.length`.

`function* g() { yield* new It(); }`, with a class iterator or an
object-literal iterator, throws an uncaught `WebAssembly.Exception` on gc,
standalone and wasi. Node yields the iterator's values (probe: 1111).

The missing-helper audit's #7414 row 14 lists the same shape.

## Acceptance

`yield*` delegates `next` / `return` / `throw` to a user iterator on all
three targets. A test pins node's answers for class and object-literal
iterators.
