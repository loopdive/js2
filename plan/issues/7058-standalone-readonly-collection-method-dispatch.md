---
id: 7058
title: "standalone: methods on a `ReadonlyMap` / `ReadonlySet`-typed receiver skip the native `$Map`/`$Set` dispatch — `m.values()` throws \"called value is not a function\" (stylelint `reference/keywords.mjs`, JSDoc `@type {ReadonlyMap<…>}`)"
status: done
sprint: current
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: collections
goal: standalone-gap
related: [7019, 7057]
# 2026-10-17 — the extern-dispatch gate is a condition of
# compileReceiverMethodCall; widening it is one disjunct.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# `ReadonlyMap` / `ReadonlySet` receivers miss the native collection dispatch

Split out of [#7019](./7019-standalone-module-init-traps-cjs-graphs.md).

## Problem

stylelint annotates every `new Map(…)` / `new Set(…)` in
`reference/keywords.mjs` with JSDoc `@type {ReadonlyMap<…>}` /
`@type {ReadonlySet<…>}`. The value is the same native `$Map`/`$Set`, but
`ReadonlyMap` is an interface, not an extern class, so
`compileReceiverMethodCall` never reached `compileExternMethodCall`'s native
`Map`/`Set` dispatch. `m.values()` fell to the generic `__call_m_values_0`
ladder, which has no arm for a `$Map` method → "called value is not a
function" during module init (`size` and `has` happened to work through other
paths).

## Implementation Plan

Under `ctx.nativeStrings`: route a `ReadonlyMap`/`ReadonlySet` receiver into
`compileExternMethodCall`, which maps the view name to `Map`/`Set` before its
native dispatch. The gc lane (no `nativeStrings`) keeps its bytes.

## Resolution

Implemented as planned. Test `tests/issue-7058-standalone-readonly-collection-methods.test.ts`
(`values`/`keys` on both views, module-init `new Set(m.values())`; `size`,
`has`, `Map`-typed controls). gc binaries byte-identical.
