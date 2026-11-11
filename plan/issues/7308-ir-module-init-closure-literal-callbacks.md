---
id: 7308
title: "IR module-init closure-literal callbacks — measured: 0 of 19 sole-blocker files move with one predicate"
status: blocked
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7113, 7130, 7195, 7198, 7287, 7305]
assignee: "ttraenkler/c-lane-opus"
---

# #7308 — closure literals in test `<module-init>`

## Problem

On the wrapped stride-40 standalone sample (main b83a8ee0; re-checked on
cc27f70d), 19 files have the test `<module-init>` as their only legacy
unit, refused on a closure literal:

- **`closure-return-type`** (9 files): `assert.throws(TypeError, () => {…})`,
  `() => Date.prototype.toString()`, and function expressions with patterns
  or parameters.
- **`vardecl-let-closure`** (10 files): `var f = function () {…}` stored and
  used later.

## Measurement (2026-11-07)

**Why the closure is refused.** `closureLiteralIsBuildable`
(`src/ir/select-closure-literal.ts`) needs one of two things:

- an annotated return type and parameter types (the typed slice-3 surface,
  which JS test files never have);
- an `IrFunctionMemberClosurePlan` (`planMemberClosure`,
  `src/codegen/function-member-closure-planning.ts:541`).

The planner covers **`ts.FunctionExpression` only**. It checks the type at
`resolve(expression: ts.FunctionExpression)`, at the select / from-ast entry
guards (`ts.isFunctionExpression(expr) ? …resolve(expr)`), and through
`sourceUnit.kind !== "function-expression"`. Its sites are a member
assignment, an argument position (callee is a same-source function object),
a top-level call argument (`F.m(…, function () {}, …)`, zero parameters,
void) and a script `var` (#7198: value uses only). Every plan refuses nested
functions, and the result must be void, boolean or string.

**Shape (a): arrow callbacks (6 files).** A throwaway probe let arrows
through the planner. It changed the select and from-ast guards and accepted
the `arrow-function` unit kind. Next refusal per file:

| file | with arrow plans |
| --- | --- |
| `Date/prototype/toString/non-date-receiver` | planner **crash**: `expression.body.statements is not iterable`. Concise bodies need their own body proof. |
| `Object/defineProperties/…-not-undefined` | `expr-ident-not-in-scope` `Object` |
| `Temporal/Instant/from/argument-wrong-type` | not plannable: the result is an object, not void/bool/string |
| `Object/defineProperty/…-not-bigint` | `call-resolution-unsupported` (the BigInt argument) |
| `arrow-function/dstr/ary-ptrn-elem-obj-id` | not plannable: pattern parameters |
| `Array/prototype/with/this-value-nullish` | `operand-coercion-unsupported` (`.call(null, 0, 0)`) |

**Function-expression `closure-return-type` (3 files):**

- `defineProperty/15.2.3.6-4-196`: the callback contains a nested
  `get: function () {}`, which every plan refuses.
- `function/params-trailing-comma-multiple`: `ref = function (a, b,) {…}`,
  an assignment that is not a plan site.
- `function/dstr/…`: pattern parameters.

**`vardecl-let-closure` (10 files):** each needs a different feature beyond
the closure.

| file | blocking construct |
| --- | --- |
| `Object/create/15.2.3.5-4-191` | `new Func()`: [[Construct]] on a script var |
| `RegExp/…/Symbol.replace/fn-invoke-args` | `arguments` object; regex `[Symbol.replace]` |
| `String/…/trim/15.5.4.20-2-46` | `return arguments;` |
| `Array/…/reduceRight/15.4.4.22-8-b-iii-1-11` | the callback lives in an object literal / prototype |
| `Object/defineProperties/15.2.3.7-5-b-231` | a getter returns the function value |
| `arrow-function/statement-body-requires-braces…` | arrow + **value-position** call `plusOne(1)` (refused by #7287 by design) |
| `Array/…/every/15.4.4.16-2-6` | function values in an object literal |
| `Array/…/filter/15.4.4.20-9-c-i-25` | `arguments` + value-position call `func(11)` |
| `Function/…/call/S15.3.4.4_A5_T5` | `f.call(obj)` with `this` |
| `class/accessor-name-inst/computed-err-evaluation` | classes with computed accessors |

**Zero-legacy delta of the largest single admission (arrows in the planner):
0 of 19.**

## Conclusion — stopped at measurement

- No predicate extension moves a file. The arrow extension is the largest
  sub-shape, and it also needs a concise-body proof, because the planner
  crashes today if arrows simply reach it. Every one of the 6 arrow files
  then stops on an unrelated construct: `Object` / `Temporal` / BigInt /
  `.call(null…)` / patterns.
- **Latent defect, not reachable on main:** `planMemberClosure`'s body
  proofs assume `expression.body` is a `Block`. If arrows are ever admitted,
  a concise body must be refused or proven first.
- Useful next steps, by blocking construct across these 19 files:
  1. ambient `Object.*` as a callee (≥2);
  2. the `arguments` object in planned closures (3);
  3. value-position calls through script vars (2; #7287's documented
     hazard, #7305);
  4. function values in object literals and getters (3).
