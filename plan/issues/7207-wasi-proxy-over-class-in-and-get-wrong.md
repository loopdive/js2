---
id: 7207
title: "wasi: `\"x\" in p` and `p.x` on an empty-handler Proxy over a class instance give wrong answers"
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
related: [7161, 7171]
---

# #7207 — wasi Proxy-over-class reads

Found while implementing #7161 (PR #7008). The bug is already on main and
shows up on wasi only, even at top level:

```js
class C { x = 1 }
const p = new Proxy(new C(), {});
console.log("x" in p, p.x);   // node: true 1 — wasi: wrong
```

gc native-first and standalone are correct. The #7161 test has a row that
excludes wasi because of this.

## Plan

1. Compare the wasi lowering of the Proxy `has` and `get` fallthrough with
   standalone, where it works. #7171 (wasi `in`) may be the same root cause;
   check that first.
2. Tests: on wasi, against node, add the row the #7161 test currently skips.
