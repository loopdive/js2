---
id: 4292
title: "codegen: preserve native strings through optional index and method chains"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: optional-chaining, strings
goal: dogfood
related: [1244, 4291]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/expressions/calls-optional.ts
func-budget-allow:
  - src/codegen/expressions/calls-optional.ts::compileOptionalCallExpression
  - src/codegen/expressions/calls-optional.ts::isRepeatableDynamicOptionalReceiver
---

# codegen: preserve native strings through optional index and method chains

## Problem

After #4291 fixes Hono's inherited receiver layout, `basePath()` reaches the
imported `mergePath` closure and fails with `TypeError: Array method called on
null or undefined`. Its exact published shape combines `base?.[0]`,
`base?.at(-1)`, `sub?.[0]`, and `sub.slice(1)` on native strings. The emitted
closure routes at least one of those operations through a nullable Array-style
receiver instead of the known string representation.

Fix the generic optional index/method dispatch while preserving nullish
short-circuiting. Do not special-case Hono or `mergePath`.

## Acceptance criteria

- [x] A reduced copy of the published `mergePath` shape fails before the fix
      and returns `42` afterward for leading/trailing slash cases.
- [x] Hono's `basePath()` advances beyond `mergePath`.
- [x] Existing optional-chain, string indexing, `.at`, and `.slice` suites pass.

## Result

The non-null branch of an optional method call on an unannotated receiver now
uses the ordinary runtime method ladder for repeatable local receivers. Hono's
native string `.at()` call no longer becomes an
undefined default, and the reduced merge-path shapes return the Node result.
Property/getter receivers remain on the prior single-read fallback until #4296
can reuse the already-saved value without evaluating the getter twice. The
independent closure-rest and runtime router-dispatch defects exposed next are
tracked by #4294 and #4295.
