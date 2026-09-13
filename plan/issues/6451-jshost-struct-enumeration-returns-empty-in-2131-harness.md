---
id: 6451
title: "JS-host `Object.keys`/`values`/`entries`/`for-in` return nothing in the #2131 harness — 6 of 7 rows regressed on main"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`tests/issue-2131.test.ts` passes **1 of 7** on `upstream/main` `3e92241ecc`.
The six JS-host rows do not merely mis-*order* keys — the enumeration comes back
**empty**:

| row | expected | actual on main |
| --- | --- | --- |
| `Object.keys` puts array-index keys first, ascending | `1,2,b,a` | `""` |
| `for-in` visits keys in the same order | `1,2,b,a,` | `""` |
| `Object.values` follows the spec key order | `4,2,1,3` | `""` |
| `Object.entries` follows the spec key order | `12ba` | `NaN` |
| pure string-key objects keep insertion order | `b,a,c` | `""` |
| non-canonical numeric-looking keys are NOT reordered | `b,01,a` | `""` |
| standalone keeps integer-key-first order (#3155) | — | ✓ passes |

Only the **standalone** row survives, which localises this to the **JS-host**
enumeration path, not to `_orderOwnKeysSpec` or the standalone twin.

Measured 2026-09-13 while landing
[#6426](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6426-object-assign-option-bag-across-linked-package):
identical counts with #6426's change applied and with it reverted, so it is
neither caused nor masked by that fix.

[#2131](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2131-jshost-enum-order-ignores-integer-key-ascending)
is `done` and its Resolution records `7/7`, so this is an untracked regression
some later change introduced.

## Why it is not already obvious

Every dogfood suite is green on the same HEAD and several of them (redux's
`finalReducers[key]`, React's dynamically assembled props — see the #4298 note
in `src/runtime.ts`) depend on exactly this round trip. So either

- the regression is specific to how **this test's harness** drives the runtime
  (it calls `buildImports` from `src/runtime.js` directly rather than going
  through `compile`'s own import object), which would make it a stale-harness
  defect rather than a compiler one, **or**
- the dogfood suites never exercise the shape this test uses.

Deciding which of those is true is the first job, because they have opposite
consequences: the first is a test-only fix, the second is a real user-visible
enumeration hole that nothing else in the corpus covers.

## Acceptance criteria

1. Name which of the two explanations above is correct, with a probe that
   distinguishes them (same source compiled through `compile` end-to-end vs
   through the test's `buildImports` harness).
2. If the compiler is at fault: the six rows answer as node does, and a dogfood
   A/B over the 17 suites is reported.
3. If the harness is at fault: the harness is repaired so the rows exercise the
   real import object, and the test is green — a test that cannot fail for the
   right reason is worse than no test.
4. Bisect to the commit that moved it, and record that sha here either way.

## Notes

- `tests/issue-2131.test.ts:88` is the last of the six; `:35`, `:47`, `:57`,
  `:68`, `:78` are the others.
- `Object.entries` answering `NaN` rather than `""` is the sharpest clue: that
  row builds a string by concatenation over the entries, so an empty entry list
  plus a numeric seed produces `NaN`. Consistent with "the list is empty",
  inconsistent with "the list is mis-ordered".
