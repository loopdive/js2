---
id: 3917
title: "CRITICAL: the native number formatter truncates non-integers under `fast` — String(3.5) is \"3\", toFixed(2) is \"3.00\"; already wrong on main for standalone+fast and wasi+fast"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-08-01
priority: critical
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
language_feature: number-to-string
goal: performance
sprint: 78
horizon: l
es_edition: multi
related: [3912, 3907]
blocked_by: []
---

# #3917 — native number formatting truncates fractions under `fast`

## Status: DONE — fixed by #3907, confirmed by measurement on 2026-08-01

**It was the same defect as #3907, exactly as "Likely family" below guessed.**
`fast` narrowed every TypeScript `number` to a Wasm i32, so a non-integer lost
its fraction on the way into the formatter. #3907 removed `ctx.fast` from the
unconditional `numericHint` narrowing; nothing in the formatter itself needed
changing.

Re-measured on `main` at `5824539` (post-#3907), every value bound to a
**variable**, each case returning a number:

| case | expected | `standalone+fast` | `wasi+fast` | `fast` |
| --- | --- | --- | --- | --- |
| `String(3.5).length` | 3 | **3 ✓** | **3 ✓** | 3 ✓ (with #3912) |
| `String(0.25).length` | 4 | **4 ✓** | **4 ✓** | 4 ✓ |
| `(3.14159).toFixed(2).length` | 4 | **4 ✓** | **4 ✓** | 4 ✓ |
| `` `v${3.5}`.length `` | 4 | **4 ✓** | **4 ✓** | 4 ✓ |
| `toPrecision(3)` / `toExponential(2)` | — | ✓ | ✓ | ✓ |

(Previously 1, 1, `"3.00"`, `"v3"`.) The `fast` column additionally required
#3912, which is what routes plain `fast` onto the native formatter at all.

**This no longer blocks #3912** — #3912 landed on 2026-08-01 with these cases
passing. The "Why this blocks #3912" section below is kept as the historical
record of why the first attempt was correctly abandoned.

## Original report (historical)

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

## Resolution — fixed by #3907, permanent repro in #3912's suite

Closed as **fixed by #3907**, which removed the `ctx.fast ⇒ i32` narrowing in
`src/checker/type-mapper.ts`. That narrowing made every TypeScript `number` an
i32 under `fast`, so a fraction was truncated before it ever reached the
formatter — which is exactly why trap 2 above holds: the `number_toString` body
was never the defect. Re-measured against current main, not assumed.

**Permanent regression coverage: `tests/issue-3912-fast-number-stringify.test.ts`.**
Its non-integer block is this issue's repro, and it satisfies acceptance
criterion 2 by construction — every case binds to a **variable**, never a
literal, so constant folding cannot mask a recurrence:

| case | source |
| --- | --- |
| `String(3.5)` | `const n = 3.5; return String(n).length;` |
| `` template `v${3.5}` `` | ``const n = 3.5; return `v${n}`.length;`` |
| `parseFloat(String(n))` | `const n = 3.5; return parseFloat(String(n));` |

Each returns a **number** rather than a string, so a wrong representation
cannot be confused with export-boundary marshalling — the same discipline that
made #3912's 52-case differential probe trustworthy.

Acceptance criterion 4 (full test262 over `built-ins/Number` and
`built-ins/JSON`) is owned by CI on #3912's PR, not run locally.

## Provenance

Found by the coordinator while implementing #3912's prescribed fix. The gate
change behaved exactly as #3912 predicted — 4 of the 6 trapping operations
started working — which is what made the remaining two visible as *wrong
answers* rather than traps. Verified pre-existing by restoring pristine sources
via file copy (not `git stash` — see the shared-stash hazard) and re-running the
same probe.
