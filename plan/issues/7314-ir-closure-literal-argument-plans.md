---
id: 7314
title: "IR: closure plans for unannotated closure literals in argument position — measured, 0 files flip"
status: backlog
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7308, 7309, 7305, 7287, 7130, 7195, 7198]
assignee: "ttraenkler/c-lead"
---

# #7314: closure plans for unannotated closure literals in argument position

## Problem

An unannotated closure literal with no closure plan is refused as
`closure-return-type` whatever its body (`closureLiteralIsBuildable`,
`src/ir/select-closure-literal.ts:47`). R11's census counts 122 test
`<module-init>` units carrying that part, for example
`assert.throws(TypeError, () => {…})`, stored callbacks and `[].forEach(cb)`.

## (1) Why the planner covers FunctionExpression only, and the smallest generalisation

`planMemberClosure` (`src/codegen/function-member-closure-planning.ts:541`)
takes a `ts.FunctionExpression` and requires the identity inventory's unit
kind `"function-expression"`. Its four sites all type the literal as a
`FunctionExpression`:

- member assignment;
- `argumentPositionSite` (#7130): a same-source function callee;
- `callArgumentSite` (#7195): `F.m(…, function () {})` as a top-level
  statement, zero parameters, void;
- `scriptVarSite` (#7198).

So do its body proofs:

- `closedScalarBodyKey`, `openBodyKey`, `bodyReadsThis` and
  `captureMemberClosureSyntax` all iterate `expression.body.statements`;
- the `thisStrict` plan binds a dynamic `this` at entry.

An arrow differs in exactly three ways:

- the unit kind is `"arrow-function"`;
- `this` / `arguments` are lexical;
- the body may be concise, and then `body.statements` is not iterable (the
  #7309 crash).

The smallest generalisation is one entry, no sibling arm:

- **Type.** Widen `planMemberClosure` and its site functions to
  `ts.FunctionExpression | ts.ArrowFunction`, and accept both unit kinds.
- **One body view.** A shared helper gives the body proofs a statement list:
  `[body]` as a synthetic `return <expr>` for a concise body, else
  `body.statements`. This fixes #7309 in the same change.
- **Refusals for arrows.** Refuse an arrow whose body reads `this` or
  `arguments`. Lexical `this` from module-init is `undefined` in a module and
  `globalThis` in a script, which is a different binding from the planned
  `thisStrict` entry. Refusing is the first cut.

## (2) Signature source for an argument-position closure

Today the signature is `ctx.oracle.signatureOf(expression)`, checked against
the site contract.

- **Same-source callees** (`assert.throws` in the harness): the callee is
  inventoried, so the planned ABI is the closure's own oracle signature with
  the site's `requiresVoid`. This is exactly what `callArgumentSite` /
  `argumentPositionSite` already do for function expressions.
- **Ambient callees** (`[].forEach(cb)`, `Promise.prototype.then(cb)`): the
  only signature source is the lib parameter type (`callbackfn: (value: T,
  index: number, array: T[]) => unknown`), and the callee is a legacy or
  native body with its own closure ABI. The planned ABI must equal the one
  the native body calls, which needs one contract per (brand, member). Refuse
  until such a contract table exists; do not infer it from lib types.

## (3) What keeps the planned closure inside existing arms

First cut:

- the zero-parameter callback of a same-source callee;
- a void body (a block, or a concise call expression lowered as a statement);
- refuse `this`, `arguments`, pattern or rest parameters, generators, async,
  nested function literals, and a non-void concise body.

These are the existing `callArgumentSite` / `argumentPositionSite`
constraints with "FunctionExpression" relaxed to include arrows.

## (4) Measured yield on passing files (2026-11-07, main `cc27f70d`, standalone)

**Population.** 170 stride-40 files whose only legacy unit is test
`<module-init>` and whose test body has a zero-parameter closure literal in
argument position: `(() => …` / `, () => …` / `function () {`.

**Probe (stub-and-recheck).** Every zero-parameter arrow argument was
rewritten into a function expression:

- a block body kept as is;
- a concise body wrapped as a statement, `function () { <expr>; }`.

Function expressions in those positions are already planned by #7130 / #7195,
so the rewrite emulates the generalised planner. Each file was then
recompiled through the wrapped harness (`JS2WASM_IR_SHAPE_DIAG=1`) and its
legacy units counted (a local `.tmp` probe, not committed; the rewrite
rule above is all it does).

**Result: 0 of 170 files reach zero legacy units.** After the rewrite only 3
files still stop on a closure part (`closure-body` ×2, `closure-return-type`
×1). Every other file's first refusal is something else:

| next refusal (first per file) | files |
| --- | ---: |
| `vardecl-module-storage-unrepresentable` | 46 |
| `expr-ident-not-in-scope` (unresolved / ambient identifiers) | 32 |
| `vardecl-module-value-flow:NewExpression` | 17 |
| `objectlit-empty` | 8 |
| `host-surface-unavailable` / `call-resolution-unsupported` | 7 + 7 |
| class expressions, constructor resolution, IIFE callees | 6 + 5 + 9 |
| standalone compile errors (Intl, FinalizationRegistry) | 7 |
| others (≤3 each) | the rest |

The first refusal is first-wins, so a file can carry more blockers behind it.
Zero is therefore an exact count, not a lower bound: no file in this
population becomes zero-legacy.

R14's #7308 measurement agrees from the other side: admitting arrows to the
planner flips 0 of the 19 single-lever closure files.

Callbacks with parameters (`forEach((x) => …)`) need the ambient contract
from (2), which does not exist. They are not probed and are refused by
design.

## (5) Quality and decision

**Yield 0, so no code.** The generalisation in (1) is small and clean (one
planner entry, one body view, which also fixes #7309). It moves no file
until module storage (#7280), ambient identifiers (#7294 / #7305) and `new X`
value flow land. Recommended order:

1. Revisit after #7280 and #7294.
2. Re-run the probe; it is a 5-minute measurement.
3. Implement (1) + (3) in one change once the probe shows ≥ 3 passing files
   flip.
