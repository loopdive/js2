---
id: 7147
title: "Native-first: Array.prototype.join stringifies a nested array element as [object Object]"
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

# #7147 — Native-first: Array.prototype.join stringifies a nested array element as [object Object]

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `array/11-flat-flatMap.js` went `match → mismatch — `[1,[2,[3,[4]]]].flat().join(",")` prints `1,2,3,[object Object]`; V8 prints `1,2,3,4``
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`array/11-flat-flatMap.js`: mismatch — `[1,[2,[3,[4]]]].flat().join(",")` prints `1,2,3,[object Object]`; V8 prints `1,2,3,4`

## Cause (as diagnosed; verify before fixing)

The native join stringifies a nested vec element through the generic object ToString instead of `Array.prototype.toString` (which is a recursive join). Site: the element-to-string arm of `compileArrayJoinNative` / the shared ToString used by join for `anyref` elements (array-methods.ts ≈5810ff; the ToString dispatch in `src/codegen/native-strings*` / `object-model`).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `console.log([1,[2,[3]]].join(","))` and `String([1,[2]])` on gc native-first and standalone.
2. In the ToString dispatch used by join (and `String(x)` / template literals, which share it), add the array brand arm: an array element stringifies via the native join with `","` (recursive; cycle guard as the spec's `Array.prototype.join` empty-string-on-cycle rule).
3. Equivalence tests for nested join, `String([..])`, template with an array, `[].toString()`; confirm `JSON.stringify` is not routed through this path.

Acceptance: `npx tsx scripts/diff-test.ts` row for `array/11-flat-flatMap.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7147-*.test.ts` pins the
case on standalone and gc.
