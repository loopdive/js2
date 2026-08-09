---
id: 3769
title: "standalone JSON.stringify rejects pure boxed and ignored static space values"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: json
goal: standalone
assignee: "ttraenkler/codex-es5-json-space"
parent: 3176
related: [2166, 3176]
---

# #3769 — resolve pure static JSON.stringify space values

## Measured residual

The completed `codex/3176-json-residual` patch is already on `origin/main`
through merged PR #3661, so it must not be republished. A fresh standalone
`built-ins/JSON/**` run on `f5268a605631aa` measures 85 pass / 165 total.

The smallest disjoint cohort is three `JSON.stringify` space tests:

- `stringify/space-number-range.js`;
- `stringify/space-number-float.js`;
- `stringify/space-wrong-type.js`.

All three are compile errors on the measured base.

## Root cause and fix

The existing native JSON codec already implements indentation, clamping, and
truncation. Its compile-time `space` resolver only recognizes primitive number
and string syntax, however, so it treats pure inline Number wrappers and
spec-ignored non-number/string values as unresolved and routes them to the
standalone refusal.

Extend that resolver to:

- unwrap pure inline ambient `new Number(<numeric literal>)` values;
- classify pure Boolean wrappers, `Symbol()`, null/boolean literals, and an
  empty object literal as the spec's ignored compact-gap case;
- retain the refusal for dynamic or effectful expressions.

The runtime codec and host path remain unchanged.

## Validation

- exact three Test262 targets flip from compile error to pass in standalone;
- the complete eight-file `stringify/space-*` cohort moves from 2/8 to 5/8,
  with no other status change;
- the complete 165-file standalone JSON cohort moves from 85/165 to 88/165.
  Excluding the three intended flips, the sorted
  `file/status/error_category/error_signature` fingerprint remains
  `f006b6e0257e1183203d3e7c443c58842addf283684fbc4e3dd9076f72d264b7`
  in both arms;
- focused host coverage passes. The exact host `space-*` cohort remains 7/8;
  its pre-existing `space-wrong-type.js` assertion failure is outside this
  standalone-only route;
- typecheck, lint/format, oracle ratchet, and structural gates pass.
