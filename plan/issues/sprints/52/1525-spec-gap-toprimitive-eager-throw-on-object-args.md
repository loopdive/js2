---
id: 1525
sprint: 52
title: "spec gap: built-in coercion paths throw 'Cannot convert object to primitive value' eagerly"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: to-primitive, abstract-operations
es_edition: ES2024
test262_category: multiple (Array, String, DataView, Boolean, equality)
test262_count: 170
related: [1253, 1129, 1434]
---

# #1525 — `Cannot convert object to primitive value` raised too eagerly

## Problem

170 tests fail at runtime with:

```
L41:3 Cannot convert object to primitive value
```

The error originates in our `ToPrimitive` host import / runtime path
when the receiver is an exotic / extern-wrapped object. Per spec
(§7.1.1) `ToPrimitive(input, hint)` must:

1. call `@@toPrimitive` (Symbol.toPrimitive) if present,
2. otherwise call `OrdinaryToPrimitive(input, hint)`,
3. which tries `valueOf` then `toString` (or reverse for hint `string`),
4. and only throws `TypeError` if **both** return objects.

We appear to throw immediately when the user object does not have a
native `Symbol.toPrimitive` slot, instead of falling through to the
ordinary path. That regresses any `==`, arithmetic coercion, or
`ToInteger`/`ToIndex` call against an exotic receiver.

## Failing test examples

- `test/language/expressions/does-not-equals/S11.9.2_A4.1_T1.js` — `obj != 0` coercion
- `test/built-ins/Array/prototype/indexOf/15.4.4.14-10-1.js` — `indexOf` against a primitive-wrapped receiver
- `test/built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-2.js` — reducer return value coerced
- `test/built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js` — Boolean wrapper toString
- `test/built-ins/DataView/prototype/setInt8/toindex-byteoffset.js` — `ToIndex(byteOffset)`

Note: distinct from #1253 (`OrdinaryToPrimitive` returning `undefined`
instead of throwing), which is the *opposite* failure mode.

## Approach

1. Audit `src/runtime.ts` and any `__toPrimitive` import or builtin
   for early-throw paths.
2. Make the fallback walk `valueOf` then `toString` (or reverse for
   `string` hint) and only throw when both return objects.
3. Make sure `Symbol.toPrimitive` lookup tolerates absent slot
   without raising.

## Acceptance criteria

- The five example tests reach the assertion phase, with at least 100
  of the 170 cluster tests flipping CE/runtime-error → pass or
  assertion-fail.
- No regression in the existing `ToNumber/ToNumeric` tests covered by
  #1434.

## Estimated impact

**~170 test262 tests**, distributed across Array, String, DataView,
Boolean, equality operators.
