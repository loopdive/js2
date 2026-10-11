---
id: 6859
title: "async: an identifier parameter assigned before an `await` reads its ARGUMENT after it — the param frame field is an immutable activation snapshot"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
# (#6859, 2026-10-05) The fix is one block in `collectDerivedPatternParams`
# (the one place the async frame decides which bindings ride as live spills);
# moving it out would mean exporting the file-private
# `collectNestedRefsAndAssigns` just to call it from a sibling.
loc-budget-allow:
  - src/codegen/async-frame.ts
---

## Problem

`buildAsyncFrameInfo` (`src/codegen/async-frame.ts`) stores every parameter in
an IMMUTABLE `param_<name>` frame field, filled once at activation; the resume
function reloads the local from it on every re-entry. Async frames have no
`paramWriteBack` (the generator frame does). So an assignment to a parameter
before a suspension is lost after it. Measured on upstream/main `c3e3fab33d`
(untyped `.js`, host lane):

| function | Wasm | node |
| --- | --- | --- |
| `async (x) => { x = 2; await null; return x }` called with `1` | `1` | `2` |
| `async (x) => { x \|\|= 3; await null; return x }` | `undefined` | `3` |
| hono `createPool().run`: `promise \|\|= new Promise((r) => (resolve = r)); await fn(); if (resolve) …` | `resolve` still `undefined` | the executor's `r` |

The third row is the same snapshot plus a nested-closure write: the closure's
`resolve = r` never reaches the frame at all.

## Implementation Plan

Pattern-DERIVED parameter bindings already ride the frame as live-initialized
spill fields (#2967 slice 2b-2): stored at every suspend, restored at every
resume, and — when a nested function references them — force-boxed into a
shared ref cell whose identity survives the suspension (#2967 phase 3a).
Route assigned identifier parameters through the same contract:
`collectDerivedPatternParams` also returns every identifier parameter that
`collectNestedRefsAndAssigns(decl.body).assigned` contains (any assignment,
outer body or nested function), unless the activating context already boxed it.
The resume prologue still loads the param field first; the spill local then
shadows it by name, so every read, write, store and restore goes through the
spill (or its cell). Async generators are excluded (their own discipline).

Acceptance: the three rows match node; regression test failing on the parent
with a read-only-parameter anti-vacuity row; standalone test262 async scope flat.

## Resolution

Implemented as planned (`collectDerivedPatternParams` in
`src/codegen/async-frame.ts`). All three rows match node; regression test
`tests/issue-6859-async-assigned-param-across-await.test.ts` (parent:
`1,undefined,-1,8`). No hono movement on its own: `concurrent.test.ts` needs
[#6860](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6860-inline-async-arrow-destructured-param-sync-passthrough)
as well. Standalone test262 async scope identical; full A/B in
[#6846](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6846-async-nested-leading-await-replay).
