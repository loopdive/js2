---
id: 7224
title: "Own fields on a builtin subclass (`extends Error`/`Object`) are never stored"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7215]
---

# #7224 — builtin-subclass own fields

Found while implementing #7215 (PR #7045). A class that extends a builtin keeps
its own fields in the builtin's props backing, which neither field
initialisers nor parameter properties reach:

```ts
class E extends Error { code = 7; constructor(public tag: string) { super("m"); } }
const e = new E("t");
console.log(e.code, e.tag);   // node: 7 t — we: NaN (and tag missing)
```

`extends Object` with a parameter property is also broken. #7215 leaves every
builtin subclass byte-identical to base on purpose.

## Plan

1. Find how `$Error_struct` (and the other builtin-backed parents) store
   own properties, and route field initialisers and parameter-property stores
   there.
2. Tests on 3 lanes against node: Error, TypeError, Map, Array, Object
   parents, with initialisers and parameter properties.
