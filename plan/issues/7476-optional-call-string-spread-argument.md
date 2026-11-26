---
id: 7476
title: "A call with a string spread argument (`o.f(...s)`, `o?.f?.(...s)`) gives the wrong arguments (legacy)"
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

# #7476: a call with a string spread argument

## Problem

RV7425 found this while reviewing PR #7425
([#7430](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7430-optional-call-on-undefined-class-field-callee-traps)).
It gives the same wrong answer on main without that PR.

```js
class C { f = (a, b) => a + b; }
var o = new C(); var s = "xy";
o?.f?.(...s); // node: "xy"
```

- **Legacy:** the result does not match node, and the plain call `o.f(...s)` is wrong
  too (RV7437), so the defect is not specific to optional calls. A string spread must pass one
  argument per code point. That PR makes `compileOptionalPropertyValueCall`
  use the shared `tryEmitSpreadHostArgs` → `buildSpreadArgList` expander, so
  the defect is in how that expander treats a string iterable, not in the
  optional call itself.

## Acceptance criteria

- A pin test checks `o?.f?.(...s)`, `o.f?.(...s)` and a plain `o.f(...s)` with
  a string `s` (including a non-BMP code point) on gc, standalone and wasi
  against node, and fails on main.
- The fix lives in the shared spread expander, so plain and optional calls are
  fixed together. No optional-call-specific branch is added.
