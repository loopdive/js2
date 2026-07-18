---
id: 1568
title: "Object(BigInt) and Object(Symbol) must auto-box to wrappers (typeof === \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"object\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\")"
status: done
created: 2026-05-21
updated: 2026-07-17
completed: 2026-05-27
feasibility: easy
sprint: 56
depends_on: [1129]
owner: developer
type: fix
source: plan/issues/sprints/53/post-wave-regression-investigation.md
blocks: []
labels: [test262, regression, ToObject, ECMAScript-spec]
# Restoring the regressed __new_BigInt/__new_Symbol Object(v) wrapper handler
# (a single early-return) in the runtime's extern_class "new" dispatch — an
# intentional +13 in the runtime barrel that carries the host import handlers.
loc-budget-allow:
  - src/runtime.ts
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

## Resolution (2026-05-27)

- **calls.ts** `Object(x)` switch — added a `BigInt` branch after boolean:
  compiles the arg to `i64` and calls a new `__new_BigInt(i64) → externref`
  late import.
- **runtime.ts** construct dispatch (`intent.action === "new"`) — special-cases
  `intent.className === "BigInt" || "Symbol"` to box via the spec's literal
  `Object(v)`, since BigInt/Symbol are not constructors and `new BigInt(v)`
  throws. Placed before the generic `new Ctor(...)` so `__new_BigInt` no longer
  resolves to "No dependency provided for extern class BigInt".
- Symbol shares the same runtime handler; the codegen Symbol branch is deferred
  until Symbol primitives are plumbed end-to-end (no `isSymbolType` arg path
  yet) — the runtime side is ready for when it lands.

All 6 assertions of `test/language/expressions/typeof/bigint.js` now pass
(verified directly), including #4/#5/#6 that previously returned "bigint".
Note: `Object(0n).valueOf() === 0n` does not round-trip in the unit harness —
this is a pre-existing wrapper-`.valueOf()` unboxing limitation shared by the
number/string/boolean wrappers (the String equivalent behaves identically), out
of scope here. The real test262 test only checks `typeof`.

## Regression + restore (2026-07-17)

The original `__new_BigInt(v)` / `__new_Symbol(v)` runtime handler (an early
`return (v) => Object(v)` at the top of the `extern_class` `"new"` dispatch)
was **dropped during a later runtime.ts refactor** that relocated the
`extern_class` block (it now lives near line 7635). With the handler gone,
`Object(BigInt(42))` / `Object(BigInt(0n))` fell through to the generic
`builtinCtors[className]` lookup, and since neither `BigInt` nor `Symbol` is a
constructor (not in `builtinCtors`), the resolver threw
`No dependency provided for extern class "BigInt"` at runtime — 3 of the 6
`tests/issue-1568.test.ts` cases (the ones invoking `BigInt(...)`) failed on
main. Restored the identical single-early-return handler in the current
`action === "new"` block. All 6 tests pass again.

## Test Results

- `tests/issue-1568.test.ts` — 6 tests, all pass (was 3 failing on main).
- `tests/issue-1129.test.ts` — 9 existing tests, all pass (no regression).

## References

- PR #460 / commit `ff139f2e5` "fix(#1129): ToObject — primitive auto-boxing for Object(x)"
- Investigation: `plan/issues/sprints/53/post-wave-regression-investigation.md`
