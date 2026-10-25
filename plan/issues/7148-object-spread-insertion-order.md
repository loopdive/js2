---
id: 7148
title: "Native-first: object spread loses insertion order of enumerable keys"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-25
completed: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708]
# 2026-10-25: +6 lines in the native `__object_assign` body — the $Object
# source loop now runs once per ordered entry list (strings, then symbols)
# instead of once over the hash-ordered props table. Splitting the 1.2k-line
# builder is out of scope for this bugfix.
loc-budget-allow:
  - src/codegen/object-runtime-enumeration.ts
func-budget-allow:
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
---

# #7148 — Native-first: object spread loses insertion order of enumerable keys

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `object/02-spread.js` went `match → mismatch — `Object.keys({...a, z`
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`object/02-spread.js`: mismatch — `Object.keys({...a, z: 3})` with `a = {x: 1, y: 2}` prints `y,x,z`; V8 prints `x,y,z`

## Cause (as diagnosed; verify before fixing)

The native spread copy, or the enumeration order of the resulting shape, does not preserve the source's insertion order (the copy probably walks a hash/shape table in storage order rather than the ordered key list). Site: the object-spread lowering in `src/codegen/expressions/` (grep `SpreadAssignment`) and the native `Object.keys` enumeration (`object-model/`).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `const a = {x:1, y:2}; console.log(Object.keys({...a, z:3}).join())` and with a `for…in` over the spread result, gc native-first and standalone.
2. Find which side is unordered: compare `Object.keys(a)` (source) vs `Object.keys({...a})` (copy). Fix the copy to iterate the source's ordered own-enumerable keys (the same iterator `for…in` / `Object.keys` use) and append in that order; integer-like keys first per OrdinaryOwnPropertyKeys if the native object model distinguishes them.
3. Equivalence tests: spread of literal, of a class instance, of an object with numeric keys, nested spreads; `Object.entries`/`JSON.stringify` order on the result.

Acceptance: `npx tsx scripts/diff-test.ts` row for `object/02-spread.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7148-*.test.ts` pins the
case on standalone and gc.

## Resolution (2026-10-25)

Cause confirmed on the copy side: `Object.keys(a)` was already ordered, but the
native `__object_assign` (object spread + `Object.assign`,
`src/codegen/object-runtime-enumeration.ts`) walked an open `$Object` source's
`props` table in hash order. The `$Object` source arm now walks
`__obj_ordered(so)` (integer keys ascending, then string keys by insertion seq)
and then `__obj_ordered_symbols(so)` when symbol keys are enabled, the same
ordered lists `Object.keys` / `for…in` use. Host-assisted gc is untouched (it
uses the JS `__object_assign` import).

Left open (different paths, not the native copy):

- `for (k in { ...a, z })` and an INLINE `Object.entries({ ...a, z })` still
  yield `z` first on native lanes (and the inline `entries` case on host-assisted
  too): both read the checker's spread TYPE, whose property list TypeScript
  orders own-props first (`for-in-static-unroll.ts` / static entries lowering).
- `{ ...closedStructWithSymbolExpando }` drops the expando keys on native lanes.

probe/test reference: tests/issue-7148-object-spread-insertion-order.test.ts
