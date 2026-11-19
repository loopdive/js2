---
id: 7396
title: "Legacy: calling a function-local var that holds a number returns null instead of throwing TypeError"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7334, 7391]
---

# #7396: `var g; g = 3; g()` inside a function does not throw

## Problem

This is a silent wrong answer: the call should throw a TypeError, but it
returns a value. Checked through the test262 runner (`runTest262File`) on
main `89e47482`:

```js
function f(){ var g; g = 3; try { g(); return "no throw"; } catch (e) { return e instanceof TypeError; } }
assert.sameValue(f(), true);
```

- **standalone and gc:** `f()` returns `"no throw"`. The call `g()` returns a
  value (`r === null` on both lanes) instead of throwing.
- **node:** `true`.
- **It compiles and validates on gc, standalone and wasi**, with or without
  the IR. With the IR on, `f` is legacy (`body-shape-rejected`), so this is
  the legacy route.
- **The module-scope form is correct.** `var g; g = 3; (function(){ g(); })()`
  throws TypeError on both lanes (`assert.throws` passes).

**Reported cause** (not verified line by line):
`tryEmitNullishIdentifierCalleeTypeError`
(`src/codegen/expressions/stored-member-closure-call.ts`) checks whether the
callee is nullish. A non-nullish callee goes through `__apply_closure`, and
`__apply_closure` gives back the undefined sentinel for a value it cannot
call, instead of throwing. The arm's own comment says it covers standalone
and wasi only, yet gc fails the same way. Check which route gc takes.

## Direction

- **Option 1: throw in that arm.** After `__apply_closure` classifies the
  callee as not callable, throw `TypeError: g is not a function`, as the
  nullish half of the arm already does. Do not return the sentinel.
- **Option 2: follow the module-scope route.** Find why the module-scope
  call throws, and send the function-local call through the same check.
- **Test:** pin the repro on gc, standalone and wasi. Also pin that a local
  holding a real closure is still called (the #5148 case the dispatch exists
  for).
