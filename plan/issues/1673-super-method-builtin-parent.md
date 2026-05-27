---
id: 1673
title: "super.<method>() on a built-in parent class fails to compile"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: class
goal: spec-completeness
sprint: Backlog
parent: 1675
---
# #1673 — super.<method>() on a built-in parent class fails to compile

Split from #1675 (built-ins/Set investigation).

## Problem

A class that extends a built-in (`Set`, `Map`, `Array`, …) and calls a
`super`-inherited method fails at **compile time**:

```js
class MySet extends Set {
  size(...rest) { return super.size(...rest); }   // CE
  has(...rest)  { return super.has(...rest); }     // CE
  keys(...rest) { return super.keys(...rest); }    // CE
}
```

Error: `Cannot find method 'size' on parent class 'Set'`.

## Affected tests (7 compile_errors in built-ins/Set)

`prototype/{union,intersection,difference,symmetricDifference,isSubsetOf,
isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js`

(All assert that `Set.prototype.union` & friends never call the *receiver's*
overridden `size`/`has`/`keys` — but they fail before that, at compile.)

## Root cause

`compileSuperMethodCall` in `src/codegen/expressions/new-super.ts:108-120`
resolves `super.<m>` by walking `ctx.funcMap` for `${ancestor}_${m}`, climbing
`ctx.classParentMap`. When the ancestor is a **built-in class**, there is no
`Set_size` (etc.) funcMap entry — built-ins are host-backed, not user-compiled —
so the loop exhausts and hits the hard `reportError` at new-super.ts:118
(mirror at :208 for the `super['m']()` computed form).

## Direction

When the resolved `parentClassName` is a known built-in and no user funcMap
entry exists, dispatch `super.<method>(args)` to the built-in's prototype method
via the existing host-method machinery (the same path that compiles
`obj.method()` for built-in receivers), with `this` as the receiver — instead of
erroring. Both `compileSuperMethodCall` (:118) and
`compileSuperElementMethodCall` (:208) need the fallback.

## Acceptance

- The 7 `subclass-receiver-methods.js` tests compile (then pass or fail on
  their actual assertions, not CE).
- No regression in user-class `super.method()` dispatch.

## Resolution (2026-05-27, dev-1607) — ALREADY FIXED on main

Verified against `origin/main` (HEAD aeb6cde16). The compile error described
here no longer occurs: the `super.<method>()` builtin-parent fallback already
exists as `emitSuperExternMethodCall` (`src/codegen/expressions/new-super.ts:64`),
wired into both `compileSuperMethodCall` (:199-207) and
`compileSuperElementMethodCall` (:294-300). When the resolved parent walks to a
registered extern class and no user `funcMap` entry exists, it dispatches
`super.method(args)` via `__extern_method_call(this, name, argsArray)` instead
of erroring. This landed with the #1614 work.

Verification:
- Standalone compile probes (`super.has(...rest)`, `super.size`,
  `super.keys(...rest)` on `class extends Set`) all compile — no CE.
- The real test262 runner (`runTest262File`) on all 7 named files
  (`built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
  isSubsetOf,isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js`)
  reports **PASS** for all 7 — they not only compile but also pass their actual
  assertions (`Set.prototype.union` & friends never call the receiver's
  overridden `size`/`has`/`keys`).

No source change needed. Closing as done (stale — fixed by #1614 dispatch path).
