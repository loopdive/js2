---
id: 7332
title: "IR: a literal `null` in an f64 context (`-null`, `{ a: null }`) is claimed, then withdrawn"
status: done
completed: 2026-11-19
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
loc-budget-allow:
  # 2026-11-19 (S8) — from-ast.ts +5: the null operand of a prefix operator
  #   (lowerPrefixUnary); select.ts +4: the null-field refusal in the object
  #   literal arm. Both sit in the arm they change.
  - src/ir/from-ast.ts
  - src/ir/select.ts
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

## Implementation Plan

Reproduced on main `ee3fcdd6` (2026-11-19), all three lanes, all four repros.

Two producers, two answers:

1. **Prefix operators — a real lowering (`lowerPrefixUnary`,
   `src/ir/from-ast.ts`).** The operand is lowered under an f64 hint, which
   `null` has no value for. `-`, `+` and `~` read ToNumber(null), +0, and `!`
   reads a falsy value either way, so a `null` operand (through parentheses,
   `skipOuterExpressions`) lowers as the f64 constant 0. `-null` is then
   `f64.neg 0` = -0, as in JS. `~null` stays refused by its own selector arm
   (`expr-tilde-nonnumeric`).
2. **Object literal fields — an honest refusal (`src/ir/select.ts`).**
   `lowerObjectLiteral` lowers every field value under an f64 hint and the IR
   field types have no null-holding representation, so the selector refuses a
   field any of whose yielded values (`everyYieldedValue`: conditional arms,
   comma, `=`) is `null`: `objectlit-null-field`. A field representation that
   holds `null` is a new mechanism (the object-literal open-object work), not
   this fix.

**Quality acceptance.** No new predicate: the field check reuses
`everyYieldedValue`; the operand check reuses `skipOuterExpressions`.

**Found on the way (not this issue).** With the `null` refusal removed,
`var o; function h() { o = { a: 1 }; } h();` withdraws on main as well
(`assignment to module binding "o" (dynamic) got object{a:f64}`): an object
literal stored into a dynamic script var. Reported to the lead.

**Tests.** `tests/issue-7332-null-into-number.test.ts`: `-null`, `-(null)`,
`+null`, `!null` and the call-argument repro are IR, the `{ a: null }` repros
and a conditional field are refused at selection, all with no post-claim
error on standalone, wasi and gc; `-null` is -0, `+null` 0, `!null` true
through the runner (standalone, gc).

## Result

700-file seeded ES5 sample (seed 7106, census population; standalone,
original harness, compiled and run), base main `ee3fcdd6` vs this branch,
2026-11-19: IR-only and passing 130 → 130, legacy units 1,261 → 1,261,
post-claim errors 41 → 41, no verdict flip, no unit's refusal changed. The
one `null` post-claim error in the sample, `language/types/null/S8.2_A3.js`,
is `typeof(null)` in a condition, a different consumer, and stays. Bytes:
100 files × standalone and gc identical to base.
