---
id: 7360
title: "`x ?? 7` with `x: number | undefined` returns NaN for `undefined` on the ordinary pipeline"
status: ready
sprint: current
created: 2026-11-17
updated: 2026-11-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7359, 7354]
---

# #7360 — `??` on a `number | undefined` f64 never sees `undefined`

## Problem

A wrong answer on the ordinary pipeline, default (gc) and `--target standalone` alike, found while checking the
siblings of #7359:

```ts
function f(x: number | undefined): number { return x ?? 7; }
export function main(): number { return f(undefined); } // node 7; we return NaN
```

Measured on `claude/7354-logical-unused` (`main` returning `f(undefined) + f(2) * 100`, node 207):

| shape | gc | standalone |
| --- | --- | --- |
| `return x ?? 7` | NaN | NaN |
| `return x ?? seven()` (a call on the right, with a counter) | NaN | NaN |
| `const y = x; return y ?? 7` (stored in a local first) | 207 (correct) | 207 (correct) |
| `function f(x?: number)` … `return x ?? 7` | 207 (correct) | 207 (correct) |

## Cause (as read, not yet traced to the line)

`f` compiles on the legacy (non-IR) path to `local.get 0; local.tee 1; return` — the `??` test is gone. The
parameter `number | undefined` is an `f64`, and `undefined` arrives as the f64 undefined sentinel (the NaN payload
`UNDEF_F64_BITS`; `main` passes the bits `0x7FF00000DEADC0DE`); the `??` lowering sees an `f64` operand, treats it as a number
that can never be nullish and folds to the left operand, so the sentinel leaks out as NaN. A local copy and the
optional-parameter form take a path that does test the sentinel.

## IR paths

Not affected: the ordinary pipeline's IR selector does not claim `f` (legacy compiles it), and the Prepared path
refuses all four shapes by name (`ir/from-ast: unsupported type in Phase 1 (f)`, or `rest/default/optional param
not in Phase 1 IR scope (f)` for `x?: number`).

## Acceptance criteria

- The four shapes answer like node on both targets; a parameter, a local and a property of type
  `number | undefined` under `??`, `??=` and `?.`-adjacent forms are swept.
- No change for a plain `number` operand of `??` (its bytes stay identical).
