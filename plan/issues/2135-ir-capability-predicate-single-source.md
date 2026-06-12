---
id: 2135
title: "Single IR capability predicate shared by selector and builder (retire select.ts/from-ast.ts drift)"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1923, 1804, 1922]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N2)"
---

# #2135 — "what IR can do" is encoded twice; disagreement = silent demotion

## Problem

`select.ts` accepts shapes `from-ast.ts` throws on by design (e.g. array
literals: `select.ts:1704-1707` accepts, `from-ast.ts:1229` throws "not in
slice 12"). 174 `throw new Error` sites in from-ast.ts land in the warning
channel and are counted nowhere — the ratchet
(`scripts/ir-fallback-baseline.json`) only counts selector reasons, so a
post-claim regression bypasses CI entirely (#1923's finding, confirmed).

## Approach

Extract a `capability.ts` table (node kind × shape guard) consumed by both
`isPhase1Expr` (select.ts) and the from-ast dispatch; from-ast throws become
`unreachable` assertions where the table says claimable. Stage per
expression family. Architect spec first (Fable), staged impl follows.

## Acceptance criteria

- The array-literal intentional mismatch is gone (lands with #1804).
- Count of from-ast throw sites reachable post-claim drops measurably via
  #1923's meter.
- New IR features add one table row, not two predicates.

## Notes

Size L staged; spec is sprint-62, implementation can spill into 63 per
family. Depends on #1923 (metering) for the acceptance measurement.
