---
id: 7332
title: "IR: a literal `null` in an f64 context (`-null`, `{ a: null }`) is claimed, then withdrawn"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7287, 7328, 7330, 7331]
---

# #7332: `-null` and `{ a: null }` withdraw a claimed unit

## Problem

The selector admits a literal `null` in an operand or literal-field position
that from-ast lowers with an `f64` hint: unary `-null`, and an object literal
field `{ a: null }`. from-ast's null arm lowers `null` only into a reference
consumer (`nullValueAdmissible`), so it withdraws the unit after the claim
(`irPostClaimErrors`). The output is still correct (legacy fallback), but this
breaks the claim-then-withdraw rule (set in the [#7147 PR review](https://github.com/loopdive/js2/pull/7147): a selector admission that from-ast then rejects counts as a blocker).

## Repro (bare compile; standalone, wasi and gc alike)

Pre-existing on main `b631a4bc`:

```js
var o; function h() { o = -null; } h();
var o; function h() { o = { a: null }; } h();
```

`h`: `ir/from-ast: bare 'null' in non-reference context (f64) is not supported in IR`.

Exposed by #7164 (head `c0dcb01a`) as the argument of a statement call to a
script var (main gives `[]`):

```js
var f = function (a) {}; function h() { f(-null); } h();
var f = function (a) {}; function h() { f({ a: null }); } h();
```

## Related: #7328

#7328 is the same family for a `null` initializer into a script var's dynamic
home (`var nv = null;`). Its consumer is the dynamic carrier, not an `f64`.
The two share the root cause: the IR has no `null` value outside a reference
consumer. They differ in where the selector must refuse. Kept separate on
purpose.

## Direction

Make the selector's operand and object-literal field admission apply
from-ast's rule (`nullValueAdmissible` of the consumer's family), or lower
`null` into an `f64` context as the number 0 where the operator applies
ToNumber (`-null` is `-0`). An object-literal field needs a field
representation that can hold `null`. Pin a bare compile of the four repros
with `irPostClaimErrors` empty.
