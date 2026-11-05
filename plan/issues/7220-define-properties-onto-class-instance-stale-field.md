---
id: 7220
title: "`Object.defineProperties` onto a class instance leaves the typed field stale"
status: ready
sprint: Backlog
created: 2026-11-01
updated: 2026-11-01
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7201]
---

# #7220 — defineProperties writes beside the struct field

Found by the PR #7020 (#7201) round-2 review. Same on standalone, wasi and gc:

```js
class A { a = 1 }
const o = new A();
Object.defineProperties(o, { a: { value: 5 } });
console.log(o.a, JSON.stringify(o));   // node: 5 {"a":5} — we: 1 {"a":5}
```

The descriptor lands in the side table, so JSON (which reads it) and the typed
field read (which reads the struct slot) disagree. A getter descriptor passed
the same way reads `undefined`.

## Plan

1. Route `defineProperty`/`defineProperties` with a `value` descriptor on a
   declared struct field to the field store; decide how accessor descriptors on
   a declared field are represented (fall back to the dynamic object, or
   reject with the existing path).
2. Tests on 3 lanes against node, including `Object.defineProperty`.
