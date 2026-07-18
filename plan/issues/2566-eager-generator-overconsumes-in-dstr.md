---
id: 2566
title: "Eager-buffer generator over-consumes in array destructuring (capturing generators yield wrong side-effect counts; trailing elision steps too far)"
status: blocked
blocked_by: 2662
sprint: Backlog
created: 2026-06-21
updated: 2026-06-26
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, generators, destructuring
language_feature: generators
goal: spec-completeness
related: [2203, 680]
test262_bucket: dstr-elision-default-value
es_edition: es2015
origin: "2026-06-21 split out of #2203. #2203 fixed the STANDALONE invalid-Wasm crash (capturing nested generator baked funcidx:undefined). The remaining VALUE bug is here: the eager-buffer generator model runs the generator body to COMPLETION at call time, so destructuring a capturing generator over-consumes it — a trailing elision `let [,] = g()` increments the post-yield side effect that spec §8.5.2 says must NOT run."
---

# #2566 — Eager-buffer generator over-consumes in array destructuring

> **BLOCKED on #2662 (verify-first, dev-1556b 2026-06-26).** Re-confirmed the
> eager over-consume on current `origin/main`: `function* g(){first+=1;yield;second+=1;} let [,]=g();`
> ⇒ `second=1` (want `0`); two-yield / empty-pattern cases also run the body to
> completion. Root cause is #2662 — the default gc-mode **host generator backend
> is eager-buffered** (drains the whole body into `buf:any[]` at call time, then
> `.next()` just replays the buffer), so destructuring cannot step the iterator
> once-per-element per §13.3.3.6. There is **no focused dstr-codegen fix** until
> #2662's lazy/suspendable host backend lands (the native lazy machine is
> standalone-only and bails on captured outer-scope bindings, which these cases
> intrinsically have).

## Problem

Array destructuring a **generator** that the compiler lowers via the
**eager-buffer model** (`__gen_create_buffer` / `__gen_push_*` /
`__create_generator`) runs the generator body to **completion** at call time and
materialises all yielded values into a buffer. Destructuring then reads that
buffer. But ECMA-262 §8.5.2 / §13.3.3.6 IteratorBindingInitialization steps the
iterator **exactly once per element / Elision** and exhausts it only on a rest
element — a no-rest pattern must leave the iterator suspended.

The eager model can't honour that: by the time destructuring runs, the generator
has already executed every statement after every `yield`.

```js
var first = 0, second = 0;
function* g() { first += 1; yield; second += 1; }
let [,] = g();
// spec: first === 1 (the elision steps once, to the first yield),
//       second === 0 (the iterator is NOT resumed past the yield).
// eager model: first === 1, second === 1  ← WRONG (g ran to completion)
```

This affects the ~29 test262 `*ary-ptrn*elision*` cases whose generators capture
an outer-scope binding (so they cannot use the Wasm-native lazy factory) and now
(post-#2203) compile to **valid** Wasm but **fail** on the runtime side-effect
assertion (`assert.sameValue(second, 0)`).

## Why this is hard

- The Wasm-native generator (#680) IS lazy/suspendable, but only for **top-level
  / non-capturing** generators — its state lives in a struct with no slot for
  captured outer-scope bindings. The test262 elision cases nest a *capturing*
  `function* g()` inside `test()`, so they fall to the eager host path.
- Fixing the value bug requires **lazy capturing generators**: extend the native
  generator state machine to persist captured outer-scope bindings (ref cells)
  across suspensions, OR make the eager-buffer host generator support bounded
  `.next()`-style stepping rather than an eager full drain. Either is a
  #680-class feature, not a localized bugfix.

## Scope / non-goals

- The **standalone funcidx crash** is already fixed in #2203 (capturing nested
  generators now register the eager host imports → valid Wasm). This issue is
  ONLY the runtime over-consumption value bug.
- Plain array-literal RHS elision+default already lowers correctly (`[, , x] =
  [10, 20, 30]` → 30, `[, z = 99] = [1]` → 99, elision+rest) — not in scope.

## Acceptance criteria

- [ ] `var first=0,second=0; function* g(){first+=1;yield;second+=1;} let [,]=g();`
      ⇒ `first === 1`, `second === 0` (host AND standalone).
- [ ] `var [[,] = g()] = []` with a capturing `g` ⇒ default runs once, not resumed.
- [ ] The ~29 capturing-generator `*ary-ptrn*elision*` test262 cases flip from
      fail → pass without regressing the non-capturing (native) generator cases.

## Related residual deferred here (from #2669, 2026-06-26)

#2669 landed the SYNC for-of nested-default codegen (`for (const [[x,y,z]=[4,5,6]]
of [[]])`) but **deliberately forgoes the nested default when the initializer is a
CALL expression** (generator `g()`, capturing helper, IIFE) — gated
`!ts.isCallExpression(initializer)` — and skips it entirely for **for-await-of**.
Reason: compiling such a default inside the conditionally-skipped default arm
materialises its capture box only on the not-taken branch and corrupts later reads
of the captured variable (a #2692 closure-box-lazy interaction), and the generator
case additionally over-consumes — this issue. The forgone surface is the
`for-await-of/async-{func,gen}-dstr-…ary-ptrn-elem-ary-elision-{init,iter,empty}`
cluster (~15 tests) plus the sync `ary-empty-init` IIFE-default cases. They unblock
once this (#2566) + a fully-general #2692 land; then the `!isCallExpression`
restriction in `compileForOfDestructuring` (`src/codegen/statements/loops.ts`) can
be lifted.
