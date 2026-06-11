---
id: 2023
title: "new.target compiles to constant i32 1 — identity comparisons (new.target === A) always wrong"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [189, 1366]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2023 — new.target is a truthiness stub

## Problem

```ts
class A { tag: string; constructor() { this.tag = new.target === A ? "direct" : "sub"; } }
class B extends A {}
new A().tag + "|" + new B().tag
// wasm: "sub|sub"   node: "direct|sub"
```

## Root cause

`src/codegen/expressions.ts:1209-1217` — inside any constructor
`new.target` lowers to `i32.const 1` (truthiness stub introduced by #189
to clear compile errors), so identity comparisons and propagation through
super chains are wrong. class-bodies.ts:2008 notes newTarget-threading
"deferred to #1366b/c".

## Fix direction

Thread a constructor-identity parameter through ctor calls (set at the
`new` site, forwarded by super()) — a class-id i32 is enough for `===`
against statically known classes. Function-call (non-new) invocation
should yield undefined.

## Acceptance criteria

- Repro matches Node through super chains
- `new.target` truthiness uses unchanged

## Dupe check

#189 done (introduced the stub); #538 older. Wrong-value semantics not
filed; nearest live anchor #1366. New.
