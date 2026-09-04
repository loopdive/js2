---
id: 5304
title: "yield*: the TypeError rejecting a bad iterator protocol is not the %TypeError% intrinsic — v.constructor mismatch, 364 tests"
status: ready
sprint: current
created: 2026-09-03
priority: high
feasibility: medium
reasoning_effort: medium
horizon: m
task_type: bugfix
area: codegen, runtime
language_feature: generators, async-iteration, error-objects
goal: test262-conformance
test262_bucket: yield-star-error-identity
test262_count: 364
related: [1691, 1639, 3227]
origin: "2026-09-03 harvest of baselines-repo test262-current.jsonl (sha 998a110a, run 20260903-155044): 364 official-scope default-lane rows share one signature."
---

# #5304 — `yield*` protocol errors reject with a non-intrinsic TypeError

## Problem (measured 2026-09-03)

364 official-scope rows in the **default (JS-host) lane** fail with exactly:

```
Test262:AsyncTestFailure:Test262Error: TypeError Expected SameValue(
  «function () { [native code] }», «function TypeError() { [native code] }») to be true
```

The tests are the procedurally-generated `yield-star-*-throw` family:

| Count | Directory |
| ---: | --- |
| 120 | `language/expressions/class` (async-gen methods / private methods) |
| 120 | `language/statements/class` |
| 60 | `language/expressions/async-generator` |
| 30 | `language/statements/async-generator` |
| 30 | `language/expressions/object` |
| 3 | `language/expressions/dynamic-import` |

Samples:

- `test/language/expressions/async-generator/yield-star-getiter-sync-not-callable-number-throw.js`
- `test/language/statements/class/async-gen-method-static/yield-star-getiter-sync-returns-null-throw.js`
- `test/language/expressions/class/elements/async-gen-private-method-static/yield-star-next-not-callable-symbol-throw.js`

## Root cause (exact)

These tests do **not** check that a rejection happens — we already get that
right. They check the *identity* of the rejecting error's constructor:

```js
iter.next().then(() => {
  throw new Test262Error('Promise incorrectly fulfilled.');
}, v => {
  assert.sameValue(v.constructor, TypeError, "TypeError");   // <-- fails here
  ...
});
```

The rejection arrives with correct *timing* and correct *kind* (the
`Promise incorrectly fulfilled` branch never fires), so `GetIterator` /
`GetMethod` abrupt completion is being detected and propagated correctly.
What is wrong is that `v.constructor` resolves to an anonymous
`function () { [native code] }` rather than the global `%TypeError%`
intrinsic. The error object we construct on the `yield*` protocol failure
path is not linked to the realm's `TypeError` — either its prototype is a
freshly-minted native error prototype, or `.constructor` is left pointing at
an unnamed host shim.

Note the diagnostic detail that pins this down: the *expected* side prints as
`function TypeError() { [native code] }` (the real intrinsic is reachable from
the test's scope), while the *actual* side prints unnamed. So the intrinsic
exists — the throw site simply is not using it.

## Why this is worth fixing

It is a single shared throw path behind 364 tests, and the surrounding
semantics already pass. This is an error-object wiring fix, not a generator
redesign — distinct from #1691 (`yield*` does not delegate `throw()`/`return()`
to the inner iterator, in progress on PR #5063), which is about delegation
behaviour rather than error identity.

## Cross-lane note

The standalone lane shows 116 rows of `TypeError: Cannot read properties of
undefined (reading a class field)` on the *same* `yield-star-getiter-*` test
family (58 `language/expressions/class`, 58 `language/statements/class`). That
is a different, harder failure on the same tests — fixing #5304 will not fix
those, but they should be re-measured after this lands.

## Acceptance criteria

1. On a `yield*` protocol failure (non-callable `@@iterator`/`@@asyncIterator`,
   non-object iterator, non-callable `next`/`then`), the thrown/rejected value
   satisfies `v.constructor === TypeError` and
   `Object.getPrototypeOf(v) === TypeError.prototype`.
2. The 364 rows above flip to `pass` in the default lane.
3. No regression in the `yield-star-*` rows that pass today.
