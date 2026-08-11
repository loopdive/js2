---
id: 4363
title: "spec gap: BigInt TypedArray paths reject harness `makeArray` values — 287 tests `Cannot convert N to a BigInt`"
status: ready
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen+runtime
language_feature: bigint, typed-array
goal: spec-completeness
related: [1644, 1515, 1645, 1700]
origin: "2026-08-11 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260811-103533, gitHash 9268d5a5)"
---

# #4363 — BigInt TypedArray paths reject the harness's own `makeArray` values

## TL;DR

**287 official failing tests** in the **default (JS-host)** lane fail with a
single `type_error` signature:

```
TypeError: Cannot convert 4 to a BigInt (Testing with BigInt64Array and makeArray.)
```

The number varies per test (`4`, `40`, `42`, …); the parenthetical is constant.
This is the **largest single named-category bucket in the default lane** and the
third-largest bucket overall.

## Evidence

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260811-103533` (gitHash `9268d5a5`), 48,735 entries / 43,621 official.

| Directory | Count |
|---|---|
| `built-ins/TypedArray/prototype` | 222 |
| `built-ins/TypedArrayConstructors/internals` | 54 |
| `built-ins/TypedArrayConstructors/from` | 8 |
| `built-ins/TypedArrayConstructors/ctors-bigint` | 3 |
| **Total** | **287** |

Samples:

- `test262/test/built-ins/TypedArray/prototype/sort/BigInt/sorted-values.js`
- `test262/test/built-ins/TypedArray/prototype/subarray/BigInt/minus-zero.js`
- `test262/test/built-ins/TypedArray/prototype/reduce/BigInt/callbackfn-arguments-default-accumulator.js`
- `test262/test/built-ins/TypedArrayConstructors/internals/DefineOwnProperty/BigInt/detached-buffer-throws.js`
- `test262/test/built-ins/TypedArray/prototype/slice/BigInt/speciesctor-get-ctor-inherited.js`

## Root cause hypothesis

The `(Testing with BigInt64Array and makeArray.)` suffix comes from
`testTypedArray.js`'s `testWithBigIntTypedArrayConstructors` helper, which
iterates the BigInt TypedArray constructors and builds inputs with `makeArray`.
The message says our runtime refused to convert a **plain Number** (`4`) to a
BigInt.

Per spec that refusal is *correct* for `ToBigInt(4)` — but the harness is
supposed to be handing these paths **BigInt** values in the first place. So the
defect is upstream of the throw: either

1. `makeArray` / the harness's BigInt element factory is producing f64 elements
   because our compiled path lost the `n` literal suffix or the `BigInt(...)`
   call, or
2. the TypedArray element read/write path eagerly coerces the element to f64
   (the exact "typed paths assume f64 too eagerly" failure mode of **#1644**)
   and then feeds that f64 back into a `ToBigInt` slot.

(2) is the stronger hypothesis and makes this a **likely regression or
incomplete fix of #1644** — that issue is `status: done`, was scoped at *47*
test262 fails, and the count in this family is now 287. See the regression note
added to #1644.

## Acceptance criteria

- [ ] Determine whether the f64 value reaching `ToBigInt` originates in
      `makeArray` (harness lowering) or in the TypedArray element path
      (codegen coercion). Name the site.
- [ ] A BigInt64Array/BigUint64Array element round-trip
      (`ta[0] = 1n; ta[0]`) preserves BigInt through the compiled path with no
      intermediate f64.
- [ ] The `Cannot convert N to a BigInt (Testing with …)` bucket goes to 0, or
      the residual is re-bucketed under a genuine spec-required TypeError with
      the count stated.
- [ ] No regression in `built-ins/BigInt/**` or `built-ins/TypedArray/**`.

## Notes

Do not "fix" this by making `ToBigInt` accept Numbers — that would be a spec
violation and would silently pass tests that assert the TypeError. The fix is to
stop producing the Number.
