---
id: 2088
title: "per-builtin representation scaffold (element accessor + coercion), starting with fromCharCode + join"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: core-semantics
related: [2122, 1968, 1998, 2074, 2075]
origin: "2026-06-11 analysis program (report 05 §2c); stub 08-A3"
---

# #2088 — every builtin re-derives element-load + ToString + null handling per representation

## Problem

Each builtin re-implements element access and coercion for each
representation (host vec / native string / standalone any). join alone
bred 4 issues (#1968, #1998, #2074, #2075); fromCharCode bred #2122 (ex-#1955) with
the single-arg bug copied independently into each of its 4 paths.

## Root cause

No shared scaffold parameterized by representation; builtin registration
is scattered across 3 scanner sites (declarations.ts:545/1164,
index.ts:1035/7258); registry/imports.ts is underused.

## Fix direction

A `defineBuiltin(name, {elementKinds, lower})` scaffold supplying the
element-load/ToString/null-handling matrix once; migrate join +
fromCharCode first (highest bred-bug density), then repeatable per
builtin. Full analysis: plan/log/analysis-2026-06/05-structure-review.md
§2c.

## Acceptance criteria

- join + fromCharCode served by one definition each across host/native/
  standalone; their 5 historical issue test suites green
- Adding a deliberate bug to the shared lowering fails all lanes

## Dupe check

The 5 symptom issues are filed/done; no issue owns the scaffold. New
(analysis program).
