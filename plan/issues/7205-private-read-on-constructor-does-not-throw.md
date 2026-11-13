---
id: 7205
title: "`C.#x` with the class constructor as receiver returns a value instead of throwing TypeError"
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
language_feature: classes
goal: correctness
related: [7160, 7204]
---

# #7205 — private field read on the constructor singleton must throw

Left out of #7160, and noted by the PR #7003 review (finding 5):

```js
class C { #x = 1; static read(v) { return v.#x; } }
try { console.log(C.read(C)); } catch (e) { console.log(e.name); }
// node: TypeError   — we print a value
```

The private read shares `emitPrivateBrandPredicate` with `#x in`. #7160 added
`emitOwnPrivateBrandPredicate`, which excludes the constructor and prototype
singletons, but only for `in`. Reads, writes and private method calls still
accept the singleton.

## Plan

1. Route private read, write and call brand checks through the same
   own-brand predicate, or its #7202 constant-cost successor, so that the
   singletons throw TypeError.
2. Tests on all 3 lanes against node, for reads, writes and private method
   calls with C, C.prototype and a subclass constructor as the receiver.
