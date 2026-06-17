---
id: 2105
title: "value-rep P2: boolean brand rollout — ~20 producer + ~12 consumer sites onto {kind:'i32', boolean:true}"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/d2
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2016, 2030, 2005]
origin: "2026-06-11 analysis program (report 02 phase P2); stub 08-E20"
---

# #2105 — the brand exists with one producer

## Problem

Bare-i32 booleans stringify as "1"/"0" wherever the TS-checker consult
can't see the boolean-ness (any receivers, synthesized results): #2016
hasOwnProperty, #2030 IteratorResult.done, #2005 residue — fixed
point-wise, but every new boolean-producing site re-breaks.

## Root cause

The ValType brand `{kind:"i32", boolean:true}` exists (#1788) with ~1
producer and 4 consumers; ≈20 producer sites (predicates, comparisons,
host-import results) and ≈12 consumer sites (stringify, concat, template,
join) never see it.

## Fix direction

Per the value-rep spec P2: brand all boolean producers; consumers branch
on the brand instead of per-site checker consults; fragile checker
lookups deleted.

## Acceptance criteria

- The #2016/#2030/#2005 test families pass from the brand alone (remove
  their point checks to prove it); truthiness contexts unchanged

## Dupe check

Point fixes merged; the rollout phase is unfiled. New (analysis program).

## Resolution (2026-06-16, d2)

A producer/consumer audit against current main (after the value-rep P1
landings #1503 / #2104) showed the brand rollout has largely happened: of
10 representative boolean-producer → string-consumer probes (comparison via
`any`, equality concat, `!x`, template literals, predicate-fn results,
`Number.isInteger`, `Array.includes`, `typeof`, `startsWith`, …) **9 already
render "true"/"false" correctly**. The one residual consumer gap was
**`Array.prototype.join` / `Array.prototype.toString`**: a boolean array
lowers to an i32 WasmGC element array, and the `{kind:"i32", boolean:true}`
brand is structural-only — it does **not** survive into `arrDef.element`
(arrays dedupe structurally). So the join element-stringify path rendered
booleans numerically ("1"/"0").

**Fix** (`src/codegen/array-methods.ts`): recover boolean-ness from the
receiver's TS element type via a new `arrayElementIsBoolean(ctx, receiverExpr)`
helper (`recvType.getNumberIndexType()` → `isBooleanType`). Both join paths
honour it:
- JS-host `compileArrayJoin` — select the "true"/"false" string-constant
  global from the i32 element (externref form).
- native-strings `compileArrayJoinNative` (standalone / WASI) — build the
  native "true"/"false" string and `ref.cast` up to `$AnyString`.

`toString` delegates to join (#1997), so it inherits the fix.

## Test Results

`tests/issue-2105.test.ts` — 8/8 pass (JS-host + standalone). Related
families re-run green: #2016 + #2005 (17), join families #1997/#1998/#2074
(37). tsc + biome lint clean.

- boolean[] join → "true,false,true" (was "1,0,1")  ✓ JS-host + standalone
- comparison-result booleans `[1<2, 2<1].join(",")` → "true,false"  ✓
- default-separator join, Array.toString delegation  ✓
- number[] / string[] join unchanged (no regression)  ✓
