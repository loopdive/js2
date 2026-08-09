---
id: 3773
title: "Standalone String lowercasing omits Unicode Final_Sigma context"
status: done
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, strings
es_edition: 5
language_feature: string-prototype-lowercase
goal: es5
sprint: 77
assignee: ttraenkler/codex-es5-string-final-sigma
related: [40, 1604, 2191]
func-budget-allow:
  - src/codegen/case-convert-native.ts::emitNativeCaseConversion
  - src/codegen/case-convert-native.ts::makeStr
---

# #3773 — standalone Unicode `Final_Sigma` lowercasing

## Problem

The pure-Wasm Unicode lowercase helper implements simple mappings and
unconditional `SpecialCasing.txt` expansions, but not the file's
locale-insensitive conditional `Final_Sigma` rule. Consequently both
`String.prototype.toLowerCase` and `toLocaleLowerCase` produce `aσ` for `AΣ`
instead of `aς` in standalone mode.

The rule is context-sensitive: U+03A3 maps to U+03C2 only when preceded by a
`Cased` code point, ignoring `Case_Ignorable` code points, and not followed by
another `Cased` code point through the same ignorable set. Context scanning
must operate on Unicode code points so astral cased characters also count.

## Implementation

- Generate compact inclusive range tables for the Unicode `Cased` and
  `Case_Ignorable` binary properties from the same Node Unicode data source as
  the existing case-mapping tables.
- Add one shared binary-search range predicate to the native case converter.
- Apply the `Final_Sigma` context scan only to the lowercase helper; retain the
  existing simple and unconditional special mappings for all other code
  points.

## Acceptance criteria

- The authoritative ES5 conditional-special-casing tests pass in standalone
  `toLowerCase` and `toLocaleLowerCase`.
- Host results remain unchanged.
- Cased, case-ignorable, astral-cased, and following-cased contexts match the
  Unicode default case algorithm.
- The complete 46-test ES5 lowercasing family has no pass-to-fail transition or
  non-target failure-signature drift in either lane.

## Measured result

Authoritative original-harness local-vs-local A/B at
`origin/main@3f64e77e56caf7fed7d6065e623d0c7f22a1ee46`, covering every `es5id`
test in both lowercasing directories:

- Host: **38/46 → 38/46**.
- Standalone: **16/46 → 18/46**.
- Exact fail-to-pass transitions:
  - `String/prototype/toLowerCase/special_casing_conditional.js`
  - `String/prototype/toLocaleLowerCase/special_casing_conditional.js`
- Zero regressions and zero non-target failure-signature changes.

## Validation

- The focused standalone and WASI context matrix passes, including lone,
  final, medial, case-ignorable, following-cased, astral-preceding, and locale
  forms.
- The adjacent Unicode/native string suite passes **125/125**.
- Typecheck, lint, Prettier, issue gates, LOC/function budgets, godfile,
  pushRaw, and coercion-site gates pass.
