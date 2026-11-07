---
id: 7323
title: "A plain closure call installs `__current_this` and skips its restore when the callee throws"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: codegen
goal: core-semantics
related: [7287]
---

# #7323: a plain closure call loses the caller's `this` when the callee throws

## Problem

A call through a function-valued binding (`f()` with `f` a closure parameter)
installs its receiver into `__current_this` inline and restores it after the
call. The relevant code is the save/install/restore in
`src/codegen/closure-receiver-install.ts`, used by the closure-call arms of
`src/codegen/expressions/calls.ts`.

An exception unwinding through that call skips the restore. A caller that
catches it then reads the callee's receiver as its own `this`.

#7287's review (B1) fixed the same defect in `__call_fn_method_N` with
`restoreThisOnThrow` (closure-exports.ts). This path is separate, and it fails
with the IR off as well.

## Repro (`dc52abf7` and #7287's head, IR on or off)

```js
var out = "";
function call(f) { f(); }
var o = { v: 1, m: function () { try { call(function () { throw 1; }); } catch (e) {} out += this.v; } };
o.m();
if (out !== "1") throw new Error("out=" + out);
```

| lane | node | head (IR on) | IR off |
|---|---|---|---|
| gc | completes | throws (`this.v` reads the wrong receiver) | throws |
| standalone | completes | throws | throws |
| WASI | completes | throws (`unreachable`) | throws (`unreachable`) |

With `out += "x"` in place of `this.v` (no `this` read), all three lanes
complete. So the defect is the receiver, not the control flow.

## Notes

- The same inline sequence is in `object-literal-method-receiver.ts` and
  `fillDirectCallTrampolines` (typed-this.ts). Both document "an exceptional
  unwind skips the restore" as a known limitation.
- One shared helper should replace all of them: the try/catch_all-restore-rethrow
  wrapper that `restoreThisOnThrow` / `buildClosureInvocationBoundary` already
  are. Copy-pasting it into each site would be the wrong fix.
- Measure the cost: a `try` per call site on a hot path such as compiled acorn
  is not free. A call whose callee provably does not throw, or whose caller
  never reads `this` afterwards, may keep the inline form.
