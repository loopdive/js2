---
id: 1691
title: "yield* does not delegate throw()/return() to the inner iterator (eager-generator model gap)"
status: blocked
sprint: Backlog
created: 2026-05-27
updated: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1665
blocked_by: [1665, 1042]
---
# #1691 — yield* does not delegate throw()/return() to the inner iterator

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

## Re-investigation 2026-05-28 (senior-developer)

Re-walked the eager-buffer model to confirm whether anything has shifted that
would unlock a localized fix. Conclusion: **architectural block confirmed,
no hybrid path is feasible without the lazy/CPS generator lowering.**

### Code-path walk (current main)

1. `compileYieldExpression` (`src/codegen/expressions/misc.ts:177`) emits
   `__gen_yield_star(buf, iterable)` synchronously inside the generator body.
2. `__gen_yield_star` (`src/runtime.ts:6544`) is a single closure:
   `for (const v of iterable) buf.push(v)`. It runs to completion at the
   `yield*` call site. Only `iterable[Symbol.iterator]().next()` is touched —
   `throw`/`return` are never even *looked up*, let alone retained.
3. By the time `__create_generator` (`src/runtime.ts:6556`) wraps `buf` and
   returns the generator object, the inner iterator has been fully consumed
   and dropped. There is no reference to it on the state record
   (`_GeneratorState` at `src/runtime.ts:71` stores only `{buf, index,
   pendingThrow}`).
4. `Generator.prototype.throw` (`src/runtime.ts:216`) does
   `state.index = state.buf.length; throw e` — there is no delegate slot to
   route into, because the suspension point does not exist.

### Why a "remember the delegate" patch doesn't work

To forward `outer.throw(e)` per §14.4.14 step 5.b.ii, the outer generator
body must pause **mid-iteration** at the `yield*` site holding a live
reference to the inner iterator. Adding a `delegate` slot to the state
record is not enough: the generator body would still have to *resume after
the throw was forwarded*, drain remaining inner values into the outer
buffer (or propagate IteratorClose), and continue with the next outer
statement. That resume-after-yield* requires a continuation / state
machine for the outer body — which is exactly what the eager model
deliberately omitted. Once `g()` returns, the outer body is gone; there is
no way to "go back" to it.

A partial workaround (`__gen_yield_star` calls `.throw` on the inner
iterator *during the eager drain* if some future `pendingThrow` flag is
set) would require either reading the future state (impossible — the
drain happens before `g()` returns the generator) or making `next()`
itself the driver of the inner drain, one step at a time — which **is**
the lazy generator model (#1665).

### Concrete failure mode

```ts
function* inner() { yield 11; yield 22; yield 33; }
function* outer() { yield* inner(); }
const it = outer();
it.next();          // → {value: 11, done: false}     (spec)
                    //   actually returns same in eager model because inner
                    //   is finite, but inner is *already gone* at this point
it.throw("BOOM");   // spec: looks up inner.throw, calls it, observes
                    //   IteratorClose or rethrow
                    // eager: state.index = buf.length; throw "BOOM"
                    //   (inner never sees the throw — it was discarded)
```

For the test262 spy-iterator pattern (`star-rhs-iter-thrw-thrw-invoke.js`),
the spy's `next()` returns `{done: false}` indefinitely, so the eager
drain at the `yield*` site loops until `__EAGER_GEN_LIMIT = 1_000_000`
fires a RangeError — `g()` never returns the generator instance to call
`.throw()` on at all. This is observable today as one of the
`star-rhs-iter-thrw-*` failures returning `RangeError` instead of the
spec-required behavior.

### Why this can't be carved into a slice

The `pendingThrow` field on `_GeneratorState` already exists (added for
synchronous-throw-in-body capture, #1516). One might hope to wire
`__gen_yield_star` to consult it. But `pendingThrow` is set by the
generator body itself when a host-side throw is captured for re-throw on
the next `.next()` — it is not a channel the outer caller can write to,
because the body has already finished by the time the caller sees `iter`.

There is no path that leaves the buffer model intact and satisfies even
one of the 13 `star-rhs-iter-thrw-*` cases. The fix is the move to
generator suspension, owned by #1665 (native generators) + #1042/#1373b
(CPS lowering for the suspend/resume machinery).

### Recommendation

Keep this issue `blocked` on #1665 and #1042. Do **not** spawn another
dev on it. When #1665 lands, this issue's acceptance criteria are
covered by the same lazy-iterator state machine that implements `next()`
properly — `throw`/`return` delegation is a few additional dispatch
arms on the state record's resume handler, not a separate workstream.
