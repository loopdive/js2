---
id: 7036
title: "JS host: defineProperty partial accessor redefinition / gOPD of accessor halves regressed on compiled objects (issue-2992-accessor-merge, issue-3316 red)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: property-descriptors
goal: core-semantics
parent: 7014
related: [2992, 3316, 7029]
---

# #7036 — accessor merge on the gc lane

## Evidence (upstream/main 0727e2985b)

- `tests/issue-2992-accessor-merge.test.ts` 5 red (all `(gc)`): get-only
  redefine throws `TypeError: Cannot assign to read only property 'foo'` from
  `_safeSet` (`src/runtime.ts` ~L6282) via `__set_member_foo`; flags-only
  redefine, explicit `{get: undefined, set: undefined}`, non-configurable getter
  change and `defineProperties` all return 0 instead of 1.
- `tests/issue-3316.test.ts` 2 red (gc): the same `_safeSet` read-only throw and
  a gOPD null accessor half not materialised as `undefined`.

The write path `__set_member_<k>` seems to see a data descriptor (writable:
false) where the merged descriptor is an accessor, i.e. the merge stored a data
property instead of keeping the live setter.

## Plan

1. Reproduce with test262 `built-ins/Object/defineProperty/15.2.3.6-4-107.js` on the gc lane.
2. Bisect from the July anchor `38dd745884` (src-only extraction).
3. Fix the sidecar descriptor merge so a partial accessor descriptor keeps the
   other half (§10.1.6.3 ValidateAndApplyPropertyDescriptor step 9/10).
4. Scoped test262 `built-ins/Object/defineProperty`, `built-ins/Object/defineProperties`, `built-ins/Object/getOwnPropertyDescriptor` base vs fix.

## Acceptance criteria

- [ ] both files green
- [ ] no test262 regression in the scoped dirs
