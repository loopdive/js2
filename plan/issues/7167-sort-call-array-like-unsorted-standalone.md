---
id: 7167
title: "Standalone: Array.prototype.sort.call(arrayLike) leaves the array-like unsorted"
sprint: current
created: 2026-10-25
updated: 2026-10-25
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: ready
reasoning_effort: high
priority: low
horizon: m
feasibility: medium
language_feature: arrays
related: [7151, 7165]
---

# #7167 — generic-receiver `sort` is a no-op on standalone

Found while implementing #7151 (PR #6918). Pre-existing on `origin/main`,
standalone (gc native-first and host-assisted: verify):

```js
const o = { length: 3, 0: "c", 1: undefined, 2: "a" };
Array.prototype.sort.call(o);
console.log(o[0] + o[1] + o[2]);   // "cundefineda"   (node: "acundefined")
```

## Cause (as diagnosed; verify before fixing)

The generic-receiver arm of `sort` (`Array.prototype.sort` value body, `sortCompareGreater` in `src/codegen/array/array-sort-value.ts`) reads the array-like through `__extern_get` but writes back nothing on standalone (or writes to a copy). #7151 left this path byte-identical.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce on standalone and gc native-first; also with a comparator, with holes (`{ length: 3, 0: "b", 2: "a" }` → `"a","b",<hole>`), and with `arguments`.
2. Implement §23.1.3.30 steps for a generic receiver: SortIndexedProperties (read `0..len-1` via HasProperty/Get, skip holes), sort the collected list with the #7151 comparator-less rule or the user comparator, then write back with Set(true) for the sorted prefix and DeletePropertyOrThrow for the remaining indices. Reuse `prepareExternVecDefaultSortCompare` for the comparison; no host imports.
3. Tests: `tests/issue-7167-sort-call-array-like.test.ts` with the programs on standalone and gc native-first vs node.

Acceptance: node's output; host-assisted gc bytes unchanged; equivalence gate no new regressions.
