---
id: 7208
title: "A Proxy's valueOf/toString/Symbol.toPrimitive is never called in arithmetic or concatenation"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: correctness
related: [7161]
---

# #7208 — ToPrimitive on a Proxy

Found by the PR #7008 round-2 review. This is already on main, even at top
level:

```js
class C { valueOf() { return 21; } toString() { return "c"; } }
const p = new Proxy(new C(), {});
console.log(p * 2, "[" + p + "]");   // node: 42 [c] — we print NaN [object Object]
```

## Plan

1. Route ToPrimitive on a Proxy carrier through the Proxy `get` trap (or the
   target, when the handler has no trap) for `Symbol.toPrimitive`, `valueOf`
   and `toString`.
2. Tests on 3 lanes against node: arithmetic, concatenation, template literals
   and comparison, with and without a `get` trap.
