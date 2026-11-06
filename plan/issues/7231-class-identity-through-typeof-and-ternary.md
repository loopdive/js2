---
id: 7231
title: "`new K()` with `K: typeof P` bound to a subclass constructs `P`; virtual calls through a ternary-returned instance pick the wrong method"
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
related: [7216, 7223]
---

# #7231 — class identity lost through typed indirections

Found in the #7216 and #7223 reviews. On main:

```ts
class P { who() { return "P"; } }
class Q extends P { who() { return "Q"; } }
const K: typeof P = Q;
console.log(new K().who());               // node: Q — we: P

const pick = (b: boolean): P => b ? new Q() : new P();
console.log(pick(true).who());            // node: Q — reported wrong
```

## Plan

1. Reproduce both on 3 lanes; find where the static type replaces the
   runtime class (construction through a `typeof` binding; method dispatch on
   a value whose static type is the base).
2. Dispatch on the runtime tag / class value.
3. Tests against node.
