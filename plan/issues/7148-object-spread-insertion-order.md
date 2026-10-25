---
id: 7148
title: "Native-first: object spread loses insertion order of enumerable keys"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
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
