---
id: 7180
title: "WASI: holes in a nested array literal read as an object / NaN"
status: ready
sprint: Backlog
created: 2026-10-27
updated: 2026-10-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: correctness
related: [7153, 7170]
---

# #7180 — WASI: holes in a nested array literal read as an object / NaN

Found in the review of PR #6935 (#7153). The bug is on main and on that PR's head. Standalone is correct.

```ts
console.log(String([[, 3]]));          // node: ,3    wasi: [object Object],3
const x = [[, 3]];
console.log(x[0].join("-"));           // node: -3    wasi: NaN-3
```

The inner literal's hole is not lowered as a hole on wasi. It reaches ToString as a non-array value, and `join` reads its element as a number. This may share a root with the native hole representation tracked in #7170.

## Implementation Plan

1. Dump the wasi WAT for `[[, 3]]` and compare it with standalone. Find where the nested elision lowers differently (array-literal codegen with the element type inferred from the hole).
2. Make the nested literal's hole use the same hole representation standalone uses. Check this against #7170 first, so the work isn't done twice.
3. Tests: a wasi lane covering nested holes in `String`, `join` and `length` and an indexed read, compared with node.
4. Bytes: gc native-first and standalone must stay byte-identical.
