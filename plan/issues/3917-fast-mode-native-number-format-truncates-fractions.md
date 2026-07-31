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
blocked_by: [3907]
---

# #3917 — native number formatting truncates fractions under `fast`

## Status: ROOT-CAUSED — same defect as #3907, one line in `src/checker/type-mapper.ts`

**The title of this issue is wrong: nothing in the formatter truncates
anything.** Read **"Traced root cause"** below before anything else in this
file. The Problem table is accurate as a set of *observations*; every
*explanation* above that section — including the "Likely family" hedge and the
constraint that "the local is not narrowed" — is superseded.

**This issue does not block #3912, and the two should not be sequenced.** The
blocking claim assumed the truncation lived in the stringification path, so that
#3912's gate change would *route* `fast` onto a broken formatter. It does not:
`fast` was already truncating every non-integer in every carrier — `const n =
3.5; return n;` was already `3` on `main`, with no formatter involved. #3912 is
implemented on branch `issue-3917-fast-native-number-format` and takes `fast`
from 3 of 9 operations to 8 of 9 (measured with integer values, which this
defect cannot touch); it neither creates nor widens any wrong answer. The
non-integer cases (`toFixed` → `"3.00"`, `` `v${3.5}` `` → `"v3"`) are this
issue, i.e. #3907, and no change anywhere in the number→string chain can fix
them.

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

## Traced root cause — `src/checker/type-mapper.ts:47-49`

```ts
if (type.flags & ts.TypeFlags.Number || type.flags & ts.TypeFlags.NumberLiteral) {
  return { kind: fast ? "i32" : "f64" };
}
```

Under `fast`, **every** TypeScript `number` — and every `NumberLiteral` — is
lowered to a Wasm **i32**. `resolveWasmType` (`src/codegen/index.ts`) falls
through to this for the `number` case, so it is the single decision point for
locals, parameters, returns, array elements and object fields alike.

Read straight off the emitted WAT for `const n = 3.5; return String(n).length;`,
diffed `standalone` vs `standalone+fast` — the ENTIRE diff is 5 lines:

```wat
- (func $test (result f64)      + (func $test (result i32)
- (local $n f64)                + (local $n i32)
                                + i32.trunc_sat_f64_s     ;; on the store to $n
                                + f64.convert_i32_s       ;; on the read of $n
- f64.convert_i32_s             (the old widening of .length)
```

So `n` holds the integer 3 before any formatter is reached. `number_toString` is
byte-identical in both modules and is doing exactly the right thing with the
value it is given.

### The "the local is not narrowed" datum was a constant-folding artifact

The issue previously recorded that `const n = 3.5; n === 3.5` is **true** under
`fast`, and concluded the local was intact. It is true — and it proves nothing,
because that comparison is folded at compile time. The identical program that
merely *reads* the local, `const n = 3.5; return n;`, returns **3**. This is the
same literal-vs-variable trap the issue itself warns about, one level deeper:
folding hides the runtime representation from a *comparison* just as it hides it
from `String()`.

### It is not confined to locals, and not confined to formatting

Measured under `fast` (each case bound to a variable, each returning a number):

| expression | host | fast |
| --- | --- | --- |
| `const n = 3.5; n` | 3.5 | **3** |
| `let n = 3.5; n` | 3.5 | **3** |
| `id(3.5)` (param `x: number`) | 3.5 | **3** |
| `half()` (returns `number`) | 3.5 | **3** |
| `[3.5][0]` | 3.5 | **3** |
| `({v: 3.5}).v` | 3.5 | **3** |
| `const a=1, b=2; a / b` | 0.5 | **0** |

Every carrier truncates. `a / b` is instructive: `binary-ops.ts` already
computes division in f64, and the i32 **return type** truncates the result on
the way out.

### Same mechanism as #3907 — one fix, not two

#3907 (accumulator wraps past 2³¹) and this issue (fractions lost) are the same
line producing two different loss modes: i32 cannot hold a value larger than
2³¹−1, and it cannot hold a fraction. Fixing #3907 fixes this. There is nothing
separate to do here.

Corroborating the direction from inside the codebase: the #3673 header in
`src/codegen/native-type-annotations.ts` documents i32 storage as an
**opt-in-per-binding** escape hatch (`type i32 = number`) whose truncating and
saturating behaviour is the price the author accepts — and explicitly flags fast
mode as the anomaly, "where *every* `number` becomes `i32` regardless of
annotation".

### Measured blast radius of the one-line fix

Trialled `return { kind: "f64" }` and A/B-ran 21 fast-relevant test files on the
same checkout. Baseline 15 failures, with the change 21: **8 new, 2 fixed**.
Handed to #3907 in full; the load-bearing parts:

- 2 fixed: `tests/issue-1817.test.ts` fast-mode `>>>` cases.
- 2 new are the **test** being wrong: `gradual-typing › any negation` asserts
  `expect(negAny(0)).toBe(0)`, but `-(0)` is `-0` per spec and `toBe` is
  `Object.is`. The assertion had encoded the i32 behaviour.
- 3 new in `tests/issue-1825.test.ts` are i32-modulo trap guards that exist only
  because fast mode used `i32.rem_s`; likely moot rather than broken.
- 3 new in `tests/issue-2682.test.ts` need a real **decision**, not a test edit:
  that is a genuine charCodeAt read-loop optimisation keyed on numbers being
  i32. Re-key it on the explicit `i32` annotation, or accept the shape change.

## Superseded: why this was thought to block #3912

#3912's fix is to make `number_toString` native whenever `ctx.nativeStrings`
is set, so that fast mode stops pairing a host formatter with native strings.
That direction is correct and well-evidenced. But applying it alone moves plain
`fast: true` **onto this broken path**: verified locally, the six trapping
operations become four correct and two silently wrong, and
`` `v${3.5}` `` starts evaluating to `"v3"`.

**Trading a loud trap for a silent wrong answer is a regression, not a fix.**
So #3912 must land *with* or *after* this issue, not before it.

**Why that reasoning does not hold.** The premise was that #3912's gate change
*moves* `fast` onto a broken path. It does not — `fast` was already on that
path for every non-integer value, in every operation, formatter or not
(`const n = 3.5; return n;` was already `3` on `main`). The gate change converts
traps into the *same* wrong answers `fast` already gave everywhere else; it
neither creates nor widens the wrongness. Measured on the #3912 branch, `fast`
and `standalone+fast` now agree cell-for-cell, which is exactly what #3912
predicted and is the correct intermediate state. The remaining wrongness is one
line in `type-mapper.ts` and is #3907's to remove.

## Acceptance criteria

**These are now #3907's, not this issue's** — see "Traced root cause". Kept
because they name the right verification, and it should be done as part of
#3907:

1. `String(n)`, template interpolation, `toFixed`, `toPrecision` and
   `toExponential` produce spec-correct output for non-integers under
   `fast: true`, in all three targets.
2. Regression tests bind values to **variables**, never literals, so constant
   folding cannot mask a recurrence.
3. The root cause is stated as a traced fact, and checked against #3907 — if
   they share a mechanism, say so and fix once.
   **Done: they share `src/checker/type-mapper.ts:47-49`. Fix once, in #3907.**
4. Full test262 run over `built-ins/Number` and `built-ins/JSON`.

The re-verification #3912 owes, once #3907 lands, is narrow: re-run the
9-operation table with **non-integer** values bound to variables, in `fast`,
`standalone` and `standalone+fast`, and fold the non-integer cases into
`tests/issue-3912-fast-number-stringify.test.ts` (which today is
integers-only, and says so in its header).

## Provenance

Found by the coordinator while implementing #3912's prescribed fix. The gate
change behaved exactly as #3912 predicted — 4 of the 6 trapping operations
started working — which is what made the remaining two visible as *wrong
answers* rather than traps. Verified pre-existing by restoring pristine sources
via file copy (not `git stash` — see the shared-stash hazard) and re-running the
same probe.
