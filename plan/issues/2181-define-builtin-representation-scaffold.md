---
id: 2181
title: "defineBuiltin(name, {elementKinds, lower}) scaffold — unify per-representation element-load/ToString/null handling"
status: ready
sprint: 63
created: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: core-semantics
related: [2088, 2074, 2122, 1968, 1998, 2075]
origin: "Sprint-62 follow-up: #2088 deferred off the dev line (multi-file scaffold of fragile builtin-registration code); route to senior-dev for s63"
---

# #2181 — per-builtin representation scaffold (carried over from #2088)

## Why this is its own (s63, senior-dev) issue

#2088 proposed a `defineBuiltin(name, {elementKinds, lower})` scaffold that
supplies the element-load / ToString / null-handling matrix ONCE, so each
builtin stops re-deriving it per representation (host vec / native string /
standalone any). During sprint 62 it was assessed as **over the dev line**:
`reasoning_effort: high`, a multi-file refactor of fragile builtin-registration
code scattered across three scanner sites
(`declarations.ts:545/1164`, `index.ts:1035/7258`) plus `registry/imports.ts`.
The seniors were CPU-bound on async/Proxy and the box was at its load cap, so a
big risky refactor wasn't worth a slot mid-sprint. #2088 was released; this
carries the scaffold forward as a planned sprint-63 item.

## Problem (from #2088)

Each builtin re-implements element access and coercion for each representation.
`join` alone bred 4 issues (#1968, #1998, #2074, #2075); `fromCharCode` bred
#2122 with the single-arg bug copied independently into each of its 4 paths.
No shared scaffold is parameterized by representation.

## Fix direction

A `defineBuiltin(name, {elementKinds, lower})` scaffold supplying the
element-load/ToString/null-handling matrix once; migrate `join` +
`fromCharCode` first (highest bred-bug density), then repeatable per builtin.
Full analysis: `plan/log/analysis-2026-06/05-structure-review.md` §2c.

## Acceptance criteria (from #2088)

- `join` + `fromCharCode` served by one definition each across
  host/native/standalone; their historical issue test suites
  (#1968/#1998/#2074/#2075 join, #2122 fromCharCode) stay green.
- Adding a deliberate bug to the shared lowering fails ALL lanes (the
  cross-lane guard #2088 acceptance-(2) asked for).

## Note on acceptance-(2) coverage

The "deliberate bug fails all lanes" guard is already PARTIALLY covered by the
existing multi-lane suites: #2074 (join, 3 lanes) + #2122 (fromCharCode, 4
backends). The scaffold should preserve/extend those rather than replace them.

## Routing

Senior-dev — touches core builtin-registration code with broad blast radius.
Spec the migration of `join` + `fromCharCode` first as a bounded first slice
before generalizing.
