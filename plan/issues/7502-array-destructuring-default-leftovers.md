---
id: 7502
title: "Array destructuring defaults: wrong answers left after #7473"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
sprint: Backlog
related: [7473]
---

# #7502 — Array destructuring defaults: wrong answers left after #7473

## Problem

Eight wrong answers on the ordinary pipeline (legacy codegen), on the default target and `--target standalone` alike.
They were found while fixing [#7473](7473-ordinary-array-destructuring-default-nan.md) (PR #7453), which fixes the
plain `[n = 5] = []` form; none of them is fixed by that PR.

## Reproduction (2026-11-26, `origin/main` `1a726b3e64`)

Each body is `export function g() { <body> }` in a `.js` file, compiled through `compile()` with `allowJs`. "#7453"
is the PR head `4e889f329e` (rows 6–8 were measured at `679569ee24`, which builds the same bytes as `4e889f329e`). The rows are grouped by sub-cause.

| # | Sub-cause | Declarations | Body | node | main (both targets) | #7453 (both targets) |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | i32 slot has no "undefined" marker | | `var b; [b = true] = []; return b;` | true | 0 | 0 |
| 1 | i32 slot has no "undefined" marker | | `var b; [b = true] = [undefined]; return b;` | true | 0 | 0 |
| 2 | zero-field tuple read as "not a tuple" | | `var n; [[n = 5] = []] = [[]]; return n;` | 5 | NaN | NaN |
| 2 | zero-field tuple read as "not a tuple" | | `var n; [[n = 5] = []] = [[8]]; return n;` | 8 | NaN | NaN |
| 3 | object shorthand default only for externref fields | | `var n; [{ n = 5 } = { n: 3 }] = [{}]; return n;` | 5 | NaN | NaN |
| 4 | declaration form of a nested default | | `var [[n = 5] = []] = []; return n;` | 5 | 0 | 0 |
| 5 | member target evaluated after the default | `var log = 0; var o = {}; function obj() { log = log * 10 + 1; return o; } function d() { log = log * 10 + 2; return 5; }` | `[obj().x = d()] = []; return log;` | 12 | 1 | 21 |
| 6 | `undefined` read from a variable | | `var u; var a; [a = 1] = [u]; return a;` | 1 | NaN | NaN |
| 7 | nesting deeper than two levels | | `var n; [[[n = 5] = []] = []] = []; return n;` | 5 | NaN | NaN |
| 8 | object pattern: default of a member target skipped | `var log = 0; var o = {}; function k() { log = log * 10 + 1; return 'x'; } function d() { log = log * 10 + 2; return 5; }` | `({ a: o[k()] = d() } = {}); return log;` | 12 | 1 | 1 |
| 8 | object pattern: default of a member target skipped | `var o = {}; function k() { return 'x'; } function d() { return 5; }` | `({ a: o[k()] = d() } = {}); return o.x === undefined ? -1 : o.x;` | 5 | -1 | -1 |

Notes per sub-cause, from the #7473 investigation:

1. A boolean element lives in an i32 slot, which has no encoding for "absent", so the default never runs.
2. `emitArrayDestructureFromLocal` (`src/codegen/expressions/assignment.ts`) treats a zero-field struct as "not a
   tuple" and skips out-of-range positions instead of running their defaults. In `[[8]]` the source literal is also
   built as an empty tuple, which drops the `8`.
3. `emitObjectDestructureFromLocal` runs a shorthand default only for externref fields. The same path serves
   object-only patterns, so a fix there changes their output too.
4. The declaration path has the nested-default gap that #7473 closes for the assignment path.
5. On main the member-target default never runs (#7473), so the order bug is hidden: `obj()` runs and `d()` does not,
   giving 1. With #7453 the default runs, but before the target reference: the log reads 21 where node reads 12.
   ECMAScript evaluates an `AssignmentElement`'s target reference before its initializer.
6. Added from the RV7453 review. The literal `[undefined]` answers right with #7453, but an `undefined` read from a
   variable does not. Not yet traced; the likely cause is that the element reaches the f64 slot as a plain NaN
   rather than the `UNDEF_F64_BITS` marker.
7. Added from the RV7453 review. #7453 handles a default one nesting level down; a third level still reads NaN.
   Not yet traced.
8. Added from the RV7453 review. The object-pattern twin of row 5's member target: the key `k()` is evaluated, but
   the default `d()` never runs, so `o.x` is never written. #7453 does not touch the object path.

## Acceptance criteria

- Every row answers like node on both targets.
- Pin tests that fail on main.
- JS-environment output byte-identical except for programs with these shapes.
