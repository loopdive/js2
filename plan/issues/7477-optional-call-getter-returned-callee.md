---
id: 7477
title: "A callee returned by a getter: `o?.g?.()` never runs the getter, `o.g()` calls with the wrong `this` (legacy)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7430, 7469]
---

# #7477: optional call on a callee returned by a getter

## Problem

RV7425 found this while reviewing PR #7425
([#7430](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7430-optional-call-on-undefined-class-field-callee-traps)).
It is equally wrong on main without that PR.

```js
class C { get g() { return function () { return this === o; }; } }
var o = new C();
o?.g?.(); // node: true (getter runs once, the result is called with this === o)
```

- **Legacy, two defects (RV7437):**
  - `o?.g?.()` never runs the getter;
  - the plain call `o.g()` runs it, but calls the result with the wrong `this`.

  Both are wrong on main without that PR.

## Acceptance criteria

- A pin test on gc, standalone and wasi, checked against node, covers both
  `o?.g?.()` and `o.g()`:
  - the getter running exactly once;
  - `this === o` inside the returned function.

  The test fails on main.
- A getter returning `undefined` (which should short-circuit `o?.g?.()` to
  `undefined`) is a TypeScript compile error in a `.js` input, so pin it in a
  `.ts` input only.
- The fix lives in the shared accessor-callee path, so the plain `o.g()` and
  the optional `o?.g?.()` are fixed together: the callee is read through the
  existing accessor read and called with `this === o`. The optional form then
  reuses `compileOptionalPropertyValueCall`. No new call path is added.
