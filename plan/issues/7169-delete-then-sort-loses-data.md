---
id: 7169
title: "Native lanes: sort() after delete a[i] moves values but not the deleted-index record, losing data"
status: ready
sprint: current
created: 2026-10-26
updated: 2026-10-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: correctness
parent: 6979
related: [7151, 7164, 7166]
---

# #7169 — `delete` + `sort()` corrupts the array

Found by the round-2 review of PR #6918 (#7151). Pre-existing on `origin/main` for typed `number[]`; #7151 makes externref vecs sort and so exposes it there too.

```js
function f() { const g: number[] = [3, 1, 2]; delete g[0]; g.sort(); return g.join("|"); }
// js2 native lanes: "|2|3"   (node: "1|2|")
const h: any[] = []; h.push("b"); h.push(undefined); h.push("a"); delete h[0]; h.sort();
// js2: "undefined|b|undefined"   (node: "a|undefined|undefined"; spec: values sorted, then undefineds, then holes)
```

## Implementation Plan (2026-10-26; implement on Opus)

1. Reproduce on gc native-first, standalone, wasi for typed `number[]`, `string[]` and externref vecs.
2. In the default-sort lowering (`compileArrayDefaultToStringSort`, `src/codegen/array-methods.ts`, and `prepareExternVecDefaultSortCompare`, `src/codegen/array/array-sort-value.ts`) treat a deleted slot as a hole (the `$Hole` sentinel / the typed-vec hole encoding) when collecting elements: collect present values, sort them, write them back to `0..k-1`, then undefineds, then leave holes at the end (§23.1.3.30 SortIndexedProperties + write-back with DeletePropertyOrThrow).
3. Tests: `tests/issue-7169-delete-then-sort.test.ts` with the two programs and a comparator variant on the three native lanes vs node.

Acceptance: node output on all three lanes; host-assisted gc bytes unchanged; equivalence gate no new regressions.
