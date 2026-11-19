---
id: 7418
title: "RegExp pattern compiler: nested quantifiers multiply past the per-quantifier cap and exhaust the heap; needs a whole-pattern expansion budget"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
goal: ir-full-coverage
depends_on: [7409]
related: [7409, 7369, 1539]
---

# #7418 — whole-pattern expansion budget for the RegExp compiler

## Problem

`compileRepeat` (`src/codegen/regex/compile.ts`) caps each quantifier at `MAX_REPEAT_EXPANSION` (1,000 copies; #7409
made the cap cover `{n,}`). The cap is per quantifier, but the copies multiply when quantifiers nest:
`((x{1000}){1000}){1000}` expands 10^9 copies, each under the cap, and exhausts the compiler heap on main and on #7409
(found by the #7409 review). The runtime pattern compiler (`src/codegen/regex-runtime/`, `MAX_REPEAT` in `env.ts`) has
the same per-quantifier rule.

## Plan

- One budget for the whole pattern: the emitter counts emitted instructions (or expanded nodes) and throws the
  existing `RepeatTooLargeError` once the total passes a bound, so the refusal stays the named "exceeds expansion cap"
  unsupported-pattern error. No second error class, no second cap constant beside `MAX_REPEAT_EXPANSION` unless the
  two bounds are named for what they bound.
- The runtime compiler gets the same budget in the same place it checks `MAX_REPEAT`.

## Acceptance

- `/((x{1000}){1000}){1000}/` refuses by name at compile time, in bounded memory, on default, standalone and wasi.
- A pattern under the budget still compiles and matches as node does (pins on both sides of the bound).
- Byte identity on the RegExp corpus (`scripts/byte-diff-corpus.mts`, regexp selection from #7337), each file compiled
  in a fresh process or in identical order on both trees (same-process compile order changes bytes, #7410).
