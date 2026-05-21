---
id: 1568
title: Object(BigInt) and Object(Symbol) must auto-box to wrappers (typeof === "object")
status: ready
feasibility: easy
owner: developer
type: fix
created: 2026-05-21
source: plan/issues/sprints/53/post-wave-regression-investigation.md
blocks: []
depends_on: [1129]
labels: [test262, regression, ToObject, ECMAScript-spec]
---

# #1568 — Object(BigInt) and Object(Symbol) auto-box

## Background

PR #460 (commit `ff139f2e5`, "fix(#1129): ToObject — primitive auto-boxing for Object(x)") implemented `Object(prim)` boxing for number, string, and boolean — but **not BigInt or Symbol**. The spec §20.1.1.1 / §7.1.18 ToObject requires boxing for all primitive types except null/undefined.

## Failing test (post-wave 2026-05-21)

`test/language/expressions/typeof/bigint.js` — assertion #4:

```js
assert.sameValue(
  typeof Object(BigInt(0n)),
  "object",
  "typeof Object(BigInt(0n)) === 'object'"
);
```

Returns "bigint" instead of "object" because `Object(bigint)` falls into the "Object(object) → return argument unchanged" branch in `src/codegen/expressions/calls.ts:~5643-5750`.

Assertion #5 (`typeof Object(BigInt(0))`) and #6 (`typeof Object(0n)`) likely fail the same way; #6 might appear as a separate test262 failure (TBD).

## Implementation plan

1. Add a `BigInt` branch to the `Object(x)` switch in `src/codegen/expressions/calls.ts` (alongside the existing `__new_Number` / `__new_String` / `__new_Boolean` cases).
2. Add a host import `__new_BigInt(bigint) → externref` that creates a fresh BigInt-wrapper object whose `typeof` is "object" and whose `valueOf()` returns the underlying primitive.
3. Implement `__new_BigInt` in `src/runtime.ts` — JS side: `return Object(bigintValue)` (the spec's literal definition).
4. Apply the same treatment for `Symbol` if/when a Symbol primitive type is plumbed end-to-end. Currently Symbol primitives don't have a TypeFlags branch in the compiler — defer to a separate sub-issue or note that the Symbol branch is a no-op stub for now.

## Acceptance criteria

- `test/language/expressions/typeof/bigint.js` passes (asserts #4 and #5).
- `tests/issue-1129.test.ts` continues to pass.
- New unit test `tests/issue-1568.test.ts` covers:
  - `typeof Object(0n) === "object"`
  - `typeof Object(BigInt(42)) === "object"`
  - `Object(0n).valueOf() === 0n`

## Spec references

- §20.1.1.1 `Object ( [ value ] )` — step 2.a: if `value` is `null` or `undefined`, return `! OrdinaryObjectCreate(%Object.prototype%)`. Step 3: return `! ToObject(value)`.
- §7.1.18 ToObject — Table 13: BigInt → "Return a new BigInt object whose [[BigIntData]] internal slot is set to argument."

## References

- PR #460 / commit `ff139f2e5` "fix(#1129): ToObject — primitive auto-boxing for Object(x)"
- Investigation: `plan/issues/sprints/53/post-wave-regression-investigation.md`
