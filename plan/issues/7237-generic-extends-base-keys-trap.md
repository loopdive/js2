---
id: 7237
title: "Generic f<T extends Base>(x) keys/for-in trap on subclass instances"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [7216, 7156]
---

# #7237: keys / for-in through a generic `T extends Base` parameter

Noted while planning #7216: the #7216 fix routes receivers by their static
class type. A generic parameter `T extends Base` is not covered.

```ts
class A { a = 1 } class B extends A { b = 2 }
function k<T extends A>(x: T) { return Object.keys(x).join(","); }
export function test() { return k(new B()); } // node "a,b"
```

Reported to trap on all lanes. First step: reproduce on current main on gc,
standalone and wasi, and record base/node per lane. Then extend
`class-arm-tag-guard.ts`'s receiver classification to resolve a type parameter
to its constraint, via `ctx.oracle`, not the raw checker. Never worse than
base.

**Test:** `tests/equivalence/issue-7237-*.test.ts` on 3 lanes.
