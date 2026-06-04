---
id: 1827
title: "BigInt loose-equality loses precision / wrong semantics (== String, == Number)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 60
---
# #1827 — BigInt loose-equality precision / semantics

## Symptom
- `12n == "12px"` → `true` (spec `false` — StringToBigInt rejects trailing garbage).
- `9007199254740993n == 9007199254740992` → `true` (spec `false` — distinct ℝ values).

## Location
`src/codegen/binary-ops.ts:976-1034`. BigInt×String uses `parseFloat` on the
string + `f64.convert_i64_s` on the BigInt; BigInt×Number collapses both to f64
and uses `f64.eq`.

## Spec
ECMAScript §7.2.13 IsLooselyEqual — BigInt×String via StringToBigInt; BigInt×Number
by exact mathematical-value equality.

## Fix
Route BigInt×String through a StringToBigInt-based helper; compare BigInt×Number by
exact value (i64.eq when the Number is integral and in i64 range, else exact/host).

