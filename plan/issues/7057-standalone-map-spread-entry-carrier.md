---
id: 7057
title: "standalone: `[...map]` picks the result vec from the Map's KEY type argument instead of its `[key, value]` entries — every entry hits `ref.cast $AnyString` (\"illegal cast\") in stylelint `reference/keywords.mjs` module init"
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
language_feature: spread, collections
goal: standalone-gap
related: [7019, 7058]
# 2026-10-17 — the element-carrier choice for a spread-first literal lives in
# compileArrayLiteral itself; the fix is one more arm of that choice.
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
---

# Spreading a Map builds a key-typed vec

Split out of [#7019](./7019-standalone-module-init-traps-cjs-graphs.md).

## Problem

`compileArrayLiteral` chooses the element carrier of `[...x, …]` from
`getTypeArguments(typeof x)[0]`. That is the element for arrays, Sets and
iterators, but a Map iterates `[key, value]` ENTRIES. With string keys the
literal became a native-string vec and the standalone iterable materialiser
cast every entry to `$AnyString` → "illegal cast". stylelint's
`reference/keywords.mjs` does `new Map([...byProperty].map(([p, m]) => [p, new
Set(m.values())]))` at module init, so `isCounterIncrementCustomIdentValue`,
`isCounterResetCustomIdentValue` and `isKeyframeSelector` never ran.

## Implementation Plan

Host-free (`ctx.standalone || ctx.wasi`), a `Map` / `ReadonlyMap` spread source
selects the universal `externref` carrier — entries are dynamic arrays. The
gc lane keeps its bytes (its own representation is untouched here).

## Resolution

Implemented as planned. Test `tests/issue-7057-standalone-map-spread-entries.test.ts`
(module-init map rebuild, entry count, key, inner value; Set/array spread
controls). With [#7058](./7058-standalone-readonly-collection-method-dispatch.md)
the three stylelint files initialise and pass (stylelint standalone 100 → 103
of 108). gc binaries byte-identical.
