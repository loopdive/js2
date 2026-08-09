---
id: 3763
title: "String.prototype.indexOf host path conflates an undefined search argument with null"
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
language_feature: string-methods
goal: test262-conformance
assignee: "ttraenkler/codex-es5-string-indexof"
related: [205, 2598, 2599]
# loc-budget-allow justification: the two-line call-receiver dispatch hook is
# irreducible wiring; all proof and emission logic lives in the dedicated
# string-indexof-undefined subsystem module.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
# func-budget-allow justification: compileReceiverMethodCall gains only the
# one-line indexOf-specific delegation; the proof/emission body is extracted.
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #3763 — preserve undefined for `String.prototype.indexOf`

## Root cause

The classic JS-host string-method lowering compiled `indexOf`'s search
argument directly into the import's `externref` slot. The Wasm representation
of an uninitialised `var` collapsed to `ref.null.extern`, so the host received
JavaScript `null`.
`String.prototype.indexOf` consequently searched for `"null"` instead of
applying `ToString(undefined)` and searching for `"undefined"`.

The bounded fix proves the first read of an uninitialised hoisted `var` before
its declaration. It evaluates the expression once, discards the representation
placeholder, and passes the host's existing `__get_undefined` value. A preceding
use makes the proof decline to the existing dynamic path.

This is scoped only to `String.prototype.indexOf` in the classic host lane.
Standalone already preserves these search values through its native ToString
coercion cascade. Other string methods and RegExp lowering are unchanged.

## Measured conformance

On the explicit ES5 `built-ins/String/prototype/indexOf` cohort (34 files):

- host: 29 pass / 5 fail before → 30 pass / 4 fail after; the exact
  `S15.5.4.7_A1_T6.js` hoisted-var case is the sole flip;
- standalone: 26 pass / 8 fail before and after.

Across the full 47-file `indexOf` directory, host moves from 34 pass / 13 fail
to 35 pass / 12 fail; standalone remains 30 pass / 17 fail. After excluding
the sole target flip, the status/error signature hashes are identical in both
cohorts and lanes (zero regressions and zero fail-to-fail drift).

`S15.5.4.7_A1_T8.js` and `S15.5.4.7_A1_T9.js` remain failures because their
receiver-side `String(object)` / String-wrapper coercion is independently
wrong. They are not counted as search-argument wins.

## Validation

- direct host regressions for a hoisted `var` and a preceding-write non-fold
  guard;
- exact Test262 `S15.5.4.7_A1_T6.js` regression;
- same-SHA local host/standalone A/B over the explicit ES5 cohort and full
  `indexOf` directory, including fail-to-fail signature comparison.
