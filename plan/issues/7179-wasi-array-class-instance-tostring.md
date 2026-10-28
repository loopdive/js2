---
id: 7179
title: "WASI: a class instance with its own toString inside an array stringifies as [object Object]"
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
language_feature: builtins
goal: correctness
related: [7153, 7147]
---

# #7179 — WASI: a class instance with its own `toString` inside an array stringifies as `[object Object]`

Found in the review of PR #6935 (#7153). The bug is on main and on that PR's head.

```ts
class C { toString() { return "c"; } }
console.log(String([new C()]));      // node: c   wasi: [object Object]
console.log([new C(), 1].join("-"));  // node: c-1 wasi: [object Object]-1
```

A plain object literal with its own `toString` already works on wasi: `[{ toString(){return "o"} }].join()` prints `o`. Standalone handles both cases through the `__class_to_primitive` arm of `__to_primitive`, which only standalone builds (`src/codegen/object-runtime.ts`).

## Implementation Plan

1. Find where `ensureObjectRuntime` builds the standalone-only class arm, and the condition that excludes wasi.
2. Enable it on wasi the same way #7153 enabled the vec arm. Reserve the existing driver; do not duplicate it.
3. Tests: add a wasi lane next to the standalone rows for class-instance ToPrimitive (`String`, `join`, template literal, `+ ""`, and a class without `toString`), compared with node.
4. Bytes: gc native-first and standalone must stay byte-identical. State the wasi growth.
