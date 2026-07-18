---
id: 3152
title: "array-pattern destructuring DRAINS the source iterator (materialize-then-index) instead of per-element IteratorStep — observable side-effect over-stepping"
status: ready
sprint: current
created: 2026-07-11
updated: 2026-07-17
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, iterators, generators
es_edition: 6
goal: spec-completeness
test262_category: language/expressions/object/dstr, language/statements/*/dstr
related: [3024]
origin: "2026-07-11 #3024 slice-2 (fable-wasm): the 3 *-ptrn-elision.js files flipped CE→semantic fail once the invalid-Wasm bug cleared, exposing this distinct root cause."
---

# #3152 — array destructuring drains the iterator instead of stepping it

## ⚠️ Root-cause CORRECTION (2026-07-17, opus-a) — re-scoped m → xl

The "bounded drain" framing below is a **misdiagnosis**. Verified on current
main (d17ba4d2): the actual test262 files
(`meth-ary-ptrn-elision.js` etc.) use a **closure-mutating** generator:

```js
var first = 0, second = 0;
function* g() { first += 1; yield; second += 1; }
obj.method(g());   // method([,]) asserts second === 0
```

A generator that **mutates outer-scope variables** does NOT pass the
native-resumable shape gate (`generators-native-ast-scan.ts`) — it bails to the
**eager-buffer host path** (`__create_generator` / `__gen_create_buffer` /
`__gen_push_ref`). The eager path **runs the ENTIRE generator body at the
`g()` call site** and buffers every yield *before destructuring ever sees the
result* (confirmed via WAT: the destructure reads a pre-filled buffer struct,
never calls `__array_from_iter_n`). So `second += 1` has already executed by the
time `[,]` binds — there is **no lazy stepping to bound**.

Consequences:
- The suggested `__array_from_iter_n(maxCount)` / `emitNativeGeneratorToVec`
  bound (below) is **inert** for these tests: those paths only run for the
  *native-resumable* generator subset, and in that subset the over-drain is
  **unobservable** (values are still correct; only wasted resumes) precisely
  because side-effecting generators are forced eager. I prototyped the bound and
  it changed nothing observable — reverted.
- The real fix requires the **eager-path generator to become lazy/resumable**
  when it (a) has observable side effects and (b) is consumed by a spec
  observer that steps lazily (destructuring / manual `.next()`). That is the
  lazy-generator work (native-resumable shape-gate widening for
  closure-mutating bodies, or a lazy-thunk host path — see #2865 / the
  `eager-gen` slices), **not** an M-horizon drain-bound. Re-scoped to `xl`,
  `feasibility: hard`.

Everything below is the ORIGINAL (superseded) framing, kept for history.

---

## Problem

Array-binding-pattern destructuring of a generator/iterator materializes the
ENTIRE source (full drain, `__array_from_iter`-style) and then indexes the
result, instead of performing exactly the spec-mandated number of
`IteratorStep` calls (§13.3.3.6 / §8.6.2 IteratorBindingInitialization). Any
side effects in the generator body past the consumed elements run when they
must not.

## Repro (all three shapes over-step; verified on main 2026-07-11)

```ts
export function test(): number {
  var first = 0;
  var second = 0;
  function* g() {
    first += 1;
    yield;
    second += 1; // must NOT run: [,] performs exactly ONE IteratorStep
  }
  var [,] = g(); // same failure via function/method params: f([,]) / method([,])
  return first * 10 + second; // want 10, got 11
}
```

`var [,] = g()`, `function f([,])`, and `method([,])` all return 11 (second
ran). Per spec an elision performs one `IteratorStep` and stops; the generator
body after the first `yield` must never resume.

## Known affected test262 files

- `language/expressions/object/dstr/meth-ary-ptrn-elision.js`
- `language/expressions/object/dstr/gen-meth-ary-ptrn-elision.js`
- `language/expressions/object/dstr/async-gen-meth-ary-ptrn-elision.js`

(They compile to VALID Wasm since #3024 slice 2 / PR 2896 and now fail only on
`assert.sameValue(second, 0)`.) The pattern class is broader: any
`ary-ptrn-*` test observing lazy iteration side effects (elision counts,
`done`-after-N-steps, IteratorClose timing) shares this root cause — harvest
before scoping.

## Root cause (hypothesis, verified at the symptom level)

The destructure lowering converts the iterable source to a concrete
array/vec first (host `__array_from_iter` — an unbounded drain — or the native
`__array_from_iter_n(-1)` equivalent), then reads elements by index. Laziness
is unobservable for plain arrays (the dominant case) but wrong for
generators/custom iterators with side effects, infinite iterators, or
IteratorClose-sensitive tests.

## Suggested approach

- Bound the drain by the pattern's element count when there is NO rest
  element: `__array_from_iter_n(maxCount)` (native helper already accepts a
  count — #2904) instead of the unbounded drain. That alone fixes elision /
  fixed-arity patterns' over-stepping without restructuring the lowering into
  per-element IteratorStep calls.
- Rest elements legitimately drain to completion — unchanged.
- Full spec fidelity (IteratorClose on early abrupt completion, done-flag
  bookkeeping) can layer later; the bounded drain is the measurable slice.

## Acceptance criteria

- The repro returns 10 (second stays 0) for all three shapes (var-decl,
  function param, object-method param).
- The 3 listed test262 files pass; no regressions in the dstr families.
