---
id: 2993
title: "standalone: generator-closure lowering emits i64/BigInt where externref expected → invalid-wasm CE (`__closure_3`) on BigInt generator-iterable TypedArray ctor"
status: ready
sprint: current
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
language_feature: generators, closures, bigint, typed-arrays
related: [2940, 2939]
created: 2026-07-02
origin: "2026-07-02 — discovered during #2940/PR #2463 (vacuity scorer) regression triage. Pre-existing on upstream/main, unrelated to that PR."
---

# #2993 — generator-closure lowering: i64/BigInt passed where externref expected → invalid-wasm CE

## Problem

Compiling a generator function-expression that yields **BigInt** values inside a
higher-order/harness closure produces **invalid Wasm** in the standalone
(WasmGC, `--target standalone`) lane. The generated `__closure_3` body passes an
`i64` (the lowered BigInt value) into a slot the closure/iterator plumbing
expects to be `externref`, so the module fails validation → `compile_error`
(CE), never reaching instantiation.

This is a **pre-existing** codegen bug on `upstream/main`. It is **NOT** caused
by #2940 / PR #2463 (the runner vacuity scorer) — it was surfaced only because
that PR's regression triage re-ran the full BigInt-TypedArray corpus on the
standalone lane. The test was `compile_error` on the standalone baseline and
stays `compile_error` after the PR (CE→CE, no flip). Filed separately so #2463
can admin-merge cleanly.

## Repro

`test262/test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/as-generator-iterable-returns.js`

```js
testWithBigIntTypedArrayConstructors(function(TA) {
  var obj = (function *() {
    yield 7n; yield 42n;      // BigInt yields
  })();
  var typedArray = new TA(obj); // construct TA from a generator iterable
  assert.sameValue(typedArray.length, 2);
  // ...
}, null, ["passthrough"]);
```

Compile on the standalone lane and observe the invalid-wasm rejection in the
generator closure body (`__closure_3`): an `i64`/BigInt value lands where the
closure/iterator machinery declares an `externref` parameter or field, so
WasmGC validation rejects the module.

## Suspected root cause

The generator lowering boxes/threads yielded values through the closure's
capture/result plumbing as `externref` (the generic `any` iterator-value
representation), but a BigInt yield is lowered to a native `i64` and is written
into that slot **without** the i64→externref boxing coercion (`__box_bigint` /
equivalent) that the generic path expects. Likely in the generator/closure
codegen where yielded values are stored into the iterator result struct or the
closure capture cell — the coercion to the declared `externref` slot kind is
missing for the i64/BigInt value-kind.

## Acceptance criteria

- The repro file compiles to **valid Wasm** on the standalone lane (no
  `__closure_3` invalid-wasm CE). Genuine pass/fail of the underlying TypedArray
  semantics is a separate concern — the bar here is: no invalid-wasm CE from the
  BigInt-yield generator closure.
- A scoped regression test (`tests/issue-2993.test.ts`) covering a BigInt-yield
  generator threaded through a closure/HOF on the standalone lane.
- No regression on the non-BigInt generator-iterable sibling tests.

## Notes

- Discovered in #2940/PR #2463 triage; see that issue's classification table
  (the "1 async-gen invalid-wasm" / latent `__closure_3` follow-up bullet).
- Related dynamic-closure-dispatch work: #2939.
