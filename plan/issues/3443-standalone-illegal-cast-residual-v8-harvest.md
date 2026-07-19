---
id: 3443
title: "standalone: illegal-cast residual (92 gap tests) — general __module_init + __str_to_number/parseInt, no open tracker"
status: ready
created: 2026-07-19
priority: medium
task_type: bug
area: standalone
goal: standalone-mode
model: fable
sprint: current
horizon: s
related: [1781, 2038, 3075]
---

# #3443 — standalone illegal-cast residual (v8 harvest, 2026-07-19)

## Summary

The 2026-07-19 host↔standalone gap harvest surfaced **92 gap tests** with
`error_category: illegal_cast` — standalone modules that compile but trap
`illegal cast` at runtime, where the JS-host lane passes. Genuine
standalone-codegen bugs (a `ref.cast` to the wrong concrete type), not
host-import refusals.

The specific illegal-cast trackers — #2038 (`__iterator_next` / async-dstr) and
#3075 (for-of/for-await dstr iterator) — are `status: done`. No **open** tracker
covers the residual 92, whose dominant sub-signature is a **general
`__module_init` cast**, not the iterator paths those issues fixed.

## Sub-buckets (normalized signature within the 92 gap tests)

| signature | count |
| --- | ---: |
| `illegal cast [in __module_init()]` (general) | 79 |
| `illegal cast [in __str_to_number() ← __module_init]` (string→number coercion) | 8 |
| `illegal cast [in parseInt() / parseFloat() ← __module_init]` | 5 |

## Sample paths

- `test/built-ins/String/prototype/replace/replaceValue-evaluation-order.js` (general)
- `test/language/expressions/does-not-equals/S11.9.2_A7.4.js` (`__str_to_number`)
- `test/built-ins/parseInt/S15.1.2.2_A1_T6.js` (parseInt)

## Root cause (hypothesis)

Standalone codegen narrows an `anyref`/`externref` value to a concrete struct via
`ref.cast` on a path where the dynamic type doesn't match — most visibly in the
string→number coercion helper (`__str_to_number`) and `parseInt`/`parseFloat`,
where a boxed value reaches the numeric fast path without the host lane's
`__box`/`__extern` normalization. Likely the same value-representation mismatch
family as #2160 (standalone string↔number coercion residual).

## Suggested fix

1. Reproduce `does-not-equals/S11.9.2_A7.4.js` in `--target standalone`; capture
   the source type vs cast target in `__str_to_number`.
2. Add the missing type guard / normalization before the `ref.cast` in the
   standalone numeric-coercion path; cross-check #2160.
3. Triage the 79 general `__module_init` casts for a shared representation root.

## Regression note

Specific illegal-cast trackers (#2038/#3075) closed at earlier baselines; this 92
is the current v8-baseline standing surface with no open owner. Filed fresh from
the harvest.

## Implementation Plan (architect, 2026-07-19 — repro confirmed, cast site identified)

### Root cause (confirmed repro + source-verified cast site)

Reproduced `language/expressions/does-not-equals/S11.9.2_A7.4.js` standalone:
`illegal cast [in __str_to_number()]`, with or without the harness prelude. The
test's first statement is `(new Boolean(true) != 1) !== false` — **loose
equality between a primitive-wrapper OBJECT and a number**.

- `__str_to_number`'s body (`emitStrToNumber`,
  `src/codegen/parse-number-native.ts:506-560`) begins
  `any.convert_extern; ref.cast <ctx.anyStrTypeIdx>` — it unconditionally casts
  its externref argument to the `$AnyString` root. Any non-string reaching it
  traps `illegal cast`.
- The caller is the loose String⇄Number arm of the typed `==`/`!=` dispatch
  (`src/codegen/binary-ops-typed-dispatch.ts:876-940`, the `(#2081)` block).
  Its `toNumberOf` classifier does `ref.test <ctx.anyStrTypeIdx>` → string arm,
  else boolean-typeof → 0/1, else `__unbox_number`. A **wrapper object**
  (`new Boolean(true)` / `new Number(-1)` / `new String("-1")`) is not reduced
  via §7.2.15 step 12 (Object ⇄ Number/String → compare with
  `ToPrimitive(object)`) before entering this arm; whichever internal
  representation the wrapper carries then mis-classifies into the string arm
  (or reaches `__str_to_number` via the ToPrimitive residue path — see
  `src/codegen/coercion-engine.ts:309`, which routes `$AnyString`/native-string
  refs to `__str_to_number`).

The dev must pin the exact mis-classification with the WAT of the dispatch arm
(one `emitWat: true` compile of the one-line repro
`(new Boolean(true) != 1)`), but the fix shape does not depend on which of the
two entry paths it is.

### Changes

**File: `src/codegen/binary-ops-typed-dispatch.ts`** (loose-equality dispatch, ~876)
- Before the String⇄Number/boolean arms, add the §7.2.15 step-12 object arm:
  if the operand ref.tests as a wrapper/nominal object struct (the #2358/#2040
  ToPrimitive-capable structs — see `src/codegen/array-to-primitive.ts` /
  `class-to-primitive.ts` and memory `project_2358_toprimitive_nominal_struct_path`),
  reduce it with the existing ToPrimitive(number-hint) helper FIRST, then
  re-enter the primitive classification. Follow the pattern the #2503 boolean
  arm used when it was added for exactly this reduce-then-reclassify shape.

**File: `src/codegen/parse-number-native.ts`, `emitStrToNumber` (~506)** — hardening
- Replace the unconditional `ref.cast $AnyString` prologue with
  `ref.test $AnyString` + else-arm returning NaN (§7.1.4 ToNumber of an
  unparseable non-string carrier never traps). This converts any future
  mis-routed caller from an `illegal cast` trap into a spec-plausible NaN and
  honors the repo rule "`ref.test` before `ref.cast`". Same treatment for the
  `parseInt`/`parseFloat` native entries (5-record sub-bucket) if they share
  the prologue shape.

### Triage step for the 79 general `__module_init` casts
After the two changes above, re-run the 79-sample list (harvest jsonl) — the
`does-not-equals`/`equals` family and the ToPrimitive-adjacent share should
collapse. Bucket whatever remains by trap function name; file follow-ups only
if a non-coercion cluster (>10) survives.

### Edge cases
- `new String("-1") != -1` must compare `ToNumber("-1") == -1` → true arm —
  i.e. ToPrimitive(String wrapper) yields the STRING, which then legitimately
  enters `__str_to_number`; verify the wrapper's [[StringData]] read produces a
  genuine `$AnyString` (flatten handles rope/slice variants).
- Do not touch STRICT equality (`===` stays type-split, no coercion).
- `"1" == 1` fast path must stay byte-identical (the #2081 arm's existing
  tests).

### How to test
- One-liners standalone: `(new Boolean(true) != 1) === false`,
  `(new Number(-1) != -1) === false`, `(new String("-1") != -1) === false` —
  all must hold without trapping.
- Scoped test262 (standalone): `language/expressions/does-not-equals/*`,
  `language/expressions/equals/S11.9.1_A7*`, plus the 8
  `__str_to_number` and 5 `parseInt/parseFloat` sample files from the harvest.
- Cross-check #2160's equivalence tests for no regression.

### Standalone-native vs host-refusal
Standalone-native fix (native coercion path); no new host imports. Host lane
uses its own boxed path and should be unaffected — verify byte-identical gc-lane
output on the repro (coercion-engine gate discipline, memory
`project_1917_coercion_engine_byte_diff_gate`).
