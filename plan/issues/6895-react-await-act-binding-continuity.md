---
id: 6895
title: "react upstream: bindings lost across `await act()` — boxed captures, callback-written lets, scoped class locals"
status: done
created: 2026-10-07
updated: 2026-10-07
completed: 2026-10-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, async
language_feature: async, closures, classes
goal: dogfood
related: [4618, 3958, 5195]
# 2026-10-07 (#6895). Growth measured against upstream/main e7760d1c2a.
# The decision logic lives OUT of the god-files in two new modules
# (src/codegen/async-frame-binding-continuity.ts,
# src/codegen/identifier-receiver-slot.ts); what stays in-file is wiring:
# async-frame.ts +10 (the live-cell spill branch in buildAsyncFrameInfo, its
# merge into the entry-init map, the prologue call and the import) and
# index.ts +2 (the one-line arm in varBindingNeedsExternrefForUndefined and
# its import). ensureAsyncResumeFunction grows by the single
# `emitScopedClassLocalRebinds` call.
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
---

# react upstream: bindings lost across `await act()`

## Problem

React's upstream unit suite (`tests/dogfood/react-upstream-suite.mjs`) measured
**139/180** on upstream/main e7760d1c2a (92 harness-incompatible, 0
quarantined). Almost every React test is lifted into
`async function t() { try { <prelude>; <body> } catch … }` and does
`await act(() => root.render(…))`. Four independent defects lost a binding's
value across that shape; each was reduced to an untyped two-function `.js`
fixture (no React):

1. **Boxed capture spilled as null.** A function declaration hoisted inside
   the harness's `try { … }` block captures `let React`. The function-body
   hoist cell-boxes `React` *before* async activation, so
   `buildAsyncFrameInfo` saw the live local's type as the cell type, did not
   force-box it again, and the entry `struct.new` initialized that frame field
   with `ref.null`. Every later write (`React = require('react')`) was dropped
   by the resume's null-cell guard, and the hoisted component threw
   `Cannot read properties of null (reading 'createElement')`.
2. **Member read of a cell-boxed receiver folded to null.** `let out;` written
   only in a callback has the flow type `undefined`. Restored in the resume as
   its ref cell, `out.val` missed the "externref slot" admission in
   `finalizeStructAndDynamicMemberGet` (it only inspected the local's own
   type, which is the cell ref) and fell to the terminal constant
   `ref.null.extern`.
3. **Captured-global receiver and its copy.** `let instance; class C {
   componentDidMount() { instance = this } }` promotes `instance` to a
   *captured* global; the #5195 global admission only consulted
   `moduleGlobals`, so `instance.props` was a constant null. A copy
   `const inst = instance` (both flow-typed `undefined`) took the numeric
   undefined slot and truncated the live object.
4. **Scoped class local lost across a suspension.** A second `class
   Component` (React's tests reuse the name in every test) is compiled under a
   synthetic identity and bound to a same-named LOCAL. The spill analysis
   tracks only params and var/let/const/catch bindings, so after an `await`
   that local was a fresh null — `createElement(Component)` handed ReactDOM a
   null type (React error #130) and the update never rendered.

## Implementation Plan

- (1) `buildAsyncFrameInfo` (async-frame.ts): when the activating function has
  already cell-boxed a nested-captured spill, type the field as
  `ref_null <cell>` and initialize it from the LIVE cell local at frame
  construction (through the existing `derivedSpillInit` entry-init map); skip
  the force-box pass for it. Helper `liveBoxedCaptureSpillType`.
- (2)/(3) Move the identifier-receiver slot predicates out of
  `finalizeStructAndDynamicMemberGet` into `identifier-receiver-slot.ts`:
  a boxed binding answers by its cell's value type; the purely-undefined
  global arm consults `capturedGlobals` before `moduleGlobals` (the identifier
  read's own order). `varBindingNeedsExternrefForUndefined` gains one arm:
  a purely-undefined binding initialized from a mutable `let`/`var`
  identifier takes the externref slot (`copiesUnseenWriteBinding`).
- (4) `ensureAsyncResumeFunction`: before the dispatch, re-read every scoped
  class declaration's singleton class-object global into its local
  (`emitScopedClassLocalRebinds`). Before the declaration runs the global is
  null — the value the fresh local held — so no state observes a different
  value.
- Regression test `tests/issue-4618-async-boxed-capture-frame.test.ts`: four
  cases, each with a control that already passed on the parent.

## Resolution

React upstream suite **139/180 → 150/180** (same 272 executed, 92
harness-incompatible, 0 quarantined); 11 fail→pass, 0 pass→fail. The
remaining 30 failures are listed in #4618's 2026-10-07 section with their
clusters.
