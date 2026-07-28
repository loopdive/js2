---
id: 3770
title: "Standalone RegExp flag getters lose the boolean value brand"
status: in-review
assignee: ttraenkler/codex-es5-regexp-boolean-getters
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: easy
task_type: bugfix
area: standalone, regexp, test262
language_feature: regexp
goal: es5-conformance
related: [1914, 2016, 2030, 2175, 3424]
---

# #3770 — standalone RegExp flag getters lose the boolean value brand

## Problem

The standalone RegExp reflection path lowers flag getters to an `i32`
predicate, but reports that value as an unbranded numeric `i32`. Most flag
properties are declared as booleans by the TypeScript library, which can mask
the lost runtime brand at a later boxing boundary. `RegExp.prototype.unicodeSets`
is not declared in the configured library, so `/./.unicodeSets` crosses the
Test262 assertion boundary as the number `0` instead of the boolean `false`.

## Implementation

Mark the result of the shared RegExp flag-getter lowering as a boolean-valued
`i32`. This preserves `false` and `true` when the value is boxed for an untyped
call, without changing the flag bitfield calculation, RegExp descriptors,
getter brand checks, cross-realm behavior, or UnicodeSets matching semantics.

## Verification

- Same-SHA six-file RegExp `this-val-regexp.js` getter cohort:
  - host stays 6/6;
  - standalone improves 5/6 to 6/6;
  - the only status change is
    `prototype/unicodeSets/this-val-regexp.js` from fail to pass (+1/-0).
- The isolated-process eight-file UnicodeSets getter-metadata cohort keeps host
  at 4/8 and improves standalone from 5/8 to 6/8. The descriptor and cross-realm
  failures retain their exact baseline signatures, confirming that those
  separate roots are unchanged.
- The focused #3770 tests pass 2/2, including both Boolean values crossing an
  untyped call boundary and the maintained Test262 case.
- Related RegExp reflection tests pass 19/19 (#1914 and #2876). The #3192 suite
  remains 5/6 on both revisions because its pre-existing DataView case fails in
  IR class discovery before reaching RegExp lowering.
- Typecheck, Prettier, scoped Biome lint, oracle, LOC/function budgets, IR
  fallback/IR-only/adoption, codegen fallback, and issue-integrity gates pass.
