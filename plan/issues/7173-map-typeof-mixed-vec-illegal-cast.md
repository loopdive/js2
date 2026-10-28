---
id: 7173
title: "Native lanes: .map(v => typeof v) on a vec filled with mixed push values traps with an illegal cast"
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

# #7173 — `.map(typeof)` illegal cast on a mixed vec

Found by PR #6918 (#7151) and its round-2 review. Pre-existing on `origin/main`, gc native-first, standalone and wasi:

```js
const g: any[] = []; g.push("b"); g.push(1); g.push(undefined);
console.log(g.map(v => typeof v).join());   // traps "illegal cast"   (node "string,number,undefined")
```

## Implementation Plan (2026-10-26; implement on Opus)

1. Reproduce; dump WAT and find the cast: likely the `map` callback parameter is specialised to the first pushed element type (string) and the per-element `ref.cast` traps on the boxed number — the same storage-vs-checker element-type mismatch as #7146 and #7154.
2. Make the `map` element read and callback parameter use the vec's actual storage element type (externref for an evolving `any[]`), never a narrower type inferred from one push; reuse the #7146 storage-type helper.
3. Tests: `tests/issue-7173-map-typeof-mixed-vec.test.ts` with `map`, `forEach`, `filter` on mixed vecs on the three native lanes vs node.

Acceptance: node output on all three lanes; host-assisted gc bytes unchanged; equivalence gate no new regressions.
