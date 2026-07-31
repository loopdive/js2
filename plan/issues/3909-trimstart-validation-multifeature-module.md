---
id: 3909
title: "__str_trimStart fails Wasm validation when JSON.stringify + regex + case conversion appear in one module"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: string-methods
goal: performance
sprint: Backlog
horizon: m
es_edition: multi
related: [3900, 3910]
---

# #3909 — `__str_trimStart` mis-validates in a multi-feature module

## Status: open — pre-existing, surfaced during #3900

## Problem

A module that combines `JSON.stringify`, a regex, and a case-conversion call
fails Wasm validation in `__str_trimStart`. Each feature works in isolation;
the failure needs all three present, which points at a cross-feature
interaction — an import-index shift, a helper emitted under one gating
condition and consumed under another, or a shared-local collision between
runtime helpers.

That shape is worth taking seriously because we have now seen it twice in one
day: #3902 found that `import-collector.ts` gates `string_compare` on
`ctx.nativeStrings` but `number_toString` on `ctx.wasi || ctx.standalone`, so
fast mode got a native helper alongside a JS-host one and cast across them.
This may be the same family.

## Scope

1. Build the minimal repro (all three features, then bisect which pair is
   sufficient) and record the exact validation error.
2. Check the helper gating conditions in
   `src/codegen/declarations/import-collector.ts` for the same class of
   mismatch #3902 found.
3. Check `addUnionImports` index-shifting — per `CLAUDE.md`, late import
   addition shifts function indices and must also shift `ctx.currentFunc.body`.
   A module with more imported helpers is exactly when that goes wrong.

## Acceptance criteria

1. Minimal repro committed as a regression test.
2. Root cause identified and fixed, with the mechanism written down (not just
   the symptom).
3. If it is the same gating-mismatch family as #3902, say so and check whether
   a systematic audit of the gating conditions is warranted.

## Notes

Found by `issue-3900-case-convert` while probing case conversion. It verified
the failure **reproduces identically on the parent commit**, so it is
pre-existing and not caused by that work. Reported rather than fixed, correctly
— it was out of that issue's scope.
