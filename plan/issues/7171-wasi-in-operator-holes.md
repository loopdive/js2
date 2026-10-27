---
id: 7171
title: "WASI: the in operator answers wrongly for array holes, and differently inside callbacks"
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

# #7171 — wasi `in` on arrays with holes

Found by the round-2 review of PR #6918 (#7151). Pre-existing on `origin/main`, `--target wasi` only:

```js
const g: any[] = ["b", , "a", undefined];
console.log(1 in g);                                  // true    (node false)
console.log(g.map((_, i) => i in g).join());          // all false (node true,,true,true — map skips the hole)
```

## Implementation Plan (2026-10-26; implement on Opus)

1. Reproduce on wasi and confirm gc native-first/standalone differ (they are covered by #7170).
2. Find why the wasi lane lowers `in` on a vec differently (likely the linear/WASI helper set or a different element-presence helper); route it through the same presence test as the WasmGC native lanes once #7170 lands, or fix the wasi helper directly if it is a separate backend.
3. Tests: `tests/issue-7171-wasi-in-holes.test.ts` on wasi vs node.

Acceptance: node output on wasi; other lanes byte-identical; equivalence gate no new regressions.
