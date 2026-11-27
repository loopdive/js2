---
id: 7498
title: "Keep `++` / `--` counters i32 when a loop bound proves they cannot overflow"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
task_type: performance
area: codegen
goal: core-semantics
related: [7411, 1236, 595]
---

# #7498 — a range proof for `++` / `--` counters outside `for (let …)`

## Problem

#7411 made `collectI32CoercedLocals` (`src/ir/analysis/i32-coerced-locals.ts`) demote every local written by `++` /
`--` to f64, because an i32 slot wraps where JavaScript leaves the int32 range. That is correct, but it has no range
proof. `for (let i = 0; i < n; i++)` stays i32 (it is promoted through `forCounterCandidates` /
`detectI32LoopVar`, which proves the bound). Every other counter now pays for f64.

Measured by the #7411 review (RV7445) at PR head 00361194 against main c3b7be66, all four modes (default and legacy
× gc and standalone):

| shape | main | after #7411 |
| --- | --- | --- |
| `let i = 0; while (i < n) { s = (s ^ i) \| 0; i++; }` | `i` i32 | `i` f64, +123 B (gc, default), +333 B (legacy); adds the `$js_bitwise_*` ToInt32 sequence per iteration |
| `let i = n \| 0; while (i > 0) { …; i--; }` | i32 | f64, +119 B |
| `let j = 0; for (…) { a[j] = a[i]; j++; }` (write index) | i32 | f64 |
| `let i = 0; for (i = 0; i < n; i++) {}` (declared earlier) | i32 | f64 |

`benchmarks/suites/arrays.ts` and `benchmarks/suites/mixed.ts` grow by 13 to 15 B in gc, standalone and legacy
(their `count++` counters).

## Direction

Admit an `incdec` write when a range proof shows the result stays in int32, reusing the proof `detectI32LoopVar`
already makes for `for` loops rather than writing a second one. Examples a proof can cover:

- a `++` counter whose loop exits on `< x.length` or `<` an i32-safe value, incremented once per iteration;
- a `--` counter starting from an i32-safe value whose loop exits on `> 0` / `>= 0`.

Anything unproven stays f64: the wrap #7411 fixed must not come back.

## Acceptance criteria

1. The four shapes above are i32 again where the proof holds; the #7411 pins
   (`tests/issue-7411-i32-local-ushr-incdec-overflow.test.ts`) stay green.
2. A counter that can pass INT32_MAX (no bound, or a bound that is not i32-safe) stays f64.
3. The proof is shared with `detectI32LoopVar`, not duplicated.
