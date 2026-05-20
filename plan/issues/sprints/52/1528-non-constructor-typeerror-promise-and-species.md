---
id: 1528
sprint: 52
title: "spec gap: non-constructor TypeError — Promise.all / allSettled species and executor paths"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: promise, species, constructor-invariants
es_edition: ES2015+
test262_category: built-ins/Promise, language/function-code
test262_count: 79
related: [1519]
---

# #1528 — `[object Object] is not a constructor` instead of spec TypeError

## Problem

79 test262 tests fail with:

```
[object Object] is not a constructor
```

The error wording is our runtime's host string, not the spec
`TypeError("X is not a constructor")` shape. Most cases come from
Promise combinators and from explicit non-constructor invocation
checks. Per spec, `Construct(C, …)` requires `IsConstructor(C)` and
throws `TypeError` otherwise — with the wording `"<X> is not a constructor"`.

## Failing test examples

- `test/built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js`
- `test/built-ins/Promise/allSettled/species-get-error.js`
- `test/built-ins/Promise/executor-function-not-a-constructor.js`
- `test/built-ins/Promise/allSettled/reject-element-function-length.js`
- `test/language/function-code/10.4.3-1-26gs.js`

Most tests do `assert.throws(TypeError, …)` so they fail because the
thrown object isn't recognised as `TypeError`. Two cases are related:

1. Promise species lookup (`@@species`) returns a non-constructor;
   we should call `IsConstructor` and throw spec `TypeError`.
2. `Promise.all/allSettled/any/race` executor handling — the *resolve*
   /*reject* element-function paths fall through into a `Construct`
   we don't gate.

## Approach

1. Make `IsConstructor` available at the codegen sites that perform
   `[[Construct]]` (Promise combinators, `new`).
2. Make the failure path raise spec `TypeError` with the canonical
   message instead of the host runtime string.
3. Bridge to #1519 (new-expression non-constructor TypeError) — there
   is likely a shared helper.

## Acceptance criteria

- The five example tests pass.
- The error string contains `"is not a constructor"` and the thrown
  object is `instanceof TypeError`.
- At least 50 of the 79 cluster tests flip to pass.

## Estimated impact

**~79 test262 tests** plus indirect downstream unblocks once Promise
combinators round-trip species correctly.
