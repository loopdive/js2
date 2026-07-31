---
id: 3917
title: "CRITICAL: the native number formatter truncates non-integers under `fast` — String(3.5) is \"3\", toFixed(2) is \"3.00\"; already wrong on main for standalone+fast and wasi+fast"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
language_feature: number-to-string
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3912, 3907]
blocked_by: []
---

# #3917 — native number formatting truncates fractions under `fast`

## Status: open — **blocks #3912**

## Problem

Wherever the **native** number formatter is combined with **`fast: true`**,
non-integer numbers lose their fractional part. This is wrong on `main`
**today**, independently of #3912.

Measured on pristine `main` (`String(3.5).length`, expected **3**):

| config | result |
| --- | --- |
| host (`fast: false`) | 3 ✓ |
| `fast: true` | **TRAP** (that is #3912) |
| `target: "standalone"`, no fast | 3 ✓ |
| **`target: "standalone"` + `fast`** | **1 ✗** |
| `target: "wasi"`, no fast | 3 ✓ |
| **`target: "wasi"` + `fast`** | **1 ✗** |

`fast` is the variable, not the target. Both targets are correct without it
and wrong with it.

Further symptoms, `fast: true` vs host, compared character by character:

| expression | expected | fast |
| --- | --- | --- |
| `const n = 3.5; String(n)` | `"3.5"` (len 3) | `"3"` (len 1) |
| `const n = 0.25; String(n)` | `"0.25"` (len 4) | len 1 |
| `const n = 3.14159; n.toFixed(2)` | `"3.14"` | **`"3.00"`** (chars 51,46,48,48) |

Integers are unaffected: `String(100)` is `"100"` in every config.

## Two traps for whoever picks this up

**1. Constant folding masks it.** `String(3.5)` written as a *literal* returns
the correct `"3.5"` — the value is folded at compile time and never reaches the
runtime formatter. Only a **variable** (`const n = 3.5; String(n)`) exposes the
bug. An earlier probe of this issue reported 12/12 formatting cases passing,
including `1e21`, `1e-7` and `0.1+0.2`, purely because every case used a
literal. Always bind to a variable when testing this.

**2. It is not the `number_toString` body.** The emitted `number_toString` is
**byte-identical** between `standalone` and `wasi` (6 lines, one outbound call,
97 functions in both modules), and both are correct without `fast`. The defect
is elsewhere — in what `fast` changes about the call site or the value reaching
it.

## Likely family

This looks like the same class as **#3907**, where `fast` mode narrows a
`number` accumulator to i32 and wraps at 2³¹. Here a value appears to be
narrowed to its integer part on the way into the formatter.

One data point that constrains the hypothesis: `const n = 3.5; n === 3.5`
evaluates **true** under `fast`, and `n * 2 === 7` is also true. So the *local*
is not narrowed — the truncation happens at or inside the stringification path,
not at the binding. Start there rather than at the declaration.

## Why this blocks #3912

#3912's fix is to make `number_toString` native whenever `ctx.nativeStrings`
is set, so that fast mode stops pairing a host formatter with native strings.
That direction is correct and well-evidenced. But applying it alone moves plain
`fast: true` **onto this broken path**: verified locally, the six trapping
operations become four correct and two silently wrong, and
`` `v${3.5}` `` starts evaluating to `"v3"`.

**Trading a loud trap for a silent wrong answer is a regression, not a fix.**
So #3912 must land *with* or *after* this issue, not before it.

## Acceptance criteria

1. `String(n)`, template interpolation, `toFixed`, `toPrecision` and
   `toExponential` produce spec-correct output for non-integers under
   `fast: true`, in all three targets.
2. Regression tests bind values to **variables**, never literals, so constant
   folding cannot mask a recurrence.
3. The root cause is stated as a traced fact, and checked against #3907 — if
   they share a mechanism, say so and fix once.
4. Full test262 run over `built-ins/Number` and `built-ins/JSON`.

## Provenance

Found by the coordinator while implementing #3912's prescribed fix. The gate
change behaved exactly as #3912 predicted — 4 of the 6 trapping operations
started working — which is what made the remaining two visible as *wrong
answers* rather than traps. Verified pre-existing by restoring pristine sources
via file copy (not `git stash` — see the shared-stash hazard) and re-running the
same probe.
