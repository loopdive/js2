---
id: 4234
title: "Standalone: StringToNumber drifts up to 10 ulp, and `Number`'s §15.7.3 constants are missing from the ctor carrier"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: number-parsing, number-format, property-model, builtin-carriers
goal: es5
related: [2654, 2984, 3006, 4120, 4200, 4223, 1663]
# The pow10 table + its doc block, and the scaling rewrite, belong in the module
# that owns native number parsing — moving them out would separate the table
# from its only consumer. `types.ts` grows by the two `ctx` field declarations
# the table needs (+8), which is where every other cached type/global index in
# codegen is declared.
loc-budget-allow:
  - src/codegen/parse-number-native.ts
  - src/codegen/context/types.ts
---

# #4234 — standalone `Number`: string→double accuracy + ctor own constants

## The headline symptom was misattributed

The bucket signature reads like a **formatter** bug:

```
Expected SameValue(«1.2345677999999998e-87», «1.2345678e-87») to be true
```

It is not. The value on the RIGHT of that message is the compile-time literal
`1234.5678e-90`, rendered by the SAME standalone `number_toString` as
`1.2345678e-87` — so the dtoa is already shortest-round-trip and was never at
fault. The value on the LEFT is `Number("+1234.5678e-90")`. **The parser
produced a different double than the literal.**

Probe on merged HEAD before the fix:

| expression                          | got                      | want            |
| ----------------------------------- | ------------------------ | --------------- |
| `String(1234.5678e-90)` (literal)   | `1.2345678e-87`          | ✅ correct      |
| `String(Number("+1234.5678e-90"))`  | `1.2345677999999998e-87` | `1.2345678e-87` |

Anyone chasing this as a dtoa problem will find a correct dtoa and conclude
nothing is wrong. Read the two sides of a `SameValue` message as *two different
code paths*, not as "actual vs. the string the test wanted".

## Root cause 1 — the decimal scaling step rounded once per power of ten

`emitApplyDecimalExp` (`src/codegen/parse-number-native.ts`) accumulates every
significant digit into an exact i64 mantissa (#2654 did that part right) and
then applies `mant × 10^totalExp`. The scaling switched on `|totalExp| ≤ 22`:

- `≤ 22` → build `10^|totalExp|` (exactly representable) and apply ONE
  `f64.mul`/`f64.div`. Correct.
- `> 22` → **`|totalExp|` successive `×10` / `÷10` operations.** Every one of
  those rounds. `1234.5678e-90` has `totalExp = -94`, so the result was rounded
  94 times.

The reasoning behind the cutover was "an inexact `pow` must be avoided". That is
the wrong trade: one rounding against a `pow` that is itself 0.5 ulp off beats
94 roundings against an exact one.

Measured over 50 000 random `<1–17 digits>e<-300…100>` inputs, comparing against
the correctly-rounded result:

| scaling                               | wrong  | worst error |
| ------------------------------------- | ------ | ----------- |
| per-step `×10`/`÷10` (before)         | 75.3 % | 11.7 ulp    |
| exact-`10^22` chunks (considered)     | 43.4 % | 2.1 ulp     |
| **one op against a `10^k` table**     | 29.0 % | **1.0 ulp** |

Confirmed end-to-end through the real compiler on 400 randomised inputs:
**75.3 % wrong / 10.26 ulp → 25.0 % wrong / 1.00 ulp.**

### Fix

`ensurePow10TableGlobal` registers one immutable `(array f64)` module global
holding `10^0 … 10^308` (`array.new_fixed` is a constant instruction, so the
engine materialises it once at instantiation — same pattern as the Unicode case
tables, #3900). The scaling becomes:

- `|totalExp| ≤ 308` → one table read + one `f64.mul`/`f64.div`. That single
  operation is the ONLY rounding, so the answer is always the nearest double or
  its immediate neighbour.
- `|totalExp| > 308` → apply `10^308`, then step the remainder with the old
  per-step loop. Only this tail can reach subnormals or saturate, and stepping
  is what makes `1e-320` / `5e-324` / `1e400` degrade gracefully instead of
  collapsing to `0`/`Infinity` through an overflowing single power. Verified:
  all of `1e-320`, `1e-323`, `5e-324`, `4.9e-324`, `1e309`, `1e400`, `-1e400`,
  `1e-400` still match the host exactly.

### What this deliberately is NOT

It is **not** a correctly-rounded strtod — 25 % of 17-significant-digit inputs
are still one ulp off. Closing that needs the mantissa carried at ~106 bits
(Eisel–Lemire / double-double): a `(hi, lo)` power table plus Dekker
two-products. On Wasm that is harder than it looks — there is no scalar FMA, so
the two-product needs an explicit split, and the split **overflows** for table
entries near `1e308` (`1e308 × 2^27` is `Infinity`). A working design needs the
table stored pre-split and pre-scaled (`M ∈ [1,2)` plus a two-factor `2^E`, so
neither the split nor the intermediate products leave the normal range). Both
double-double variants were prototyped and measured (≈2 % wrong) before being
set aside — see "Not done" below.

## Root cause 2 — `Number`'s value constants were absent from the ctor carrier

`Number.hasOwnProperty("MAX_VALUE")` was **false**, and the same for
`MIN_VALUE` / `NaN` / `POSITIVE_INFINITY` / `NEGATIVE_INFINITY`.

#2984's `pushBuiltinCtorOwnPropSeed` seeds the standalone ctor carrier with
`length` / `name` / `prototype` and nothing else. The §15.7.3 numeric constants
were never added, so:

- the syntactic read `Number.MAX_VALUE` folds to an `f64.const` and answers
  correctly, but
- every RUNTIME query — `hasOwnProperty`, `getOwnPropertyDescriptor`, `for-in`,
  write, `delete` — saw an absent property.

That split is exactly what test262's `propertyHelper.js` checks:
`verifyNotWritable(Number, "MAX_VALUE", …)` reads
`__getOwnPropertyDescriptor(Number, "MAX_VALUE").writable`, gets `undefined`,
and dies with `TypeError: Cannot convert undefined or null to object` — a
message that names neither `Number` nor `MAX_VALUE` and reads like a harness
bug.

### Fix

`CTOR_NUMERIC_CONSTANTS` in `builtin-ctor-own-props.ts` seeds the eight
constants with flag word `0` = `{ writable:false, enumerable:false,
configurable:false }` (§15.7.3), reading their values from
**`NUMBER_CONSTANT_VALUES`** — the same table that drives the syntactic
`Number.MAX_VALUE` fold and the reflective `Number["MAX_VALUE"]` fold. Sharing
the table is the point: a descriptor whose `value` disagreed with the direct
read would be worse than no descriptor, and `verifyNotWritable` compares
precisely that pair.

## Measured flips (sequential, one file per process, quiet box)

A/B by file swap (`.tmp` copies — never `git stash`, see CLAUDE.md), same
harness, same eval-provider state on both sides.

Baseline 3/47 → **18/47** on `built-ins/Number`: **+15, 0 regressions.**

| root cause                | files                                                                                                                                                                        | n     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| StringToNumber accuracy   | `S9.3.1_A4_T1`, `_A4_T2`, `_A5_T1`, `_A5_T3`                                                                                                                                 | 4     |
| ctor constants — presence | `S15.7.3_A2` … `_A6`                                                                                                                                                          | 5     |
| ctor constants — attrs    | `MAX_VALUE/S15.7.3.2_A2`, `_A3`, `MIN_VALUE/S15.7.3.3_A2`, `_A3`, `NEGATIVE_INFINITY/S15.7.3.5_A2`, `POSITIVE_INFINITY/S15.7.3.6_A2`                                          | 6     |

Regression sweeps over the two directories the change can reach, A/B on the
same box:

| directory                       | before | after  | delta |
| ------------------------------- | ------ | ------ | ----- |
| `built-ins/parseFloat`          | 47/54  | 47/54  | 0     |
| `built-ins/Number/prototype`    | 129/168| 129/168| 0     |

Per-file diff of both sweeps: zero gained, zero lost, zero status changes —
i.e. identical membership, not merely an identical count.

> **Local-harness note.** The six `propertyHelper.js` files need the
> runtime-eval **refusal provider** built (`node --import tsx
> scripts/build-runtime-eval-provider.mjs --refusal-only`). Without it they fail
> on `Import #0 module="js2wasm:runtime-eval"`, which is a *local* infra gap,
> not a compiler result. The 3/47 baseline above was re-measured **with** the
> provider present, so the +15 is not inflated by that gap.

## Not done (deliberate, with the evidence)

### a. Correctly-rounded strtod

25 % of 17-digit inputs remain one ulp off. Design sketched above. No test262
file in the ES5 `Number` bucket depends on it — the four that did are fixed.

### b. `Math`'s constants are still absent from its carrier

`Math.PI` & co. have identical spec attributes (§15.8.1) and would seed through
the same code — `MATH_CONSTANT_VALUES` is right next to the table used here, and
`CTOR_NUMERIC_CONSTANTS` was written keyed by name so adding `Math` is one line.
Left out because `Math` takes the *namespace*-carrier call site (it returns
early from `pushBuiltinCtorOwnPropSeed` for lack of an arity) and its bucket was
outside this slice's measured set.

### c. `Number.prototype` is not yet a Number wrapper — 25 files

Still failing, all one family: `Number.prototype` has no `[[PrimitiveValue]]`
and its methods are not own properties of the `$NativeProto`.

```
Number.prototype == 0                        → false (want true)
Number.prototype.hasOwnProperty("toFixed")   → false (want true)   ×7
(new Number()).toString                      → null                ×6
Object.prototype.toString.call(Number.proto) → not "[object Number]" ×4
Number.prototype.valueOf.call(new String())  → no TypeError        ×7
```

**Watch for a tautology here.** `(new Number()).toString ===
Number.prototype.toString` currently reads `true` — because BOTH sides are
`null`. Any test for this must first assert each side is non-null; see the
paired-cross-check pattern in `tests/es5-standalone-ctor-identity.test.ts`.

This is primitive-wrapper machinery (#4223's lane), not number formatting, so it
is left for whoever owns that.

### d. Two `__module_init` null derefs — root cause found, NOT ToPrimitive

`S9.1_A1_T1` and `S8.12.8_A3` both fail with `dereferencing a null pointer in
__module_init()`. They look like `Number(objectWithValueOf)` / ToPrimitive bugs.
They are not — ToPrimitive is fine in isolation. Reduced repro (needs the
test262 `assert.js` harness in the module; **without it the same source works**):

```ts
var o = { toString: function() { return "1" }, valueOf: function() { return 5; } };
var v = o.valueOf();   // ← dereferences null
```

- `Number(o)`, `+o`, and a *direct* `o.valueOf()` call all deref.
- Reordering the literal so `valueOf` comes **first** makes every one of them
  pass.
- `String(o)` passes either way; `o.toString()` returns the wrong value.
- `valueOf` returning a plain `5` fails just as `{}`/`new Object()` does, so the
  non-primitive fallback is not involved.

So this is **method dispatch on an object literal whose `toString` precedes
another method**, in modules large enough to change the object lowering — struct
field / closure indexing, not the number cluster. Filing the repro rather than
fixing it: it is shared object-literal machinery with a high collision risk
against concurrent wrapper work.

## Files

- `src/codegen/parse-number-native.ts` — `ensurePow10TableGlobal`,
  `emitApplyDecimalExp` scaling rewrite
- `src/codegen/builtin-ctor-own-props.ts` — `CTOR_NUMERIC_CONSTANTS` seed
- `src/codegen/context/types.ts` — `pow10ArrTypeIdx` / `pow10TableGlobalIdx`
- `tests/es5-standalone-number-format.test.ts`
