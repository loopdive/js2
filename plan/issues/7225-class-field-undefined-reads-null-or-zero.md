---
id: 7225
title: "A class field that holds `undefined` reads back as `null` / `0` / `false`"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7215]
---

# #7225 — undefined in typed class fields

Found by the PR #7045 (#7215) reviews. Same on main with explicit fields:

```ts
class A { s?: string; x?: number; constructor(s?: string, x?: number) { this.s = s; this.x = x; } }
const a = new A();
console.log(String(a.s), a.x, JSON.stringify(a));
// node: undefined undefined {} — we: null 0 {"s":null,"x":0}
```

`any` / `unknown` / generic `T` fields holding undefined also serialise as
`{"v":null}` (node: `{}`); #7045 pins that as a known residual.

This is why #7215 keeps optional and `| undefined` parameter properties on the
old (field-less) path; fixing this lifts that exclusion.

## Plan

1. Decide the representation for a field whose type admits undefined (an
   externref/dynamic carrier, or a presence bit) and measure JSON/keys/`in`.
2. Apply it to explicit fields first, then drop the #7215 exclusion.
3. Tests on 3 lanes against node, including JSON and `Object.keys`.
