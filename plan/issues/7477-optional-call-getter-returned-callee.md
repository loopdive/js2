---
id: 7477
title: "Optional call on a getter-returned callee (`o?.g?.()` with `get g()`) is wrong (legacy)"
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

- **Legacy:** the result does not match node when the callee comes from an
  accessor rather than a field or method.

## Acceptance criteria

- A pin test on gc, standalone and wasi, checked against node, covers:
  - the getter running exactly once;
  - `this === o` inside the returned function;
  - a getter returning `undefined`, which short-circuits to `undefined`.

  The test fails on main.
- The fix reads the callee through the existing accessor read and then reuses
  `compileOptionalPropertyValueCall`. It adds no new call path.
