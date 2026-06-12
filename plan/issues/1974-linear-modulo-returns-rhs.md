---
id: 1974
title: "linear backend: % silently evaluates to the right-hand operand (empty PercentToken case leaves operands on the stack)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: arithmetic
goal: core-semantics
related: [2056, 1858]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main, target linear"
---

# #1974 — linear `%` emits nothing

## Problem

Every remainder expression in `target: "linear"` returns the divisor: `7 % 2`
→ `2`, `-7 % 2` → `2`, `5.5 % 2` → `2`. GC backend correct.

## Root cause

`src/codegen-linear/index.ts:2003-2017` — the `PercentToken` case in the f64
binary-op switch is an empty `break` with a comment trail ("Let's handle %
specially before the main compile") and no special handling exists anywhere.
Both operands are already pushed (~1988); the case emits nothing, leaving
`[lhs, rhs]` on the stack; in return position the top value (RHS) is consumed
and the module still validates.

## Fix direction

Spill operands to locals and emit a correct f64 remainder — mirror the GC
backend's remainder helper (and inherit #2056's fmod-correctness work rather
than duplicating the naive `a - trunc(a/b)*b` formula).

## Acceptance criteria

- `7 % 2`, `-7 % 2`, `5.5 % 2` match Node in linear mode
- Stack discipline: no leftover values (validate in non-return positions too)

## Dupe check

No issue mentions linear modulo/Percent; #1858's only linear entry is the meta
"zero differential coverage". Unfiled.

## Resolution (2026-06-12)

**Already fixed on main** — the empty `PercentToken` arm was filled (the #1937
work referenced in `src/codegen-linear/index.ts:2189`). It now spills both
operands to f64 locals and emits `a - trunc(a/b)*b` (sign of the dividend,
matching JS `%` for finite operands; documented divergence: `b = ±Infinity`
yields NaN). Verified on `target: "linear"`:

- `7 % 2 === 1`, `-7 % 2 === -1`, `7 % -2 === 1`, `5.5 % 2 === 1.5`, `10 % 3 === 1`
- Stack discipline holds in non-return positions: `(7 % 3) + (8 % 5)` and a
  loop-body `i % 3 === 0` both validate and compute correctly.

Added `tests/issue-1974.test.ts` (9 cases) as a regression guard.
