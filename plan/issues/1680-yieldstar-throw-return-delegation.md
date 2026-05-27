---
id: 1680
title: "yield* does not delegate throw()/return() to the inner iterator (eager-generator model gap)"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1665
---
# #1680 — yield* does not delegate throw()/return() to the inner iterator

## Problem

`yield* <iterable>` correctly forwards `next()` values but does **not** forward
the outer generator's `throw()` / `return()` into the delegated iterator, as
required by ECMAScript §14.4.14 (YieldExpression : `yield * AssignmentExpression`,
the `received.[[Type]] is throw` / `is return` branches).

13 test262 cases in `language/expressions/yield` fail on this — the entire
`star-rhs-iter-thrw-*` family plus `star-rhs-iter-thrw-violation-*`:

- `star-rhs-iter-thrw-thrw-invoke.js` — asserts the delegate's `throw` method
  is invoked with the thrown value; compiler returns wrong sentinel (observed 7777).
- `star-rhs-iter-thrw-res-value-final.js` — observed 2222 instead of delegated value.
- `star-rhs-iter-thrw-res-done-err.js`, `-res-done-no-value.js`,
  `-res-value-err.js`, `-thrw-call-err.js`, `-thrw-call-non-obj.js`,
  `-thrw-get-err.js`, `-violation-no-rtrn.js`, `-violation-rtrn-call-err.js`,
  `-violation-rtrn-call-non-obj.js`, `-violation-rtrn-get-err.js`,
  `-violation-rtrn-invoke.js`.

The sibling `return()` delegation (`star-rhs-iter-rtrn-*`) compiles but does not
exercise true lazy delegation either; it currently passes only because the eager
model happens to drain to completion for the simple shapes.

## Root cause

The compiler uses an **eager generator model**. `compileYieldExpression`
(`src/codegen/expressions/misc.ts:177`, the `expr.asteriskToken` branch) lowers
`yield* x` to a call to `__gen_yield_star(buffer, iterable)`.

`__gen_yield_star` (`src/runtime.ts:5692`) is:

```js
(buf, iterable) => {
  if (iterable != null && typeof iterable[Symbol.iterator] === "function") {
    for (const v of iterable) { buf.push(v); }   // next() only
  }
};
```

It drains the inner iterator via a plain `for...of` (calling **only** `next()`)
and pushes every value into the outer generator's buffer eagerly. By the time
user code calls `outerGen.throw(e)` or `outerGen.return(v)`, the inner iterator
has already been fully consumed and discarded — there is no live delegate to
forward the completion to. So the §14.4.14 step-5.b (`throw`) and step-5.c
(`return`) branches are unobservable.

## Why this is hard (feasibility: hard)

Correct `yield*` throw/return delegation requires the generator to **suspend**
at the `yield*` point holding a reference to the live inner iterator, so a later
`throw()`/`return()` on the outer generator can be routed to the delegate's
corresponding method. That is exactly the lazy / re-entrant generator semantics
the eager-buffer model was designed to avoid.

This should be folded into the lazy-generator / CPS work, not patched in the
eager runtime:
- #1665 (native generators — shared `$Iterator` design gap)
- #1373 / #1042 (IR async + CPS lowering — the suspend/resume machinery)

A localized patch to `__gen_yield_star` cannot satisfy the protocol because the
suspension point does not exist in the eager model.

## Acceptance criteria

- `yield*` suspends at the delegation point and forwards `throw()`/`return()` to
  the inner iterator per §14.4.14 steps 5.b / 5.c.
- The 13 `star-rhs-iter-thrw-*` test262 cases pass.
- `star-rhs-iter-rtrn-*` continue to pass under the lazy model.

## Investigation notes (2026-05-27)

Probe of all 63 `language/expressions/yield` tests (proper host imports via
`buildImports` + `wrapTest`): 45 PASS + 3 PASS(negative-CE) = 48 passing; 13
fail on the throw-delegation gap above; 2 are TS-strictness CE artifacts in the
test source (`star-return-is-null.js`, `star-rhs-iter-rtrn-rtrn-invoke.js` —
`'this' implicitly has type 'any'` / iterator-shape typing, not genuine JS parse
failures — out of scope for this issue).

## Related

- Blocks-on: #1665, #1373, #1042 (lazy/CPS generator model)
- Sibling investigation: #820c (async-gen object-method yield* null deref)
