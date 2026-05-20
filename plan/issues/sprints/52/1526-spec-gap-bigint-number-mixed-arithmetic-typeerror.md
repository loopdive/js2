---
id: 1526
sprint: 52
title: "spec gap: BigInt + Number mixed arithmetic should throw spec TypeError, not host error"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: bigint, type-coercion
es_edition: ES2020
test262_category: language/expressions/{addition,multiplication,division,exponentiation}, built-ins/BigInt
test262_count: 30
related: [1434, 1129]
---

# #1526 — Mixed BigInt + Number arithmetic surfaces as host error string

## Problem

30 test262 tests fail with the literal message:

```
Cannot mix BigInt and other types, use explicit conversions
```

This is the V8 engine's native runtime error string bubbling up
because our runtime delegates BigInt coercion to the JS host without
catching it and re-throwing a spec `TypeError`. Per §6.1.6.2 / §13.15
the operation should:

1. Apply `ToPrimitive` to both operands.
2. If exactly one is a BigInt → throw `TypeError`.
3. Otherwise proceed with the appropriate numeric algorithm.

We get step 3 right when both sides are BigInt; the broken case is
step 2 when one is BigInt and the other coerces via
`Symbol.toPrimitive` to BigInt or Number.

## Failing test examples

- `test/language/expressions/division/bigint-wrapped-values.js`
- `test/language/expressions/exponentiation/bigint-toprimitive.js`
- `test/language/expressions/multiplication/bigint-toprimitive.js`
- `test/built-ins/BigInt/wrapper-object-ordinary-toprimitive.js`
- `test/language/expressions/addition/coerce-bigint-to-string.js`

## Approach

1. Locate the binary-op codegen path that emits the host-import call
   for BigInt-mixed cases.
2. Wrap the host call in a try/catch that converts a host
   `TypeError("Cannot mix BigInt …")` into a spec `TypeError` with
   the standard wording, *or*
3. Better: detect the mixed-type case before the host call and emit a
   `throw new TypeError(...)` directly so the error site & message
   are spec-compliant in standalone mode too.

## Acceptance criteria

- The five example tests pass (they `assert.throws(TypeError, …)`).
- BigInt + BigInt arithmetic still works (regression-test addition,
  multiplication, division).
- Works in WASI / standalone mode (no JS host dependency for the
  throw).

## Estimated impact

**~30 test262 tests** — small but high-feasibility, and removes a
host-mode/standalone-mode behaviour gap.
