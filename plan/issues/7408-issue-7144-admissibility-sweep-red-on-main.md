---
id: 7408
title: "tests/issue-7144-operand-admissibility.test.ts has 4 tests red on main since 2026-11-06/07"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir, tests
goal: ir-full-coverage
related: [7144, 7133, 7282, 7358, 7375]
loc-budget-allow:
  # 2026-11-26 (#7408): select.ts +11. The #7282 refusal site needs the
  # selector's own local tracing (`unannotatedLocal`, `dynamicShapedValue`),
  # which lives only in select.ts; one predicate and its call.
  - src/ir/select.ts
---

# #7408 — the #7144 selector⇔from-ast sweep is red on main

## Problem

`tests/issue-7144-operand-admissibility.test.ts` checks, per lane (standalone, wasi, gc), that the selector's claim
agrees with the shared admissibility predicate and that a claimed body runs with node's answer. Four of its twelve
tests fail on `origin/main` (`89e47482`, 2026-11-19), all on the `standalone` lane. Nothing reported it: like
#7358, a red file on main that no required gate runs.

| test | first failing row |
| --- | --- |
| `#7144 — binary operands: selector ⇔ from-ast > '-' over every pair of operand families` | `var t = n - true; throw m;`: claimed `false`, predicate `true` |
| `… > '\|' over every pair of operand families` | `var t = n \| true; throw m;`: claimed `false`, predicate `true` |
| `… > '<' over every pair of operand families` | `var t = n < true; throw m;`: claimed `false`, predicate `true` |
| `#7144 — writes, increments, … > plain writes into each slot family (and a chained write through a second slot)` | `var u; n = u = 4; throw m;`: claimed `true`, predicate `false` |

The first three: a number beside a boolean, which the shared predicate admits (`booleanReadAsNumber`, #7282) but
the selector no longer claims in this harness (a planned closure body, `subject.f = function (m, k) { … }`). The
fourth: a chained write through a dynamic `var u` into a number slot is now claimed although
`slotWriteVerdict("number", "dynamic")` says it is not admissible.

## Measured: which merge broke them

Bisected on main's first-parent history (2026-11-19), running only this file at each commit (an export of the
commit with this checkout's `node_modules`):

| commit | date | result |
| --- | --- | --- |
| `a67f11711` | 2026-11-06 19:41 | 12/12 pass |
| `a7e456cc3` Merge PR #7133 (`codex/es5-assignment-expression`) | 2026-11-06 19:59 | **plain writes** fails (`var u; n = u = 4;`) |
| `d5f435388` | 2026-11-07 08:20 | 1 failed |
| `c776d9ad6` Merge PR #7150 (`issue-7282-ir-module-init-small-families`) | 2026-11-07 08:20 | **`-`, `\|`, `<`** fail as well (4 failed) |
| `cac54076`, `ba09c845` (2026-11-16), `89e47482` (2026-11-19) | | the same 4 failed |

So: #7133 (an ES5 assignment-expression change) made the selector claim the chained write; #7282's PR #7150 taught
the predicate that a boolean beside a number is read with ToNumber, without the planned-closure selector path
following (or without updating this sweep's expectation).

## To decide

Per row, which side is right: the selector (claim and run) or the predicate/expectation. Both directions are
checked by the sweep's own runtime comparison against node, so the fix is whichever makes claim, predicate and
node agree. Out of scope for #7375, which leaves these four exactly as on main.

## Resolution (2026-11-26)

Decided per row by the sweep's own comparison against node, plus probes with the #7282 refusal switched off.

| row | right side | change |
| --- | --- | --- |
| `n - true`, `n \| true`, `n < true` | node and from-ast | selector |
| `var u; n = u = 4` | the selector | expectation |
| (unmasked) `true - m`, `true \| m`, `true < m`, `m` a dynamic param | the selector | expectation |

- **Rows 1–3.** `binaryOperandFamily` gives the unannotated closure local `n` the family `unknown`, because it
  leaves initializer tracing to its caller. #7282's `booleanReadBesideCarrier` counts `unknown` as a possible carrier
  (meant for an `any` module binding), so it refused. With the refusal off, a boolean beside a number or string
  local is claimed and matches node on every lane, with no post-claim error. The selector now skips the refusal when
  an operand is an unannotated local whose slot is not the carrier (`readsNonCarrierLocal` on the operand beside the boolean: not a dynamic-shaped local, `dynamicShapedValue`).
  Carrier locals (`var x;`, `var x = m`) and carrier params stay refused, as #7282 intends.
- **Row 4.** Since #7133 an assignment's value is its right-hand side, so `n = u = 4` writes a number into `n`,
  whatever `u` held. The expectation now asks `slotWriteVerdict("number", "number")`.
- **Unmasked rows.** Once rows 1–3 passed, the sweep reached `true - m`. The harness is an ES module, so its closure
  is a prepared component and #7282 refuses a boolean beside the carrier there. The expectation now carries
  `!booleanReadBesideCarrier` (whether lifting that refusal inside closures is safe is unproven; not done here).
- `tests/issue-7282-boolean-numeric-operands.test.ts` stays 39/39. Its 6 module rows fail with the refusal fully
  off, which is why only the local case is narrowed.
- (RV7442) Follow-up, not done here: `binaryOperandFamily` could trace an unannotated local's initializer family once,
  as `provenIrFamily`'s doc says the caller does. `booleanReadBesideCarrier` would then never see `unknown` for such a
  local, and this exemption would go. Locals whose slot is the carrier but that `dynamicShapedValue` does not
  recognise (`var n = (0, m)`, `var n = x = m`, `var n = m.x`) are claimed now; RV7442's probe found them giving
  node's answer.
