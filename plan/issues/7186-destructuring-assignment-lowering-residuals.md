---
id: 7186
title: "Destructuring-assignment lowering residuals: pattern defaults, TS wrapper targets, tuple rest"
status: ready
sprint: current
created: 2026-10-28
updated: 2026-10-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
parent: 4495
related: [4495]
---

# #7186 — Destructuring-assignment lowering residuals

Residuals C, D and E of [#4495](4495-string-slot-widening-dynamic-assignment.md).
In each case #4495 widens the target slot correctly, and the assignment
lowering then loses or mistypes the value.

## Problem

All rows were measured on PR #6954, on both lanes, at module scope and in a
function, with node as the oracle.

| Shape | Program | node | head |
| --- | --- | --- | --- |
| C: default lowered against the pattern type | `var r='r'; [r = 5] = []; ''+r` | `5` | wrong, 4/4 |
| D: TS non-null target | `let r: string = 'r'; r! = id(1); ''+r` (`.ts`) | `1` | wrong, 4/4 |
| D: TS `as` target | `let r: string = 'r'; [r as any] = [id(1)]; ''+r` (`.ts`) | `1` | wrong, 4/4 |
| E: rest from a tuple source | `var s='s', q='q'; [[s], ...q] = [[1], 2]; q[0]` | `2` | wrong, 4/4 |
| E: rest element type from the pattern | `var a='a', r=[]; [a, ...r] = [1, 'x', true]; r[0]` | `x` | `NaN`, 4/4 |
| E: numeric slot, short source | `var a=1, b=2; [a, b] = [3]; ''+b` | `undefined` | `NaN`, 4/4 |
| hole marker ToString | `var x=[1,,]; var b=x[1]; ''+b` | `undefined` | wrong at module scope |

- **C.** The default expression is compiled against the pattern's element
  type, not the target's slot.
- **D.** The `!` and `as` wrappers are not unwrapped when the write target is resolved.
- **E, tuple rest.** `compileArrayDestructuringAssignment` skips a rest from
  a tuple source ("Rest on tuples is not supported").
- **E, rest element type.** `destructuring-source-literal.ts` deliberately
  keeps the pattern's context for a level the context lowers as a vec
  (`contextLowersAsVec`). So the rest's element type is still the pattern's.
- **E, short source.** `b` keeps its f64 slot, so `undefined` becomes `NaN`.
- **Hole marker.** `typeof b` is right; only ToString of the f64 hole marker
  is wrong. `[a, b] = [1, ,]` shows the same symptom.

## Implementation Plan (sketch)

- **Where.** `src/codegen/expressions/assignment.ts`
  (`compileArrayDestructuringAssignment` and its default arm), the target
  resolver, and `destructuring-source-literal.ts`.
- **Steps.**
  - C: compile the default against the target's resolved slot type.
  - D: strip TS wrappers in the shared target resolver. One generic helper
    (#7187) serves this and the write enumerator.
  - E, tuple rest: build the rest vec from the remaining tuple fields.
  - E, rest element type: lower the rest-collecting level's elements against
    their own types once the rest lowering accepts any vec.
  - E, short source: widen a numeric slot that a short source can leave `undefined`.
  - Hole marker: route ToString of an f64 through the hole-marker check.
- **Reuse.** Use the existing undefined/hole helpers (`emitUndefined`,
  `emitF64HoleToUndef`); add no new wrapper unwrapper.
- **Acceptance.**
  - Each row is right on 4/4 cells.
  - `tests/issue-4495.test.ts` gains the rows.
  - **Quality:** no lowering arm is duplicated per wrapper kind.
