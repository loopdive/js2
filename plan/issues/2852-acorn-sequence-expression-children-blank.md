---
id: 2852
title: "compiled-acorn marshals SequenceExpression `expressions[]` child nodes BLANK (all fields dropped across host boundary)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: medium
created: 2026-06-29
task_type: bugfix
area: codegen, runtime
language_feature: sequence-expression
goal: acorn-dogfood
related: [1712, 2841, 2851]
umbrella: 1712
---

# #2852 — compiled-acorn marshals SequenceExpression `expressions[]` children blank

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). Compiled-acorn **parses**
sequence expressions `(a, b, c)` without throwing, but every **child node** in
the `SequenceExpression.expressions[]` array comes back across the JS-host
boundary as a **blank object** — the entire child node (its `type` and all its
fields) is lost.

## Divergence (compiled-acorn vs node-acorn, same pinned acorn@8.16.0)

`operators.js` (`const seq = (1, 2, 3);`) and `sequence-misc.js`:

```
missing-field  ...init.expressions[*].type      expected "Literal"          actual undefined
missing-field  ...init.expressions[*].value     expected 1                  actual undefined
missing-field  ...init.expressions[*].raw        expected "1"               actual undefined
missing-field  ...init.expressions[*].type      expected "CallExpression"   actual undefined
missing-field  ...init.expressions[*].callee    expected {Identifier}       actual undefined
missing-field  ...init.expressions[*].arguments expected []                 actual undefined
missing-field  ...init.expressions[*].name      expected "result"          actual undefined
```

Also hits a SequenceExpression in a `for` update clause
(`for (let i=0,j=10; i<j; i++, j--)` → `...update.expressions[*]` blank:
`UpdateExpression` `operator`/`prefix`/`argument` all missing).

The `expressions` array has the correct length — it is the _element_ nodes that
are emptied, so the operands of every comma expression are dropped from the AST.

## Minimal repro

```js
const seq = (1, 2, 3);
```

node-acorn: `expressions: [ {type:"Literal",value:1,raw:"1"}, {type:"Literal",value:2,raw:"2"}, {type:"Literal",value:3,raw:"3"} ]`

compiled-acorn: `expressions: [ {}, {}, {} ]` (each element blank; only the
cosmetic `sourceFile`/i32-bool quirks remain — see #2847).

## Suspected root cause

Host-marshalling gap on **node-typed elements of the `expressions` array**.
Likely the same mechanism as #2841 (`params[]`) and #2851 (`quasis[]`) — "node
elements of a specific array property come back without their fields." The
distinguishing feature here is that the elements are arbitrary expression nodes
(Literal, CallExpression, Identifier, UpdateExpression), so the marshaller is
not reading struct fields for array-element node values at all. May share a fix
with #2841/#2851.

## Acceptance

- `tests/dogfood/acorn-corpus.mjs` shows `corpus/operators.js` and
  `corpus/sequence-misc.js` with no REAL divergence on `expressions[*]`.
- A focused equivalence test asserting a marshalled `SequenceExpression` carries
  fully-populated child nodes.
- No test262 regression.
