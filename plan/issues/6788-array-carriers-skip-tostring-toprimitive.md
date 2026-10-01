---
id: 6788
title: "codegen: array carriers skip ToPrimitive/ToString — `String(numArr)` returns the array, `[] + []` is `NaN`, `+[]` is `NaN`, `Number([5])` is `NaN`"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: to-primitive
goal: core-semantics
related: [1319, 1090, 1253, 4564, 1215]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H4/H6"
---

# #6788 — the array carrier is not a primitive, but several sites treat it as one

## Problem

Reproduced 2026-09-30 (JS-host lane, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const arr: number[] = [0,9,0]; const s = String(arr); s === "0,9,0"` | `false`; `JSON.stringify(s)` → `[0,9,0]` (the array itself) | `true` |
| `` `${arr}` `` | the array | `"0,9,0"` |
| `[] + []` | `NaN` | `""` |
| `[] + {}` | `NaN` | `"[object Object]"` |
| `+[]` / `+[1]` | `NaN` / `NaN` | `0` / `1` |
| `Number([5])` | `NaN` | `5` |

`arr + ""` and `arr.toString()` are already correct, so the ToString
machinery exists; it is bypassed at these entry points.

## Root cause

- `String()` host-lane arm: passes the carrier through unchanged. The
  standalone arm (`src/codegen/builtin-ctor-callable.ts:325-340`) does call
  ToString; the host arm does not. (Exact host line not pinned in the review;
  start at the `String` case of the callable-builtin dispatch.)
- Template literal substitution: same pass-through for a statically typed
  array operand.
- `+`, unary `+`, `Number()`: `src/codegen/addition-to-primitive.ts:3` states
  the §13.15.3 rule; `:26` admits the carrier half is partial (#4564). The
  numeric paths call ToNumber on the carrier's boxed form, which yields NaN
  instead of ToNumber(ToPrimitive(arr)) = ToNumber(arr.join()).

## Correction

One `toPrimitiveCarrier(ctx, valType)` helper that, for any array/object
carrier in a primitive-expecting position (`String()`, template substitution,
`+` with a non-string other side, unary `+`, `Number()`, `-`/`*`/relational
after the ToPrimitive step), emits the existing OrdinaryToPrimitive path
(`Symbol.toPrimitive` → `valueOf` → `toString`, #1319) and only then the
numeric/string conversion. Wire the four entry points above to it; leave the
already-correct `arr + ""` path as the reference behaviour.

## Acceptance

- All rows above match Node on the JS-host lane and on `target: "standalone"`.
- Regression file with the rows plus objects with custom `valueOf` /
  `toString` / `Symbol.toPrimitive` in each position.
- test262 `built-ins/String/S15.5.1.1*`, `language/expressions/addition`,
  `language/expressions/unary-plus` deltas reported in the PR (expect gains).
