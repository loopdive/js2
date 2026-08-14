---
id: 4409
title: "In-house oracle is unsound inside `with` — and invents a declared name for `Object.getPrototypeOf`"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: checker
language_feature: with
goal: correctness
parent: 4218
depends_on: [4408]
---

## Problem

Two real violations of the in-house oracle's stated contract — _never widen a
guess into a fact_ — found by adjudicating the differential run against
ECMAScript semantics rather than against the TS5 checker's answers.

### 1. Identifiers inside `with` are resolved lexically (unsound)

Minimal repro:

```js
var x = 0;
var scope = { x: 1 };
with (scope) {
  x = 2;
}
```

| query                      | in-house  | TS5 checker | ECMAScript                                             |
| -------------------------- | --------- | ----------- | ------------------------------------------------------ |
| `isUnresolvableIdentifier` | **false** | `true`      | must abstain — `x` is `scope.x`, not the outer `var x`  |

`with (obj)` pushes an object Environment Record on the scope chain, so `x`
resolves to `obj.x` whenever `obj` has the property (modulo
`obj[Symbol.unscopables]`). Resolution is a **runtime property lookup**; no
static binder can answer it. The TS5 checker abstains here deliberately, and
that abstention is the correct answer.

The in-house binder walks lexical scopes and reports the enclosing `var x`.
Same defect visible on the wide corpus at:

- `language/expressions/assignment/S11.13.1_A5_T1.js` — `variableDeclarationOf(x)`
  returns the outer `var x` where the test's whole point is that `x` is
  `scope.x` until `delete scope.x` runs mid-expression.
- `language/expressions/{arrow-function,async-generator,async-arrow-function}/unscopables-with*.js`
  — `declarationsOf(count)`, `declarationsOf(v)`, `variableDeclarationOf(v)`,
  `staticJsTypeOf(count) = number`. The checker returns `[]` / `mixed`; the
  in-house backend commits.

In the `unscopables` tests the in-house answer happens to be _correct_, because
`globalThis[Symbol.unscopables].v` is set to `true` and the object binding is
therefore skipped. That is luck, not soundness — the same code with
`unscopables` unset resolves the other way, and the backend cannot tell.

`staticJsTypeOf(count) = number` is the dangerous one: it is a **lowering
decision**. A `with`-scoped name typed as `number` can be emitted as an unboxed
f64 local when the runtime value is whatever the `with` object holds.

### 2. `declaredNameOf` invents a name for an `any`-typed expression

```js
var actual = [1, 2, 3];
Object.getPrototypeOf(actual);
```

| query            | in-house             | TS5 checker | lib.d.ts                       |
| ---------------- | -------------------- | ----------- | ------------------------------ |
| `declaredNameOf` | **`ArrayConstructor`** | `undefined` | `getPrototypeOf(o: any): any`  |

The declared return type is `any`; there is no declared name to report. Seen on
the wide corpus as `ArrayConstructor` (Array/prototype/flatMap) and
`FunctionConstructor` (`Object.getPrototypeOf(Intl.DateTimeFormat)`), so the
backend appears to be naming the *receiver's* constructor rather than the
call's result.

## Acceptance criteria

- [ ] The in-house binder marks every identifier lexically enclosed by a `with`
      statement body as **unresolvable**, for all of `valueDeclarationOf`,
      `variableDeclarationOf`, `declarationsOf`, `staticJsTypeOf`, `typeFactOf`
      and `isUnresolvableIdentifier`.
- [ ] The scope is the `with` **body**, transitively through nested functions
      declared inside it — the corpus hits are in nested functions
      (`unscopables-with-in-nested-fn.js`).
- [ ] `declaredNameOf` returns `undefined` when the resolved declaration's type
      is `any` / not a named type reference; it never names the receiver.
- [ ] Regression tests: the two repros above, asserted as **abstentions**, not
      as specific answers.
- [ ] After the fix, the differential's `checker-weaker` bucket loses the
      `with` rows and the `declaredNameOf` rows (18).

## Notes

Emitted-code impact measured on 1,804 compilable inputs: 91 differ, net
box/unbox traffic **0**, bytes −219. So these unsound facts are not currently
producing visibly worse code — but `staticJsTypeOf → number` on a `with`-scoped
name is a correctness hazard regardless of what today's codegen happens to do
with it, and a standalone-mode test262 A/B is running to confirm.
