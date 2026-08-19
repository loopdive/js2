---
id: 4564
title: "STANDALONE: `__any_lt/gt/le/ge` implement only the numeric branch of §7.2.12 — no ToPrimitive, no string comparison (and the #2059 recovery path is dead code there)"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime, codegen
es_edition: 5
language_feature: relational-operators
goal: es5
related: [4515, 2059, 1374, 4163]
origin: "2026-08-19 ES5 standalone push, language/expressions lane. Root-caused to the bottom and deliberately NOT landed at the end of a long session; this file is the implementable spec."
---

# #4564 — the AnyValue relational helpers are numeric-only

## Symptom

```js
var f = function () { return 1; }, o = {};
f >= f       // false — must be true
o <= o       // false — must be true
({} + f)     // NaN   — must be the two toString()s concatenated
```

Half the matrix looks correct **by luck** (`o >= f` and `f < o` genuinely *are*
false), so spot-checking the wrong pairs finds nothing. `x >= y` is also not
`!(x < y)`, which is the quickest tell.

## Root cause — two layers, and the first one is dead code

### 1. The #2059 recovery path never runs in standalone

The gate at `binary-ops.ts:1667` is wrapped in:

```ts
if (isRelational && ctx.anyValueTypeIdx < 0) { … emitAnyRelational … }
```

In standalone `anyValueTypeIdx` is **45** — the AnyValue regime is always on — so
`emitAnyRelational` is **never reached at all**. Both the object case *and* the
`any`-operand string case (which is #2059's own fix) are inert there.

Measured: widening that gate to admit object operands **changes nothing**,
because nothing downstream of it runs. A partial widening was written and
**reverted rather than left in place** — inert under `anyValueTypeIdx >= 0`, it
would read as a fix that does nothing and mislead the next reader.

### 2. The real implementation is four helpers that only do numbers

`src/codegen/any-eq-helpers.ts:566` — the comment admits the gap:

```
// Comparison helpers: __any_lt, __any_gt, __any_le, __any_ge
// All use numeric comparison (convert to f64, compare)
```

The body is `toF64(a) ; toF64(b) ; f64.lt`. That is only the numeric branch of
§7.2.12 (Abstract Relational Comparison): no ToPrimitive, no string∧string
lexicographic arm, no NaN/incomparable rule. An object operand becomes NaN, so
all four operators answer `false`.

## There is no cheap subset — checked

Inserting `__to_primitive` before `toF64` **alone does not fix it**: `f >= f`
reduces to two identical *strings*, and ToNumber of `"function () {…}"` is still
NaN. The string branch is required, which means reaching `__typeof_string` /
`__str_compare` from inside these natives — none of which `any-eq-helpers.ts`
currently imports.

## The work

Give `__any_lt` / `__any_gt` / `__any_le` / `__any_ge` the whole of §7.2.12:

1. ToPrimitive(hint **number**) on both operands — observable, so `Date` must run
   its `valueOf`/`toString` in spec order.
2. If **both** results are strings → `__str_compare` (lexicographic), not
   numeric.
3. Otherwise ToNumber → f64, with the NaN/incomparable rule so that
   `x >= y` is `!(x < y)` except where a NaN operand makes both false.

These are the ABI-owning helpers for **every** `any` comparison in standalone, so
this is exactly the shared-coercion class that needs a cross-lane verification
loop (see below).

## The #1374 landmine does NOT apply to this route

The comment at `binary-ops.ts:1650` records that #1374 tried widening this gate
to non-numeric operands and caused **14 `runtime_error` regressions**. That
regression came from routing object relationals to the **host** comparator, and
host `<` throws on an opaque WasmGC struct.

These helpers are **entirely in-module** — no host operator ever sees a struct —
so the mechanism does not transfer. Whoever picks this up should not be scared
off by that comment; it is a warning about a different route.

## Verification required

Shared coercion machinery, so the full battery, not the lane list alone:

- 551-row standalone guard.
- The 121-module prototype-write corpus, **one process per test via a `while
  read` loop** (budget ~15 minutes; `t262run.mjs <list> 1` puts all 121 in one
  process and pollutes itself). Establish its `main` baseline the same way — it
  is not 121/121 locally.
- vitest **relative to the merge base**, including GC-lane suites: a sibling
  lane's regression this session was a js-host defect in lane-shared code that a
  standalone-only loop could not see.

## Rows

~10 in the `language/expressions/**` lane:
`{greater-than,greater-than-or-equal,less-than,less-than-or-equal}/S11.8.*_A3.2_T1.2`,
`relational/S9.1_A1_T4`,
`addition/S11.6.1_{A2.2_T2,A2.2_T3,A3.2_T1.2}`,
`concatenation/S9.8_A5_T2`, `equals/S9.1_A1_T3`, `equals/S11.9.1_A7.9`,
`does-not-equals/S11.9.2_A7.8`.

The coercion family pays off well beyond those rows.
